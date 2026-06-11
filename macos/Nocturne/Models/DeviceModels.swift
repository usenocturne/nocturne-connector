import Foundation

struct CarThingInfo: Equatable {
    var device: String?
    var version: String?
    var fullVersion: String?
    var buildDate: String?
    var gitHash: String?
    var serialNumber: String?
}

struct ConnectedDevice: Identifiable, Equatable {
    let id: String
    let address: String
    var info: CarThingInfo?
}

struct ConnectorInfo: Equatable {
    let version: String
    let osVersion: String
}
