import Foundation

enum SpotifyAuthState: Equatable {
    case idle
    case loading
    case polling(deviceCode: String, userCode: String, verificationURI: String, interval: Int)
    case linked(displayName: String?)
    case skipped

    var statusString: String {
        switch self {
        case .idle: return "idle"
        case .loading: return "loading"
        case .polling: return "polling"
        case .linked: return "linked"
        case .skipped: return "skipped"
        }
    }

    var isLinked: Bool {
        if case .linked = self { return true } else { return false }
    }
}

struct SpotifyDeviceAuthResponse: Decodable {
    let device_code: String
    let user_code: String
    let verification_uri: String
    let interval: Int?
    let expires_in: Int?
}

struct SpotifyTokenResponse: Decodable {
    let access_token: String?
    let refresh_token: String?
    let token_type: String?
    let scope: String?
    let expires_in: Int?
    let error: String?
    let error_description: String?
}

struct SpotifyCredentials: Codable, Equatable {
    let accessToken: String
    let refreshToken: String
    let scope: String?
    let tokenType: String
    let expiresAt: Date
    let displayName: String?
}
