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
    private let peerCooldown: TimeInterval = 60
    private var lastRejectionAt: [String: Date] = [:]

    weak var rpcManager: RPCManager?

    private var bridge: BluetoothDelegateBridge!
    private var activeChannels: [String: IOBluetoothRFCOMMChannel] = [:]
    private func channelKey(address: String, id: BluetoothRFCOMMChannelID) -> String {
        "\(address)#\(id)"
    }
    private let server = RFCOMMServer()

    var serverChannel: BluetoothRFCOMMChannelID { server.registeredChannel }

    var serverError: String? { server.lastRegistrationError }

    func republishSPPService() {
        startSPPServer()
        objectWillChange.send()
    }

    private var connectNotification: IOBluetoothUserNotification?

    init() {
        bridge = BluetoothDelegateBridge(service: self)
        refreshAdapterStatus()
        loadPairedDevices()
        startSPPServer()

        connectNotification = IOBluetoothDevice.register(
            forConnectNotifications: bridge,
            selector: #selector(BluetoothDelegateBridge.deviceACLConnected(_:device:))
        )

        Task { @MainActor [weak self] in
            while true {
                try? await Task.sleep(nanoseconds: 3_000_000_000)
                guard let self else { return }
                self.refreshAdapterStatus()
                self.loadPairedDevices()
                self.resyncCarThingLinks()
            }
        }
    }

    private func resyncCarThingLinks() {
        guard status.powered else { return }
        for d in devices where d.paired && Self.looksLikeCarThing(name: d.name) {
            guard !hasRPCChannel(d.address),
                  !bondWatchers.contains(d.address),
                  !inFlightConnects.contains(d.address) else { continue }
            if let at = lastRejectionAt[d.address], Date().timeIntervalSince(at) < peerCooldown {
                continue
            }
            connect(address: d.address)
        }
    }

    fileprivate func handleACLConnect(device: IOBluetoothDevice) {
        let address = device.addressString ?? ""
        guard Self.looksLikeCarThing(name: device.name ?? "") else { return }
        ingest(device: device)
        if connections.contains(where: { $0.address == address }) { return }
        guard !bondWatchers.contains(address) else { return }
        bondWatchers.insert(address)
        log.info("Car Thing ACL-connected (\(address, privacy: .public)); waiting for bond before dialing RPC")
        Task { @MainActor in
            defer { self.bondWatchers.remove(address) }
            for _ in 0..<45 {
                try? await Task.sleep(nanoseconds: 2_000_000_000)
                guard let dev = IOBluetoothDevice(addressString: address),
                      !self.connections.contains(where: { $0.address == address }) else { return }
                if dev.isPaired() {
                    self.ingest(device: dev)
                    self.connect(address: address)
                    return
                }
                if !dev.isConnected() { return }
            }
            self.log.info("ACL link from \(address, privacy: .public) never bonded; not dialing. Pair it in System Settings → Bluetooth.")
        }
    }

    private var bondWatchers = Set<String>()

    private func startSPPServer() {
        server.onIncomingChannel = { [weak self] channel in
            guard let self else { return }
            guard let device = channel.getDevice(), device.isPaired(),
                  Self.looksLikeCarThing(name: device.name ?? "") else {
                let addr = channel.getDevice()?.addressString ?? "?"
                self.log.warning("Rejecting inbound RFCOMM from unpaired/unknown device \(addr, privacy: .public)")
                channel.close()
                return
            }
            channel.setDelegate(self.bridge)
            self.handleChannelOpened(channel)
        }
        let ok = server.register(serviceName: "Nocturne Connector")
        if !ok {
            log.info("SDP publish unavailable; running outbound-only.")
        } else {
            if lastError?.contains("SPP") == true || lastError?.contains("Bluetooth is off") == true {
                lastError = nil
            }
        }
    }

    func refreshAdapterStatus() {
        let powered = IOBluetoothHostController.default()?.powerState == kBluetoothHCIPowerStateON
        if status.powered != powered {
            status.powered = powered
        }
    }

    static func looksLikeCarThing(name: String) -> Bool {
        let lower = name.lowercased()
        return lower.contains("nocturne") || lower.contains("car thing") || lower.contains("carthing")
    }

    nonisolated static func isCarThingName(_ name: String) -> Bool {
        name.range(of: #"^Nocturne \(.+\)$"#, options: .regularExpression) != nil
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
        if inFlightConnects.contains(address) {
            log.info("connect(\(address, privacy: .public)) skipped — already in flight")
            return
        }
        if !userInitiated, let at = lastRejectionAt[address], Date().timeIntervalSince(at) < peerCooldown {
            let remaining = Int(peerCooldown - Date().timeIntervalSince(at))
            log.info("connect(\(address, privacy: .public)) suppressed — peer rejected \(remaining, privacy: .public)s ago")
            return
        }
        if userInitiated {
            lastRejectionAt[address] = nil
        }
        guard let device = IOBluetoothDevice(addressString: address) else {
            lastError = "Unknown device \(address)"
            return
        }
        guard device.isPaired() else {
            lastError = "\(device.name ?? address) isn't paired. Pair it in System Settings → Bluetooth first."
            log.info("connect(\(address, privacy: .public)) refused — device not bonded")
            return
        }
        lastError = nil
        peerConnectability[address] = .connecting
        let chDesc = channel.map(String.init) ?? "auto"
        log.info("connect(\(address, privacy: .public), channel: \(chDesc, privacy: .public))")

        inFlightConnects.insert(address)
        Task { [weak self] in
            guard let self else { return }
            await self.openRFCOMM(device: device, requestedChannel: channel, userInitiated: userInitiated)
            self.inFlightConnects.remove(address)
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

    private static let dialRounds = 8
    private static let dialRoundDelay: UInt64 = 2_000_000_000

    private func openRFCOMM(
        device: IOBluetoothDevice,
        requestedChannel: BluetoothRFCOMMChannelID?,
        userInitiated: Bool = false
    ) async {
        let addr = device.addressString ?? "?"
        var candidates: [BluetoothRFCOMMChannelID] = []

        for round in 1...Self.dialRounds {
            if hasRPCChannel(addr) { return }
            guard device.isPaired() else { return }

            if !device.isConnected() {
                let r = await openBaseband(device: device)
                log.info("openConnection(\(addr, privacy: .public)) -> \(r, privacy: .public) [round \(round, privacy: .public)/\(Self.dialRounds, privacy: .public)]")
                if r != kIOReturnSuccess {
                    try? await Task.sleep(nanoseconds: Self.dialRoundDelay)
                    continue
                }
            }

            if candidates.isEmpty {
                candidates = await discoverCandidateChannels(device: device, requestedChannel: requestedChannel)
                log.info("RFCOMM candidate channels for \(addr, privacy: .public): \(candidates, privacy: .public)")
            }

            if await dial(device: device, candidates: candidates) {
                return
            }
            log.info("RFCOMM dial round \(round, privacy: .public)/\(Self.dialRounds, privacy: .public) to \(addr, privacy: .public) failed")
            try? await Task.sleep(nanoseconds: Self.dialRoundDelay)
        }

        peerConnectability[addr] = .rejecting(since: Date())
        lastRejectionAt[addr] = Date()
        let hasInbound = activeChannels.keys.contains(where: { $0.hasPrefix("\(addr)#") })
        if userInitiated && !hasInbound {
            lastError = "Couldn't open the RPC channel to the Car Thing. Make sure it's paired in System Settings → Bluetooth and in range, then try again."
        }
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

    private func discoverCandidateChannels(
        device: IOBluetoothDevice,
        requestedChannel: BluetoothRFCOMMChannelID?
    ) async -> [BluetoothRFCOMMChannelID] {
        let addr = device.addressString ?? "?"
        let sppUUID = IOBluetoothSDPUUID.uuid16(UInt16(kBluetoothSDPUUID16ServiceClassSerialPort.rawValue))
        let sdpStatus: IOReturn = device.performSDPQuery(nil)
        log.info("performSDPQuery(\(addr, privacy: .public)) -> \(sdpStatus, privacy: .public)")
        var record = device.getServiceRecord(for: sppUUID)
        for _ in 0..<15 {
            if record != nil { break }
            try? await Task.sleep(nanoseconds: 200_000_000)
            record = device.getServiceRecord(for: sppUUID)
        }

        var candidates: [BluetoothRFCOMMChannelID] = []
        if let requested = requestedChannel { candidates.append(requested) }
        if let record {
            var ch: BluetoothRFCOMMChannelID = 0
            if record.getRFCOMMChannelID(&ch) == kIOReturnSuccess,
               !candidates.contains(ch),
               ch != server.registeredChannel {
                candidates.append(ch)
            }
        }
        for fallback: BluetoothRFCOMMChannelID in [2, 3]
            where !candidates.contains(fallback) && fallback != server.registeredChannel {
            candidates.append(fallback)
        }
        return candidates
    }

    private func hasRPCChannel(_ address: String) -> Bool {
        activeChannels.keys.contains {
            $0.hasPrefix("\(address)#")
                && $0 != channelKey(address: address, id: server.registeredChannel)
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
        connections.removeAll { $0.address == address }
        if let idx = devices.firstIndex(where: { $0.address == address }) {
            devices[idx].connected = false
        }
        peerConnectability[address] = .unknown
    }

    func teardownStaleLink(address: String) {
        log.warning("Tearing down unresponsive link to \(address, privacy: .public); resync will redial")
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

        if chID == server.registeredChannel,
           activeChannels[channelKey(address: address, id: 2)] == nil {
            log.info("Inbound ch=\(chID, privacy: .public) detected; opening outbound ch 2 for RPC")
            Task { @MainActor in
                try? await Task.sleep(nanoseconds: 500_000_000)
                connect(address: address, channel: 2)
            }
        }

        let devicePath = "rfcomm-\(chID == 1 ? "server" : "client"):\(address)"
        let conn = BTConnection(
            devicePath: devicePath,
            address: address,
            name: device.name
        )
        if !connections.contains(where: { $0.devicePath == conn.devicePath }) {
            connections.append(conn)
        }
        if let idx = devices.firstIndex(where: { $0.address == address }) {
            devices[idx].connected = true
        }
        peerConnectability[address] = .connected
        lastRejectionAt[address] = nil
        lastError = nil

        if chID != server.registeredChannel {
            rpcManager?.attach(channel: channel, address: address)
        }
    }

    fileprivate func handleChannelData(_ channel: IOBluetoothRFCOMMChannel, data: Data) {
        guard let device = channel.getDevice(), let address = device.addressString else { return }
        if channel.getID() == server.registeredChannel {
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

        if chID != server.registeredChannel {
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
            peerConnectability[address] = .unknown
        } else {
            let devicePath = "rfcomm-\(chID == 1 ? "server" : "client"):\(address)"
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
