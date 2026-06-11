import Foundation

protocol SpotifyCommandHandling: AnyObject {
    func supports(_ method: String) -> Bool

    func dispatch(_ method: String, params: [String: Any]) async throws -> Any?

    var isSpotifyLinked: Bool { get }

    var onDeviceBroadcast: ((String, Any) -> Void)? { get set }
}
