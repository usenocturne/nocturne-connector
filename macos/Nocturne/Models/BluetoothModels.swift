import Foundation

struct BTDeviceInfo: Identifiable, Equatable {
    let address: String
    var name: String
    var paired: Bool
    var connected: Bool
    var trusted: Bool
    var rssi: Int?

    var id: String { address }

    var displayName: String {
        name.isEmpty ? address : name
    }
}

struct BTAdapterStatus: Equatable {
    var powered: Bool
}

struct BTConnection: Identifiable, Equatable {
    let devicePath: String
    let address: String
    var name: String?

    var id: String { devicePath }
}
