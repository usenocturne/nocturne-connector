import Foundation
import os
import Darwin
#if canImport(IOBluetooth)
import IOBluetooth
#endif

#if canImport(IOBluetooth)

nonisolated final class SerialProbeListener: @unchecked Sendable {
    static let probeChannel: BluetoothRFCOMMChannelID = 3

    private let log = Logger(subsystem: "com.usenocturne.connector.mac", category: "SerialProbeListener")
    private let path = "/dev/tty.Bluetooth-Incoming-Port"
    private let lock = NSLock()
    private var running = false
    private var workerStarted = false
    private var error: String?

    var onProbe: (@MainActor () -> Void)?
    var lastError: String? {
        lock.lock()
        let value = error
        lock.unlock()
        return value
    }
    var registeredChannel: BluetoothRFCOMMChannelID { Self.probeChannel }

    func start() {
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
        lock.unlock()
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

    private func run() {
        while isRunning() {
            let fd = open(path, O_RDWR | O_NOCTTY)
            if fd < 0 {
                let err = errno
                let message = "Unable to listen on \(path): \(String(cString: strerror(err)))"
                setLastError(message)
                log.error("\(message, privacy: .public)")
                Thread.sleep(forTimeInterval: 2)
                continue
            }

            setLastError(nil)
            log.info("Inbound Car Thing probe arrived on Bluetooth-Incoming-Port")
            Task { @MainActor [weak self] in
                self?.onProbe?()
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

#endif
