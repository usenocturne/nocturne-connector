import Foundation
import os
import Combine
#if canImport(IOBluetooth)
import IOBluetooth
#endif

#if canImport(IOBluetooth)

@MainActor
final class BluetoothService: ObservableObject {
    private let log = Log.make(for: "BluetoothService")

    @Published private(set) var status: BTAdapterStatus = BTAdapterStatus(powered: false)
    @Published private(set) var devices: [BTDeviceInfo] = []
    @Published private(set) var connections: [BTConnection] = []
    @Published var lastError: String? = nil

    @Published private(set) var peerConnectability: [String: PeerConnectability] = [:]
    enum PeerConnectability: Equatable {
        case unknown
        case connecting
        case connected
        case rejecting(since: Date)
    }

    weak var rpcManager: RPCManager?

    private var bridge: BluetoothDelegateBridge!
    private var activeChannels: [String: IOBluetoothRFCOMMChannel] = [:]
    private func channelKey(address: String, id: BluetoothRFCOMMChannelID) -> String {
        "\(address)#\(id)"
    }
    private let probeListener = SerialProbeListener()
    private var recentProbePeer: (address: String, seenAt: Date)?
    private var pendingProbeResponses: [String: Task<Void, Never>] = [:]
    private var pendingAnonymousProbeResponse: Task<Void, Never>?
    private var aclFallbackTasks: [String: Task<Void, Never>] = [:]
    private var aclFallbackExhausted = Set<String>()

    var serverChannel: BluetoothRFCOMMChannelID { probeListener.registeredChannel }

    var serverError: String? { probeListener.lastError }

    func republishSPPService() {
        startSPPServer()
        objectWillChange.send()
    }

    func retryPendingCarThingLinks() {
        refreshAdapterStatus()
        aclFallbackExhausted.removeAll()
        loadPairedDevices()
    }

    private var connectNotification: IOBluetoothUserNotification?

    init() {
        bridge = BluetoothDelegateBridge(service: self)
        refreshAdapterStatus()
        loadPairedDevices()
        DispatchQueue.main.async { [weak self] in
            self?.startBluetoothNotifications()
        }

        Task { @MainActor [weak self] in
            while true {
                try? await Task.sleep(nanoseconds: 3_000_000_000)
                guard let self else { return }
                self.refreshAdapterStatus()
                self.loadPairedDevices()
            }
        }
    }

    private func startBluetoothNotifications() {
        startSPPServer()

        guard connectNotification == nil else { return }
        connectNotification = IOBluetoothDevice.register(
            forConnectNotifications: bridge,
            selector: #selector(BluetoothDelegateBridge.deviceACLConnected(_:device:))
        )
    }

    fileprivate func handleACLConnect(device: IOBluetoothDevice) {
        let address = device.addressString ?? ""
        guard Self.looksLikeCarThing(name: device.name ?? "") else { return }
        ingest(device: device)
        recentProbePeer = (address, Date())
        log.info("Car Thing ACL-connected (\(address, privacy: .public)); waiting for RFCOMM probe")
        aclFallbackExhausted.remove(address)
        scheduleACLFallbackIfNeeded(for: device, reason: "ACL connect")
    }

    private func startSPPServer() {
        probeListener.onProbe = { [weak self] in
            self?.handleSerialProbe()
        }
        probeListener.start()
        if lastError?.contains("SPP") == true || lastError?.contains("Bluetooth is off") == true {
            lastError = nil
        }
    }

    private func handleSerialProbe() {
        loadPairedDevices()
        guard let address = probeAddressCandidate() else {
            log.info("Bluetooth-Incoming-Port probe arrived before a paired Car Thing address was visible")
            waitForProbeAddressThenRespond()
            return
        }
        log.info("Responding to Bluetooth-Incoming-Port probe from \(address, privacy: .public)")
        respondToProbe(from: address)
    }

    private func probeAddressCandidate() -> String? {
        if let peer = recentProbePeer, Date().timeIntervalSince(peer.seenAt) <= 30 {
            return peer.address
        }
        return carThingDevices.first?.address
    }

    func refreshAdapterStatus() {
        let powered = IOBluetoothHostController.default()?.powerState == kBluetoothHCIPowerStateON
        if status.powered != powered {
            status.powered = powered
        }
    }

    static func looksLikeCarThing(name: String) -> Bool {
        isCarThingName(name)
    }

    nonisolated static func isCarThingName(_ name: String) -> Bool {
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.range(
            of: #"^Nocturne( \(.+\))?$"#,
            options: [.regularExpression, .caseInsensitive]
        ) != nil {
            return true
        }
        let lower = trimmed.lowercased()
        return lower.contains("car thing") || lower.contains("carthing")
    }

    var carThingDevices: [BTDeviceInfo] {
        devices.filter { Self.isCarThingName($0.name) }
    }

    var carThingConnections: [BTConnection] {
        connections.filter { Self.isCarThingName($0.name ?? "") }
    }

    func loadPairedDevices() {
        guard let list = IOBluetoothDevice.pairedDevices() as? [IOBluetoothDevice] else { return }
        for device in list {
            ingest(device: device)
            scheduleACLFallbackIfNeeded(for: device, reason: "paired device refresh")
        }
        let bonded = Set(list.compactMap { $0.addressString })
        let stale: (BTDeviceInfo) -> Bool = { [self] info in
            !bonded.contains(info.address) &&
            !activeChannels.keys.contains { $0.hasPrefix("\(info.address)#") } &&
            !(IOBluetoothDevice(addressString: info.address)?.isConnected() ?? false)
        }
        if devices.contains(where: stale) {
            devices.removeAll(where: stale)
        }
    }

    func connect(address: String, channel: BluetoothRFCOMMChannelID? = nil, userInitiated: Bool = false) {
        guard let device = IOBluetoothDevice(addressString: address) else {
            lastError = "Unknown device \(address)"
            return
        }
        guard device.isPaired() else {
            lastError = "\(device.name ?? address) isn't paired. Pair it in System Settings → Bluetooth first."
            log.info("connect(\(address, privacy: .public)) refused — device not bonded")
            return
        }
        ingest(device: device)
        peerConnectability[address] = hasRPCChannel(address) ? .connected : .unknown
        let chDesc = channel.map(String.init) ?? "auto"
        log.info("connect(\(address, privacy: .public), channel: \(chDesc, privacy: .public)) ignored — waiting for Car Thing probe")
        if userInitiated {
            lastError = "Waiting for Nocturne to finish connection. Please reconnect if this persists."
        }
    }

    private var inFlightConnects = Set<String>()

    private var outboundChannelContinuation: CheckedContinuation<IOReturn, Never>?
    private var outboundContinuationID: UUID?

    fileprivate func reportOutboundOpenComplete(status: IOReturn) {
        guard let waiter = outboundChannelContinuation else { return }
        outboundChannelContinuation = nil
        outboundContinuationID = nil
        waiter.resume(returning: status)
    }

    private static let probeResponseDelay: UInt64 = 500_000_000
    private static let probeBondWaitAttempts = 30
    private static let probeBondWaitDelay: UInt64 = 1_000_000_000
    private static let aclFallbackInitialDelay: UInt64 = 2_000_000_000
    private static let aclFallbackRetryDelay: UInt64 = 3_000_000_000
    private static let aclFallbackAttempts = 8

    private func respondToProbe(from address: String) {
        if inFlightConnects.contains(address) {
            log.info("Probe response for \(address, privacy: .public) skipped — channel 2 dial already in flight")
            return
        }
        aclFallbackTasks[address]?.cancel()
        aclFallbackTasks[address] = nil
        aclFallbackExhausted.remove(address)
        guard let device = IOBluetoothDevice(addressString: address) else {
            log.info("Probe response for \(address, privacy: .public) deferred — device not visible yet")
            waitForProbeBondThenRespond(address: address)
            return
        }
        guard device.isPaired() else {
            ingest(device: device)
            log.info("Probe response for \(address, privacy: .public) deferred — waiting for bond")
            waitForProbeBondThenRespond(address: address)
            return
        }
        if hasRPCChannel(address) {
            peerConnectability[address] = .connected
            pendingProbeResponses[address]?.cancel()
            pendingProbeResponses[address] = nil
            pendingAnonymousProbeResponse?.cancel()
            pendingAnonymousProbeResponse = nil
            return
        }

        lastError = nil
        peerConnectability[address] = .connecting
        inFlightConnects.insert(address)
        log.info("Responding to Car Thing probe from \(address, privacy: .public) by dialing RFCOMM channel 2")

        Task { [weak self] in
            guard let self else { return }
            try? await Task.sleep(nanoseconds: Self.probeResponseDelay)
            await self.openRPCChannelForProbe(device: device)
            self.inFlightConnects.remove(address)
        }
    }

    private func waitForProbeAddressThenRespond() {
        guard pendingAnonymousProbeResponse == nil else { return }
        lastError = "Waiting for macOS to finish pairing."
        pendingAnonymousProbeResponse = Task { @MainActor [weak self] in
            guard let self else { return }
            defer { self.pendingAnonymousProbeResponse = nil }

            for _ in 0..<Self.probeBondWaitAttempts {
                if Task.isCancelled { return }
                self.loadPairedDevices()
                if let address = self.probeAddressCandidate() {
                    self.log.info("Resolved pending Car Thing probe to \(address, privacy: .public)")
                    self.respondToProbe(from: address)
                    return
                }
                try? await Task.sleep(nanoseconds: Self.probeBondWaitDelay)
            }

            self.lastError = "Nocturne requested the connector, but no paired device was found."
            self.log.warning("Bluetooth-Incoming-Port probe expired without a paired Car Thing address")
        }
    }

    private func waitForProbeBondThenRespond(address: String) {
        guard pendingProbeResponses[address] == nil else { return }
        peerConnectability[address] = .connecting
        lastError = "Waiting for macOS to finish pairing."

        pendingProbeResponses[address] = Task { @MainActor [weak self] in
            guard let self else { return }
            defer { self.pendingProbeResponses[address] = nil }

            for _ in 0..<Self.probeBondWaitAttempts {
                if Task.isCancelled { return }
                if self.hasRPCChannel(address) {
                    self.peerConnectability[address] = .connected
                    self.lastError = nil
                    return
                }

                self.loadPairedDevices()
                if let device = IOBluetoothDevice(addressString: address) {
                    self.ingest(device: device)
                    if device.isPaired() {
                        self.log.info("Pairing completed for \(address, privacy: .public); answering pending probe")
                        self.respondToProbe(from: address)
                        return
                    }
                }

                try? await Task.sleep(nanoseconds: Self.probeBondWaitDelay)
            }

            self.peerConnectability[address] = .rejecting(since: Date())
            self.lastError = "Nocturne was disconnected, please retry."
            self.log.warning("Pending probe response for \(address, privacy: .public) expired before bond became visible")
        }
    }

    private func scheduleACLFallbackIfNeeded(for device: IOBluetoothDevice, reason: String) {
        let address = device.addressString ?? ""
        guard !address.isEmpty else { return }
        guard Self.looksLikeCarThing(name: device.name ?? "") else { return }
        guard device.isPaired(), device.isConnected() else { return }
        guard !hasRPCChannel(address) else { return }
        guard !inFlightConnects.contains(address) else { return }
        guard aclFallbackTasks[address] == nil else { return }
        guard !aclFallbackExhausted.contains(address) else { return }

        peerConnectability[address] = .connecting
        log.info("Car Thing \(address, privacy: .public) has an ACL link but no RFCOMM session; scheduling channel 2 fallback (\(reason, privacy: .public))")

        aclFallbackTasks[address] = Task { @MainActor [weak self] in
            guard let self else { return }
            defer { self.aclFallbackTasks[address] = nil }

            try? await Task.sleep(nanoseconds: Self.aclFallbackInitialDelay)

            for attempt in 1...Self.aclFallbackAttempts {
                if Task.isCancelled { return }
                if self.hasRPCChannel(address) {
                    self.peerConnectability[address] = .connected
                    self.lastError = nil
                    return
                }
                guard let currentDevice = IOBluetoothDevice(addressString: address) else { return }
                self.ingest(device: currentDevice)
                guard currentDevice.isPaired() else { return }
                guard currentDevice.isConnected() else {
                    self.peerConnectability[address] = .unknown
                    return
                }
                if self.inFlightConnects.contains(address) {
                    try? await Task.sleep(nanoseconds: Self.aclFallbackRetryDelay)
                    continue
                }

                self.peerConnectability[address] = .connecting
                self.inFlightConnects.insert(address)
                self.log.info("Opening RFCOMM channel 2 for \(address, privacy: .public) from ACL fallback (attempt \(attempt, privacy: .public)/\(Self.aclFallbackAttempts, privacy: .public))")
                let opened = await self.openRPCChannel(
                    device: currentDevice,
                    basebandFailureMessage: "macOS reports Nocturne as connected, but the connector could not reopen the Bluetooth link.",
                    channelFailureMessage: "macOS reports Nocturne as connected, but the connector could not open RFCOMM channel 2.",
                    setFailure: false
                )
                self.inFlightConnects.remove(address)
                if opened { return }

                if attempt < Self.aclFallbackAttempts {
                    try? await Task.sleep(nanoseconds: Self.aclFallbackRetryDelay)
                }
            }

            self.aclFallbackExhausted.insert(address)
            if !self.hasRPCChannel(address) {
                self.peerConnectability[address] = .rejecting(since: Date())
                self.lastError = "macOS reports Nocturne as connected, but the connector could not open RFCOMM channel 2."
                self.log.warning("ACL fallback exhausted for \(address, privacy: .public) without an RFCOMM session")
            }
        }
    }

    private func openRPCChannelForProbe(device: IOBluetoothDevice) async {
        _ = await openRPCChannel(
            device: device,
            basebandFailureMessage: "Nocturne requested the connector, but macOS could not reopen the Bluetooth link.",
            channelFailureMessage: "Nocturne requested the connector, but macOS could not open RFCOMM channel 2.",
            setFailure: true
        )
    }

    private func openRPCChannel(
        device: IOBluetoothDevice,
        basebandFailureMessage: String,
        channelFailureMessage: String,
        setFailure: Bool
    ) async -> Bool {
        let addr = device.addressString ?? "?"
        if hasRPCChannel(addr) { return true }
        guard device.isPaired() else { return false }

        if !device.isConnected() {
            let r = await openBaseband(device: device)
            log.info("openConnection(\(addr, privacy: .public)) after probe -> \(r, privacy: .public)")
            if r != kIOReturnSuccess {
                if setFailure {
                    peerConnectability[addr] = .rejecting(since: Date())
                    lastError = basebandFailureMessage
                }
                return false
            }
        }

        if await dial(device: device, candidates: [2]) {
            return true
        }
        if setFailure {
            peerConnectability[addr] = .rejecting(since: Date())
            lastError = channelFailureMessage
        }
        return false
    }

    private var basebandWaiters: [UUID: (address: String, cont: CheckedContinuation<IOReturn, Never>)] = [:]

    private func openBaseband(device: IOBluetoothDevice) async -> IOReturn {
        let addr = device.addressString ?? "?"
        let id = UUID()
        return await withCheckedContinuation { cont in
            basebandWaiters[id] = (addr, cont)
            let queued = device.openConnection(bridge)
            if queued != kIOReturnSuccess {
                basebandWaiters.removeValue(forKey: id)?.cont.resume(returning: queued)
                return
            }

            Task { @MainActor [weak self] in
                try? await Task.sleep(nanoseconds: 25_000_000_000)
                self?.basebandWaiters.removeValue(forKey: id)?.cont.resume(returning: kIOReturnTimeout)
            }
        }
    }

    fileprivate func reportBasebandConnectComplete(device: IOBluetoothDevice, status: IOReturn) {
        let addr = device.addressString ?? "?"
        let ids = basebandWaiters.filter { $0.value.address == addr }.map(\.key)
        for id in ids {
            basebandWaiters.removeValue(forKey: id)?.cont.resume(returning: status)
        }
    }

    private func hasRPCChannel(_ address: String) -> Bool {
        activeChannels.keys.contains {
            $0.hasPrefix("\(address)#")
                && $0 != channelKey(address: address, id: probeListener.registeredChannel)
        }
    }

    private func dial(device: IOBluetoothDevice, candidates: [BluetoothRFCOMMChannelID]) async -> Bool {
        let addr = device.addressString ?? "?"
        for ch in candidates {
            let key = channelKey(address: addr, id: ch)
            if activeChannels[key] != nil {
                log.info("Channel \(ch, privacy: .public) skipped — already connected to \(addr, privacy: .public)")
                return true
            }
            var channel: IOBluetoothRFCOMMChannel?
            let queueResult = device.openRFCOMMChannelAsync(&channel, withChannelID: ch, delegate: bridge)
            log.info("openRFCOMMChannelAsync(\(addr, privacy: .public), ch \(ch, privacy: .public)) queued -> \(queueResult, privacy: .public)")
            if queueResult != kIOReturnSuccess {
                continue
            }

            let openStatus: IOReturn = await withCheckedContinuation { cont in
                if let stale = self.outboundChannelContinuation {
                    self.log.warning("Pre-existing continuation found — aborting it")
                    stale.resume(returning: kIOReturnAborted)
                }
                self.outboundChannelContinuation = cont
                let attemptID = UUID()
                self.outboundContinuationID = attemptID
                Task { @MainActor in
                    try? await Task.sleep(nanoseconds: 6 * 1_000_000_000)
                    if self.outboundContinuationID == attemptID,
                       let waiter = self.outboundChannelContinuation {
                        waiter.resume(returning: kIOReturnTimeout)
                        self.outboundChannelContinuation = nil
                        self.outboundContinuationID = nil
                    }
                }
            }
            log.info("RFCOMM open(\(addr, privacy: .public), ch \(ch, privacy: .public)) result: \(openStatus, privacy: .public)")
            if openStatus == kIOReturnSuccess {
                return true
            }
        }
        return false
    }

    func disconnect(address: String) {
        let keysToClose = activeChannels.keys.filter { $0.hasPrefix("\(address)#") }
        for key in keysToClose {
            activeChannels[key]?.close()
            activeChannels.removeValue(forKey: key)
        }
        rpcManager?.detachAll(address: address)
        pendingProbeResponses[address]?.cancel()
        pendingProbeResponses[address] = nil
        pendingAnonymousProbeResponse?.cancel()
        pendingAnonymousProbeResponse = nil
        aclFallbackTasks[address]?.cancel()
        aclFallbackTasks[address] = nil
        aclFallbackExhausted.remove(address)
        connections.removeAll { $0.address == address }
        if let idx = devices.firstIndex(where: { $0.address == address }) {
            devices[idx].connected = false
        }
        peerConnectability[address] = .unknown
    }

    func teardownStaleLink(address: String) {
        log.warning("Tearing down unresponsive link to \(address, privacy: .public); waiting for the next Car Thing probe")
        disconnect(address: address)
        if let device = IOBluetoothDevice(addressString: address), device.isConnected() {
            device.closeConnection()
        }
    }

    fileprivate func ingest(device: IOBluetoothDevice) {
        let address = device.addressString ?? ""
        let info = BTDeviceInfo(
            address: address,
            name: device.name ?? device.nameOrAddress ?? address,
            paired: device.isPaired(),
            connected: device.isConnected(),
            trusted: device.isPaired(),
            rssi: device.rawRSSI() != 0 ? Int(device.rawRSSI()) : nil
        )
        if let idx = devices.firstIndex(where: { $0.address == address }) {
            if devices[idx] != info {
                devices[idx] = info
            }
        } else {
            devices.append(info)
        }
    }

    fileprivate func handleChannelOpened(_ channel: IOBluetoothRFCOMMChannel) {
        guard let device = channel.getDevice(), let address = device.addressString else { return }
        let chID = channel.getID()
        let key = channelKey(address: address, id: chID)

        if activeChannels[key] != nil {
            return
        }

        log.info("RFCOMM channel opened: \(address, privacy: .public) ch=\(chID, privacy: .public)")
        channel.setDelegate(bridge)
        activeChannels[key] = channel
        ingest(device: device)

        if chID == probeListener.registeredChannel {
            if activeChannels[channelKey(address: address, id: 2)] == nil {
                respondToProbe(from: address)
            }
            return
        }

        let devicePath = "rfcomm-client:\(address)"
        let conn = BTConnection(
            devicePath: devicePath,
            address: address,
            name: devices.first(where: { $0.address == address })?.name ?? device.name ?? device.nameOrAddress
        )
        if !connections.contains(where: { $0.devicePath == conn.devicePath }) {
            connections.append(conn)
        }
        if let idx = devices.firstIndex(where: { $0.address == address }) {
            devices[idx].connected = true
        }
        peerConnectability[address] = .connected
        pendingProbeResponses[address]?.cancel()
        pendingProbeResponses[address] = nil
        pendingAnonymousProbeResponse?.cancel()
        pendingAnonymousProbeResponse = nil
        aclFallbackTasks[address]?.cancel()
        aclFallbackTasks[address] = nil
        aclFallbackExhausted.remove(address)
        lastError = nil

        rpcManager?.attach(channel: channel, address: address)
    }

    fileprivate func handleChannelData(_ channel: IOBluetoothRFCOMMChannel, data: Data) {
        guard let device = channel.getDevice(), let address = device.addressString else { return }
        if channel.getID() == probeListener.registeredChannel {
            return
        }
        rpcManager?.ingest(data, channel: channel, address: address)
    }

    fileprivate func handleChannelClosed(_ channel: IOBluetoothRFCOMMChannel) {
        guard let address = channel.getDevice()?.addressString else { return }
        let chID = channel.getID()
        activeChannels.removeValue(forKey: channelKey(address: address, id: chID))
        rpcManager?.detach(channel: channel, address: address)
        log.info("RFCOMM channel closed: \(address, privacy: .public) ch=\(chID, privacy: .public)")

        if chID != probeListener.registeredChannel {
            let staleKeys = activeChannels.keys.filter { $0.hasPrefix("\(address)#") }
            for key in staleKeys {
                if let ch = activeChannels.removeValue(forKey: key) {
                    ch.close()
                }
            }
        }

        let stillConnected = activeChannels.keys.contains(where: { $0.hasPrefix("\(address)#") })
        if !stillConnected {
            connections.removeAll { $0.address == address }
            if let idx = devices.firstIndex(where: { $0.address == address }) {
                devices[idx].connected = false
            }
            peerConnectability[address] = inFlightConnects.contains(address) ? .connecting : .unknown
        } else {
            let devicePath = "rfcomm-client:\(address)"
            connections.removeAll { $0.devicePath == devicePath }
        }
    }
}

final class BluetoothDelegateBridge: NSObject, IOBluetoothRFCOMMChannelDelegate {
    weak var service: BluetoothService?

    init(service: BluetoothService) {
        self.service = service
        super.init()
    }

    @objc func deviceACLConnected(_ notification: IOBluetoothUserNotification, device: IOBluetoothDevice) {
        Task { @MainActor in self.service?.handleACLConnect(device: device) }
    }

    @objc func connectionComplete(_ device: IOBluetoothDevice, status: IOReturn) {
        Task { @MainActor in self.service?.reportBasebandConnectComplete(device: device, status: status) }
    }

    func rfcommChannelOpenComplete(_ rfcommChannel: IOBluetoothRFCOMMChannel!, status error: IOReturn) {
        Task { @MainActor in self.service?.reportOutboundOpenComplete(status: error) }
        guard error == kIOReturnSuccess, let rfcommChannel else { return }
        Task { @MainActor in self.service?.handleChannelOpened(rfcommChannel) }
    }

    func rfcommChannelClosed(_ rfcommChannel: IOBluetoothRFCOMMChannel!) {
        guard let rfcommChannel else { return }
        Task { @MainActor in self.service?.handleChannelClosed(rfcommChannel) }
    }

    func rfcommChannelData(_ rfcommChannel: IOBluetoothRFCOMMChannel!, data dataPointer: UnsafeMutableRawPointer!, length dataLength: Int) {
        guard let rfcommChannel, let dataPointer, dataLength > 0 else { return }
        let data = Data(bytes: dataPointer, count: dataLength)
        Task { @MainActor in self.service?.handleChannelData(rfcommChannel, data: data) }
    }

    func rfcommChannelWriteComplete(_ rfcommChannel: IOBluetoothRFCOMMChannel!, refcon: UnsafeMutableRawPointer!, status error: IOReturn) {}

    func rfcommChannelControlSignalsChanged(_ rfcommChannel: IOBluetoothRFCOMMChannel!) {}

    func rfcommChannelFlowControlChanged(_ rfcommChannel: IOBluetoothRFCOMMChannel!) {}

    func rfcommChannelQueueSpaceAvailable(_ rfcommChannel: IOBluetoothRFCOMMChannel!) {}
}

#else

@MainActor
final class BluetoothService: ObservableObject {
    @Published private(set) var status = BTAdapterStatus(powered: false)
    @Published private(set) var devices: [BTDeviceInfo] = []
    @Published private(set) var connections: [BTConnection] = []
    @Published var lastError: String? = "Bluetooth is only available on macOS."

    func refreshAdapterStatus() {}
    func loadPairedDevices() {}
    func connect(address: String, channel: UInt8? = nil, userInitiated: Bool = false) {}
    func disconnect(address: String) {}
    func teardownStaleLink(address: String) {}
}

#endif
