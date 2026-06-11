import Foundation
import CryptoKit
import CommonCrypto

struct SpotifyDatabaseCredentials {
    let accessToken: String
    let refreshToken: String
    let scope: String?
    let tokenType: String
    let accessTokenExpiresAt: Date
}

final class SpotifyDatabaseStorage {
    private let api = APIClient()
    private let accessTokenProvider: () -> String?

    init(accessTokenProvider: @escaping () -> String?) {
        self.accessTokenProvider = accessTokenProvider
    }

    private var restBase: String { SpotifyConstants.supabaseURL + "/rest/v1/spotify_credentials" }

    private func headers() throws -> [String: String] {
        guard let token = accessTokenProvider() else {
            throw SpotifyAPIError("Not authenticated with Supabase")
        }
        return [
            "apikey": SpotifyConstants.supabaseAnonKey,
            "Authorization": "Bearer \(token)",
        ]
    }

    func saveCredentials(
        accessToken: String,
        refreshToken: String,
        scope: String?,
        tokenType: String,
        expiresAt: Date,
        userID: String
    ) async throws {
        let payload: [String: Any] = [
            "user_id": userID,
            "access_token": try SpotifyCredentialCrypto.encrypt(accessToken, userID: userID),
            "refresh_token": try SpotifyCredentialCrypto.encrypt(refreshToken, userID: userID),
            "scope": scope ?? "",
            "token_type": tokenType,
            "access_token_expires_at": SpotifyCredentialCrypto.isoFormatter.string(from: expiresAt),
        ]
        var hdrs = try headers()
        hdrs["Prefer"] = "resolution=merge-duplicates"
        let url = URL(string: restBase + "?on_conflict=user_id")!
        let (data, http) = try await api.request(
            url, method: "POST", headers: hdrs,
            body: SpotifyJSON.encode(payload), contentType: "application/json"
        )
        guard (200..<300).contains(http.statusCode) else {
            throw SpotifyAPIError("Database error: \(String(data: data, encoding: .utf8) ?? "HTTP \(http.statusCode)")")
        }
    }

    func loadCredentials(userID: String) async throws -> SpotifyDatabaseCredentials {
        try await withThrowingTaskGroup(of: SpotifyDatabaseCredentials.self) { group in
            group.addTask { try await self.queryCredentials(userID: userID) }
            group.addTask {
                try await Task.sleep(nanoseconds: 10_000_000_000)
                throw SpotifyAPIError("Database query timeout after 10 seconds")
            }
            guard let first = try await group.next() else {
                throw SpotifyAPIError("No credentials found")
            }
            group.cancelAll()
            return first
        }
    }

    private func queryCredentials(userID: String) async throws -> SpotifyDatabaseCredentials {
        var comp = URLComponents(string: restBase)!
        comp.queryItems = [
            URLQueryItem(name: "select", value: "*"),
            URLQueryItem(name: "user_id", value: "eq.\(userID)"),
        ]
        let (data, http) = try await api.request(comp.url!, headers: try headers())
        guard (200..<300).contains(http.statusCode) else {
            throw SpotifyAPIError("Database error: \(String(data: data, encoding: .utf8) ?? "HTTP \(http.statusCode)")")
        }
        guard let rows = SpotifyJSON.parse(data) as? [[String: Any]], let row = rows.first else {
            throw SpotifyAPIError("No credentials found")
        }
        guard let encAccess = row["access_token"] as? String,
              let encRefresh = row["refresh_token"] as? String,
              let expiresAtRaw = row["access_token_expires_at"] as? String else {
            throw SpotifyAPIError("Malformed credentials row")
        }
        guard let expiresAt = SpotifyCredentialCrypto.parseISO(expiresAtRaw) else {
            throw SpotifyAPIError("Invalid expiration date format")
        }
        let scope = (row["scope"] as? String).flatMap { $0.isEmpty ? nil : $0 }
        return SpotifyDatabaseCredentials(
            accessToken: try SpotifyCredentialCrypto.decrypt(encAccess, userID: userID),
            refreshToken: try SpotifyCredentialCrypto.decrypt(encRefresh, userID: userID),
            scope: scope,
            tokenType: (row["token_type"] as? String) ?? "Bearer",
            accessTokenExpiresAt: expiresAt
        )
    }

    func deleteCredentials(userID: String) async throws {
        var comp = URLComponents(string: restBase)!
        comp.queryItems = [URLQueryItem(name: "user_id", value: "eq.\(userID)")]
        let (data, http) = try await api.request(comp.url!, method: "DELETE", headers: try headers())
        guard (200..<300).contains(http.statusCode) else {
            throw SpotifyAPIError("Database error: \(String(data: data, encoding: .utf8) ?? "HTTP \(http.statusCode)")")
        }
    }
}

enum SpotifyCredentialCrypto {
    private static let appSalt = "com.usenocturne.Nocturne.encryption.v1"
    private static let iterations: UInt32 = 100_000
    private static let keyLength = 32
    private static let ivLength = 12
    private static let tagLength = 16

    static let isoFormatter: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()

    static func parseISO(_ s: String) -> Date? {
        if let d = isoFormatter.date(from: s) { return d }
        let plain = ISO8601DateFormatter()
        plain.formatOptions = [.withInternetDateTime]
        return plain.date(from: s)
    }

    private static func deriveKey(userID: String) throws -> SymmetricKey {
        let salt = Data((appSalt + userID).utf8)
        let password = Data(userID.utf8)
        var derived = Data(count: keyLength)
        let status = derived.withUnsafeMutableBytes { derivedPtr in
            salt.withUnsafeBytes { saltPtr in
                password.withUnsafeBytes { passPtr in
                    CCKeyDerivationPBKDF(
                        CCPBKDFAlgorithm(kCCPBKDF2),
                        passPtr.baseAddress?.assumingMemoryBound(to: Int8.self), password.count,
                        saltPtr.baseAddress?.assumingMemoryBound(to: UInt8.self), salt.count,
                        CCPseudoRandomAlgorithm(kCCPRFHmacAlgSHA256),
                        iterations,
                        derivedPtr.baseAddress?.assumingMemoryBound(to: UInt8.self), keyLength
                    )
                }
            }
        }
        guard status == kCCSuccess else { throw SpotifyAPIError("Key derivation failed") }
        return SymmetricKey(data: derived)
    }

    static func encrypt(_ plaintext: String, userID: String) throws -> String {
        let key = try deriveKey(userID: userID)
        let nonce = AES.GCM.Nonce()
        let sealed = try AES.GCM.seal(Data(plaintext.utf8), using: key, nonce: nonce)
        var combined = Data(nonce)
        combined.append(sealed.ciphertext)
        combined.append(sealed.tag)
        return combined.base64EncodedString()
    }

    static func decrypt(_ ciphertext: String, userID: String) throws -> String {
        let key = try deriveKey(userID: userID)
        guard let combined = Data(base64Encoded: ciphertext),
              combined.count >= ivLength + tagLength else {
            throw SpotifyAPIError("Invalid encrypted data format")
        }
        let nonce = try AES.GCM.Nonce(data: combined.prefix(ivLength))
        let tag = combined.suffix(tagLength)
        let encrypted = combined.dropFirst(ivLength).dropLast(tagLength)
        let box = try AES.GCM.SealedBox(nonce: nonce, ciphertext: encrypted, tag: tag)
        let decrypted = try AES.GCM.open(box, using: key)
        guard let text = String(data: decrypted, encoding: .utf8) else {
            throw SpotifyAPIError("Decryption produced invalid UTF-8")
        }
        return text
    }

    static func userID(fromJWT token: String) -> String? {
        let parts = token.split(separator: ".")
        guard parts.count >= 2 else { return nil }
        var payload = String(parts[1])
            .replacingOccurrences(of: "-", with: "+")
            .replacingOccurrences(of: "_", with: "/")
        while payload.count % 4 != 0 { payload += "=" }
        guard let data = Data(base64Encoded: payload),
              let obj = SpotifyJSON.object(data) else { return nil }
        return obj["sub"] as? String
    }
}
