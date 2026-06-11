import Foundation
import os
#if canImport(IOBluetooth)
import IOBluetooth

@MainActor
final class RFCOMMServer {
    private let log = Log.make(for: "RFCOMMServer")

    typealias IncomingChannelHandler = (IOBluetoothRFCOMMChannel) -> Void
    var onIncomingChannel: IncomingChannelHandler?

    private(set) var registeredChannel: BluetoothRFCOMMChannelID = 0
    private(set) var lastRegistrationError: String? = nil
    private var serviceRecord: IOBluetoothSDPServiceRecord?
    private var notification: IOBluetoothUserNotification?
    private var bridge: RFCOMMServerBridge!

    init() {
        bridge = RFCOMMServerBridge(owner: self)
    }

    @discardableResult
    func register(serviceName: String = "Nocturne Connector") -> Bool {
        if serviceRecord != nil && registeredChannel > 0 { return true }

        guard let controller = IOBluetoothHostController.default() else {
            let msg = "No Bluetooth controller available"
            lastRegistrationError = msg
            log.error("\(msg, privacy: .public)")
            return false
        }
        if controller.powerState != kBluetoothHCIPowerStateON {
            let msg = "Bluetooth is off — toggle it on in System Settings"
            lastRegistrationError = msg
            log.error("\(msg, privacy: .public)")
            return false
        }

        let sppUUID = Data([0x11, 0x01])
        let l2capUUID = Data([0x01, 0x00])
        let rfcommUUID = Data([0x00, 0x03])
        let browseUUID = Data([0x10, 0x02])

        let sppDict: [String: Any] = [
            "0001 - ServiceClassIDList": [sppUUID],
            "0004 - ProtocolDescriptorList": [
                [l2capUUID],
                [rfcommUUID, NSNumber(value: 0)]
            ],
            "0005 - BrowseGroupList": [browseUUID],
            "0100 - ServiceName*": serviceName
        ]

        var record: IOBluetoothSDPServiceRecord? =
            IOBluetoothSDPServiceRecord.publishedServiceRecord(with: sppDict)

        if record == nil {
            log.warning("publishedServiceRecord(short-form) returned nil; retrying with verbose dict")
            let verbose: [String: Any] = [
                "0001 - ServiceClassIDList": [
                    ["DataElementType": NSNumber(value: 3),
                     "DataElementSize": NSNumber(value: 2),
                     "DataElementValue": NSNumber(value: 0x1101)]
                ],
                "0004 - ProtocolDescriptorList": [
                    [["DataElementType": NSNumber(value: 3),
                      "DataElementSize": NSNumber(value: 2),
                      "DataElementValue": NSNumber(value: 0x0100)]],
                    [["DataElementType": NSNumber(value: 3),
                      "DataElementSize": NSNumber(value: 2),
                      "DataElementValue": NSNumber(value: 0x0003)],
                     ["DataElementType": NSNumber(value: 1),
                      "DataElementSize": NSNumber(value: 1),
                      "DataElementValue": NSNumber(value: 0)]]
                ],
                "0100 - ServiceName*": serviceName
            ]
            record = IOBluetoothSDPServiceRecord.publishedServiceRecord(with: verbose)
        }

        guard let record else {
            let msg = "SDP publish unavailable on this macOS. Falling back to channel-open listener (no SDP record)."
            lastRegistrationError = msg
            log.info("\(msg, privacy: .public)")
            registerChannelListenerWithoutSDP()
            return false
        }

        var channel: BluetoothRFCOMMChannelID = 0
        let chStatus = record.getRFCOMMChannelID(&channel)
        if chStatus != kIOReturnSuccess || channel == 0 {
            let msg = "SDP record published but no RFCOMM channel assigned (status \(chStatus))."
            lastRegistrationError = msg
            log.error("\(msg, privacy: .public)")
            record.remove()
            serviceRecord = nil
            return false
        }
        registeredChannel = channel
        log.info("SDP record published for \(serviceName, privacy: .public); RFCOMM channel = \(channel, privacy: .public)")

        notification = IOBluetoothRFCOMMChannel.register(
            forChannelOpenNotifications: bridge,
            selector: #selector(RFCOMMServerBridge.rfcommChannelOpened(_:channel:)),
            withChannelID: channel,
            direction: kIOBluetoothUserNotificationChannelDirectionIncoming
        )
        if notification == nil {
            let msg = "Service published on channel \(channel), but channel-open notification registration failed."
            lastRegistrationError = msg
            log.warning("\(msg, privacy: .public)")
        } else {
            lastRegistrationError = nil
        }

        return true
    }

    private func registerChannelListenerWithoutSDP() {
        notification = IOBluetoothRFCOMMChannel.register(
            forChannelOpenNotifications: bridge,
            selector: #selector(RFCOMMServerBridge.rfcommChannelOpened(_:channel:))
        )
        if notification != nil {
            log.info("Registered channel-open listener (any channel, no SDP record)")
        } else {
            log.warning("Channel-open listener registration failed even without SDP")
        }
    }

    func unregister() {
        notification?.unregister()
        notification = nil
        if let record = serviceRecord {
            record.remove()
            serviceRecord = nil
        }
        registeredChannel = 0
    }

    fileprivate func handleIncomingChannel(_ channel: IOBluetoothRFCOMMChannel) {
        let device = channel.getDevice()
        let addr = device?.addressString ?? "?"
        let chID = channel.getID()
        log.info("Incoming RFCOMM from \(addr, privacy: .public) ch=\(chID, privacy: .public)")
        onIncomingChannel?(channel)
    }
}

final class RFCOMMServerBridge: NSObject {
    weak var owner: RFCOMMServer?

    init(owner: RFCOMMServer) {
        self.owner = owner
        super.init()
    }

    @objc func rfcommChannelOpened(_ notification: IOBluetoothUserNotification, channel: IOBluetoothRFCOMMChannel) {
        Task { @MainActor [weak self] in
            self?.owner?.handleIncomingChannel(channel)
        }
    }
}

#endif
