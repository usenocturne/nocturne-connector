import Foundation

struct NocturneUser: Codable, Equatable, Identifiable {
    let id: String
    let email: String?
}

struct AuthStatus: Equatable {
    var authenticated: Bool = false
    var user: NocturneUser? = nil
    var isInitializing: Bool = false
    var passwordResetPending: Bool = false
    var setupComplete: Bool = false
}

struct PairRedeemResponse: Decodable {
    let access_token: String?
    let refresh_token: String?
    let error: String?
}

struct SupabaseTokens: Codable, Equatable {
    let accessToken: String
    let refreshToken: String

    enum CodingKeys: String, CodingKey {
        case accessToken = "access_token"
        case refreshToken = "refresh_token"
    }
}

struct SupabaseUser: Decodable {
    let id: String
    let email: String?
}

struct SupabaseTokenResponse: Decodable {
    let access_token: String?
    let refresh_token: String?
    let user: SupabaseUser?
    let error: String?
    let error_description: String?
    let msg: String?
    let message: String?
}
