import Foundation
import os
import Combine
#if canImport(IOBluetooth)
import IOBluetooth
#endif

@MainActor
final class RPCManager: ObservableObject {
    private let log = Log.make(for: "RPCManager")
    private let spotify: SpotifyService
    private let analytics: AnalyticsService?
    private let currentUserID: () -> String?
    private let ota = OTAService()

    @Published private(set) var deviceInfo: CarThingInfo? = nil
    @Published private(set) var deviceInfoByAddress: [String: CarThingInfo] = [:]
    @Published private(set) var lastPing: Date? = nil

    private struct Connection {
        let address: String
        #if canImport(IOBluetooth)
        weak var channel: IOBluetoothRFCOMMChannel?
        #endif
        let client: RPCClient
    }

    private var connections: [String: Connection] = [:]
    private var keepAliveTask: Task<Void, Never>?
    private var keepAliveFailures: [String: Int] = [:]
    private static let keepAliveFailureLimit = 2
    private var downloadedOTAFileURL: URL? = nil
    private var authObservation: AnyCancellable?
    var onStaleConnection: ((String) -> Void)?

    init(
        spotify: SpotifyService,
        analytics: AnalyticsService? = nil,
        currentUserID: @escaping () -> String? = { nil }
    ) {
        self.spotify = spotify
        self.analytics = analytics
        self.currentUserID = currentUserID

        spotify.onDeviceBroadcast = { [weak self] topic, data in
            Task { @MainActor [weak self] in
                await self?.broadcastToDevices(topic: topic, data: RPCValueBridge.pack(data))
            }
        }

        authObservation = spotify.$authState
            .removeDuplicates()
            .sink { [weak self] state in
                Task { @MainActor [weak self] in
                    await self?.handleAuthStateChange(state)
                }
            }
    }

    #if canImport(IOBluetooth)
    func attach(channel: IOBluetoothRFCOMMChannel, address: String) {
        let key = channelKey(address: address, channel: channel)
        if connections[key] != nil { return }

        let client = RPCClient(id: key)
        client.onCall = { [weak self] method, params in
            await self?.handleCall(method: method, params: params) ?? (nil, "manager gone")
        }
        client.onEvent = { [weak self] topic, data in
            self?.handleEvent(topic: topic, data: data)
        }
        client.onWrite = { [weak self, weak channel] data in
            guard let channel else { return }
            guard channel.isOpen() else { return }
            let mtu = Int(channel.getMTU())
            let segment = mtu > 0 ? mtu : 1000
            data.withUnsafeBytes { (raw: UnsafeRawBufferPointer) in
                guard let base = raw.baseAddress else { return }
                var offset = 0
                while offset < data.count {
                    let len = min(segment, data.count - offset)
                    let ptr = UnsafeMutableRawPointer(mutating: base.advanced(by: offset))
                    let rc = channel.writeSync(ptr, length: UInt16(len))
                    if rc != kIOReturnSuccess {
                        self?.log.error("RFCOMM writeSync failed rc=\(rc, privacy: .public) len=\(len, privacy: .public) mtu=\(mtu, privacy: .public)")
                        break
                    }
                    offset += len
                }
            }
        }

        connections[key] = Connection(address: address, channel: channel, client: client)
        keepAliveFailures[key] = 0
        log.info("RPC client attached: \(key, privacy: .public) (RFCOMM MTU \(channel.getMTU(), privacy: .public))")

        startKeepAliveIfNeeded()

        Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: 500_000_000)
            await self?.sendInitialPing(key: key)
        }
    }

    func ingest(_ data: Data, channel: IOBluetoothRFCOMMChannel, address: String) {
        let key = channelKey(address: address, channel: channel)
        if let conn = connections[key] {
            Task { @MainActor in await conn.client.ingest(data) }
        } else {
            attach(channel: channel, address: address)
            if let conn = connections[key] {
                Task { @MainActor in await conn.client.ingest(data) }
            }
        }
    }

    func detach(channel: IOBluetoothRFCOMMChannel, address: String) {
        let key = channelKey(address: address, channel: channel)
        if let conn = connections.removeValue(forKey: key) {
            conn.client.cleanup()
            keepAliveFailures.removeValue(forKey: key)
            log.info("RPC client detached: \(key, privacy: .public)")
        }
        if !connections.values.contains(where: { $0.address == address }) {
            deviceInfoByAddress.removeValue(forKey: address)
            if deviceInfoByAddress.isEmpty {
                deviceInfo = nil
            }
        }
        if connections.isEmpty {
            stopKeepAlive()
        }
    }

    func detachAll(address: String) {
        for (key, conn) in connections where conn.address == address {
            conn.client.cleanup()
            connections.removeValue(forKey: key)
            keepAliveFailures.removeValue(forKey: key)
            log.info("RPC client detached: \(key, privacy: .public)")
        }
        deviceInfoByAddress.removeValue(forKey: address)
        if deviceInfoByAddress.isEmpty {
            deviceInfo = nil
        }
        if connections.isEmpty {
            stopKeepAlive()
        }
    }

    private func channelKey(address: String, channel: IOBluetoothRFCOMMChannel) -> String {
        "\(address)#\(channel.getID())"
    }
    #endif

    private func sendInitialPing(key: String) async {
        guard let conn = connections[key] else { return }
        do {
            _ = try await conn.client.call(
                method: "ping",
                params: .map([(.string("message"), .string("RPi connected"))])
            )
            lastPing = Date()
            log.info("Initial ping sent to \(key, privacy: .public)")
        } catch {
            log.error("Initial ping failed for \(key, privacy: .public): \(error.localizedDescription, privacy: .public)")
            return
        }

        await sendAppReady()
        Task { @MainActor [weak self] in
            for seconds in [2, 5] as [UInt64] {
                try? await Task.sleep(nanoseconds: seconds * 1_000_000_000)
                guard let self, self.connections[key] != nil else { return }
                await self.broadcastToDevices(topic: "spotify.auth.status", data: self.spotifyAuthPayload())
            }
        }

        Task { @MainActor [weak self] in
            guard let self, let conn = self.connections[key] else { return }
            do {
                let info = try await conn.client.call(method: "device.info", params: .map([]), timeout: 5)
                guard self.connections[key] != nil else { return }
                let parsed = self.parseDeviceInfo(info)
                self.deviceInfo = parsed
                self.deviceInfoByAddress[conn.address] = parsed
                await self.recordConnectionAnalytics(parsed)
            } catch {
                self.log.warning("device.info failed for \(key, privacy: .public) after app.ready: \(error.localizedDescription, privacy: .public)")
            }
        }
    }

    func deviceInfo(for address: String) -> CarThingInfo? {
        deviceInfoByAddress[address] ?? deviceInfo
    }

    private func startKeepAliveIfNeeded() {
        guard keepAliveTask == nil else { return }
        keepAliveTask = Task { @MainActor [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 15_000_000_000)
                guard let self, !Task.isCancelled else { return }
                var staleAddresses = Set<String>()
                for (key, conn) in self.connections {
                    do {
                        _ = try await conn.client.call(
                            method: "ping",
                            params: .map([
                                (.string("message"), .string("keepalive")),
                                (.string("volumePercent"), .int(50))
                            ])
                        )
                        self.lastPing = Date()
                        self.keepAliveFailures[key] = 0
                    } catch {
                        let failures = (self.keepAliveFailures[key] ?? 0) + 1
                        self.keepAliveFailures[key] = failures
                        self.log.warning("Keep-alive failed (\(failures, privacy: .public)/\(Self.keepAliveFailureLimit, privacy: .public)) for \(key, privacy: .public): \(error.localizedDescription, privacy: .public)")
                        if failures >= Self.keepAliveFailureLimit {
                            staleAddresses.insert(conn.address)
                        }
                    }
                }
                for address in staleAddresses {
                    self.log.error("RPC link to \(address, privacy: .public) is unresponsive; tearing it down until the next Car Thing probe")
                    self.onStaleConnection?(address)
                }
                await self.broadcastToDevices(topic: "spotify.auth.status", data: self.spotifyAuthPayload())
            }
        }
    }

    private func stopKeepAlive() {
        keepAliveTask?.cancel()
        keepAliveTask = nil
    }

    private func handleEvent(topic: String, data: MessagePackValue) {
        log.info("daemon → topic=\(topic, privacy: .public)")
        switch topic {
        case "daemon.ready":
            Task { @MainActor [weak self] in await self?.sendAppReady() }
        case "chunk.retransmit_request":
            guard let messageId = data.mapValue("message_id")?.stringValue,
                  let chunkIdx = data.mapValue("chunk_idx")?.intValue else { return }
            for (_, conn) in connections {
                conn.client.retransmitChunk(messageId: messageId, chunkIndex: chunkIdx)
            }
        default:
            break
        }
    }

    private func sendAppReady() async {
        let now = Date()
        let tz = TimeZone.current

        let authState = spotify.authState
        await broadcastToDevices(topic: "spotify.auth.status", data: spotifyAuthPayload(for: authState))

        await broadcastToDevices(topic: "app.ready", data: .map([
            (.string("platform"), .string("web")),
            (.string("timestamp"), .int(Int64(now.timeIntervalSince1970 * 1000))),
            (.string("spotifySkipped"), .bool(authState.isSkipped)),
            (.string("datetime"), .string(Self.utcDatetimeString(now))),
            (.string("time"), .string(Self.localTimeString(now))),
            (.string("timezone"), .map([
                (.string("identifier"), .string(tz.identifier)),
                (.string("secondsFromGMT"), .int(Int64(tz.secondsFromGMT(for: now)))),
                (.string("abbreviation"), .string(tz.abbreviation(for: now) ?? "")),
                (.string("isDaylightSavingTime"), .bool(tz.isDaylightSavingTime(for: now)))
            ]))
        ]))
        log.info("Sent app.ready to \(self.connections.count, privacy: .public) device(s)")
    }

    private func handleAuthStateChange(_ state: SpotifyAuthState) async {
        await broadcastToDevices(topic: "spotify.auth.status", data: spotifyAuthPayload(for: state))

        switch state {
        case .loading, .polling:
            await broadcastToDevices(topic: "spotify.auth.started", data: .map([
                (.string("status"), .string("authorization_started"))
            ]))
        case .linked:
            await broadcastToDevices(topic: "spotify.auth.completed", data: .map([
                (.string("authenticated"), .bool(true))
            ]))
        default:
            break
        }
    }

    private func spotifyAuthPayload(for state: SpotifyAuthState? = nil) -> MessagePackValue {
        switch state ?? spotify.authState {
        case .linked:
            return .map([
                (.string("authenticated"), .bool(true)),
                (.string("skipped"), .bool(false)),
                (.string("needsAuthorization"), .bool(false))
            ])
        case .skipped:
            return .map([
                (.string("authenticated"), .bool(false)),
                (.string("skipped"), .bool(true)),
                (.string("needsAuthorization"), .bool(false))
            ])
        case .loading:
            return .map([
                (.string("authenticated"), .bool(false)),
                (.string("skipped"), .bool(false)),
                (.string("loading"), .bool(true)),
                (.string("needsAuthorization"), .bool(false))
            ])
        case .polling:
            return .map([
                (.string("authenticated"), .bool(false)),
                (.string("skipped"), .bool(false)),
                (.string("authorizationInProgress"), .bool(true))
            ])
        case .idle:
            return .map([
                (.string("authenticated"), .bool(false)),
                (.string("skipped"), .bool(false)),
                (.string("needsAuthorization"), .bool(true))
            ])
        }
    }

    private func broadcastToDevices(topic: String, data: MessagePackValue) async {
        for (_, conn) in connections {
            await conn.client.sendEvent(topic: topic, data: data)
        }
    }

    private func handleCall(method: String, params: MessagePackValue) async -> (result: MessagePackValue?, error: String?) {
        log.info("RPC call: \(method, privacy: .public)")
        do {
            if let result = try await dispatch(method: method, params: params) {
                return (result, nil)
            }
            log.warning("Unknown method: \(method, privacy: .public)")
            return (nil, "Unknown method: \(method)")
        } catch {
            log.error("RPC call \(method, privacy: .public) failed: \(error.localizedDescription, privacy: .public)")
            return (nil, error.localizedDescription)
        }
    }

    private func dispatch(method: String, params: MessagePackValue) async throws -> MessagePackValue? {
        switch method {
        case "ping":
            let message = params.mapValue("message")?.stringValue ?? "pong"
            return .map([(.string("pong"), .string(message))])

        case "device.info":
            return .map([
                (.string("device"), .string("nocturne-connector")),
                (.string("version"), .string(AppConfig.connectorVersion))
            ])

        case "spotify.auth.getStatus":
            return spotifyAuthPayload()

        case "device.ota.check":
            let currentVersion = params.mapValue("currentVersion")?.stringValue ?? "unknown"
            let check = try await ota.checkForUpdates(currentVersion: currentVersion, channel: "beta")
            let metadata: MessagePackValue = check.metadata.map {
                .map([
                    (.string("auto_updateable"), .bool($0.autoUpdateable)),
                    (.string("critical"), .bool($0.critical))
                ])
            } ?? .nilValue
            return .map([
                (.string("updateAvailable"), .bool(check.updateAvailable)),
                (.string("version"), check.version.map { .string($0) } ?? .nilValue),
                (.string("channel"), check.channel.map { .string($0) } ?? .nilValue),
                (.string("metadata"), metadata)
            ])

        case "device.ota.download":
            let currentVersion = params.mapValue("currentVersion")?.stringValue ?? "unknown"
            let targetVersion = params.mapValue("targetVersion")?.stringValue ?? "unknown"
            let fileURL = try await ota.downloadUpdate(currentVersion: currentVersion, targetVersion: targetVersion)
            downloadedOTAFileURL = fileURL
            let size = try ota.fileSize(at: fileURL)
            let md5 = try await ota.calculateMD5(at: fileURL)
            await broadcastToDevices(topic: "device.ota.package_state", data: .map([
                (.string("state"), .string("download_success")),
                (.string("name"), .string("nocturne-os")),
                (.string("version"), .string(targetVersion)),
                (.string("hash"), .string(md5)),
                (.string("size"), .int(Int64(size)))
            ]))
            return .map([
                (.string("success"), .bool(true)),
                (.string("message"), .string("Update downloaded, ready for transfer"))
            ])

        case "device.ota.transfer":
            guard let fileURL = downloadedOTAFileURL else {
                throw RPCDispatchError("No OTA file available")
            }
            let offset = params.mapValue("offset")?.intValue ?? 0
            let size = params.mapValue("size")?.intValue ?? 31680
            let chunk = try await ota.readChunk(at: fileURL, offset: offset, size: size)
            return .map([(.string("data"), .string(chunk))])

        case "device.timezone.get":
            let tz = TimeZone.current
            return .map([
                (.string("identifier"), .string(tz.identifier)),
                (.string("secondsFromGMT"), .int(Int64(tz.secondsFromGMT(for: Date())))),
                (.string("abbreviation"), .string("")),
                (.string("isDaylightSavingTime"), .bool(false))
            ])

        case "device.time.get":
            let now = Date()
            return .map([
                (.string("datetime"), .string(Self.utcDatetimeString(now))),
                (.string("time"), .string(Self.localTimeString(now)))
            ])

        default:
            if method.hasPrefix("spotify.") {
                let result = try await spotify.dispatch(method, params: RPCValueBridge.dictionary(params))
                return RPCValueBridge.pack(result)
            }
            return nil
        }
    }

    private func parseDeviceInfo(_ value: MessagePackValue) -> CarThingInfo {
        CarThingInfo(
            device: value.mapValue("device")?.stringValue,
            version: value.mapValue("version")?.stringValue,
            fullVersion: value.mapValue("fullVersion")?.stringValue,
            buildDate: value.mapValue("buildDate")?.stringValue,
            gitHash: value.mapValue("gitHash")?.stringValue,
            serialNumber: value.mapValue("serialNumber")?.stringValue
        )
    }

    private func recordConnectionAnalytics(_ info: CarThingInfo) async {
        guard let analytics else { return }
        let serial = (info.serialNumber?.isEmpty == false) ? info.serialNumber! : "unknown"
        let firmwareVersion = (info.version?.isEmpty == false) ? info.version! : "unknown"
        let shortSerial = serial.count >= 4 ? String(serial.suffix(4)) : serial
        let deviceName = "Nocturne (\(shortSerial))"
        let userID = currentUserID()

        await analytics.recordDailyActive(
            deviceSerial: serial,
            userId: userID,
            appVersion: AppConfig.connectorVersion,
            firmwareVersion: firmwareVersion,
            phoneVersion: "Connector"
        )

        await analytics.trackEvent(
            deviceSerial: serial,
            userId: userID,
            eventType: "connection.established",
            eventData: [
                "device": deviceName,
                "mfi_serial": serial,
                "firmware_version": firmwareVersion,
            ]
        )
    }

    private static let utcDatetimeFormatter: DateFormatter = {
        let f = DateFormatter()
        f.dateFormat = "yyyy-MM-dd HH:mm:ss"
        f.timeZone = TimeZone(identifier: "UTC")
        f.locale = Locale(identifier: "en_US_POSIX")
        return f
    }()

    private static let localTimeFormatter: DateFormatter = {
        let f = DateFormatter()
        f.dateFormat = "HH:mm:ss"
        f.locale = Locale(identifier: "en_US_POSIX")
        return f
    }()

    private static func utcDatetimeString(_ date: Date) -> String {
        utcDatetimeFormatter.string(from: date)
    }

    private static func localTimeString(_ date: Date) -> String {
        localTimeFormatter.string(from: date)
    }
}

struct RPCDispatchError: LocalizedError {
    let message: String
    init(_ message: String) { self.message = message }
    var errorDescription: String? { message }
}
