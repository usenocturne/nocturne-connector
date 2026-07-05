import Foundation
import os
import Darwin
#if canImport(IOBluetooth)
import IOBluetooth
#endif

#if canImport(IOBluetooth)

nonisolated final class SerialProbeListener: @unchecked Sendable {
    static let probeChannel: BluetoothRFCOMMChannelID = 3
    typealias ProbeHandler = @MainActor (_ channel: IOBluetoothRFCOMMChannel?) -> Void

    private let log = Logger(subsystem: "com.usenocturne.connector.mac", category: "SerialProbeListener")
    private let path = "/dev/tty.Bluetooth-Incoming-Port"
    private let lock = NSLock()
    private var bridge: SerialProbeListenerBridge!
    private var notification: IOBluetoothUserNotification?
    private var running = false
    private var workerStarted = false
    private var channelNotificationRegistered = false
    private var error: String?

    var onProbe: ProbeHandler?
    var lastError: String? {
        lock.lock()
        let value = error
        lock.unlock()
        return value
    }
    var registeredChannel: BluetoothRFCOMMChannelID { Self.probeChannel }

    init() {
        bridge = SerialProbeListenerBridge(owner: self)
    }

    func start() {
        registerChannelOpenNotification()

        lock.lock()
        running = true
        let shouldStartWorker = !workerStarted
        if shouldStartWorker {
            workerStarted = true
        }
        lock.unlock()

        guard shouldStartWorker else { return }
        DispatchQueue.global(qos: .utility).async { [weak self] in
            self?.run()
        }
    }

    func stop() {
        lock.lock()
        running = false
        let existingNotification = notification
        notification = nil
        channelNotificationRegistered = false
        lock.unlock()
        existingNotification?.unregister()
    }

    private func isRunning() -> Bool {
        lock.lock()
        let value = running
        lock.unlock()
        return value
    }

    private func setLastError(_ message: String?) {
        lock.lock()
        error = message
        lock.unlock()
    }

    private func hasChannelOpenNotification() -> Bool {
        lock.lock()
        let value = channelNotificationRegistered
        lock.unlock()
        return value
    }

    private func registerChannelOpenNotification() {
        lock.lock()
        let alreadyRegistered = notification != nil
        lock.unlock()
        guard !alreadyRegistered else { return }

        guard let registered = IOBluetoothRFCOMMChannel.register(
            forChannelOpenNotifications: bridge,
            selector: #selector(SerialProbeListenerBridge.rfcommChannelOpened(_:channel:)),
            withChannelID: Self.probeChannel,
            direction: kIOBluetoothUserNotificationChannelDirectionIncoming
        ) else {
            log.warning("Direct RFCOMM channel \(Self.probeChannel, privacy: .public) probe notifications unavailable; using Bluetooth-Incoming-Port fallback")
            return
        }

        lock.lock()
        notification = registered
        channelNotificationRegistered = true
        error = nil
        lock.unlock()
        log.info("Listening for incoming RFCOMM probes on channel \(Self.probeChannel, privacy: .public)")
    }

    fileprivate func handleIncomingProbeChannel(_ channel: IOBluetoothRFCOMMChannel) {
        guard channel.getID() == Self.probeChannel else { return }
        let address = channel.getDevice()?.addressString ?? "?"
        setLastError(nil)
        log.info("Inbound Car Thing probe opened RFCOMM channel \(Self.probeChannel, privacy: .public) from \(address, privacy: .public)")
        Task { @MainActor [weak self] in
            self?.onProbe?(channel)
        }
    }

    private func run() {
        while isRunning() {
            let fd = open(path, O_RDWR | O_NOCTTY)
            if fd < 0 {
                let err = errno
                let message = "Unable to listen on \(path): \(String(cString: strerror(err)))"
                if hasChannelOpenNotification() {
                    log.debug("Serial probe fallback unavailable: \(message, privacy: .public)")
                } else {
                    setLastError(message)
                    log.error("\(message, privacy: .public)")
                }
                Thread.sleep(forTimeInterval: 2)
                continue
            }

            setLastError(nil)
            log.info("Inbound Car Thing probe arrived on Bluetooth-Incoming-Port")
            Task { @MainActor [weak self] in
                self?.onProbe?(nil)
            }

            Thread.sleep(forTimeInterval: 1)
            close(fd)
            Thread.sleep(forTimeInterval: 0.25)
        }

        lock.lock()
        workerStarted = false
        lock.unlock()
    }
}

nonisolated final class SerialProbeListenerBridge: NSObject {
    weak var owner: SerialProbeListener?

    init(owner: SerialProbeListener) {
        self.owner = owner
        super.init()
    }

    @objc func rfcommChannelOpened(_ notification: IOBluetoothUserNotification, channel: IOBluetoothRFCOMMChannel) {
        owner?.handleIncomingProbeChannel(channel)
    }
}

#endif
