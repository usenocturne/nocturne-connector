import Foundation
import os

struct SpotifyConnectStateRegistration {
    let deviceID: String
    let connectionID: String
}

enum SpotifyConnectIdentity {
    private static let dealerDeviceIDKey = "com.usenocturne.nocturne.spotify.dealerDeviceID"
    private static let snapshotDeviceIDKey = "com.usenocturne.nocturne.spotify.snapshotDeviceID"
    private static let connectionIDAlphabet = Array("abcdefghijklmnopqrstuvwxyz0123456789")

    static let dealerDeviceID = persistedDeviceID(forKey: dealerDeviceIDKey)
    static let snapshotDeviceID = persistedDeviceID(forKey: snapshotDeviceIDKey)

    static func hobsID(for deviceID: String) -> String {
        "hobs_\(deviceID)"
    }

    static func randomHobsID() -> String {
        hobsID(for: randomHexID())
    }

    static func randomConnectionID() -> String {
        String((0..<148).map { _ in connectionIDAlphabet.randomElement()! })
    }

    private static func persistedDeviceID(forKey key: String) -> String {
        if let existing = UserDefaults.standard.string(forKey: key),
           existing.range(of: "^[0-9a-f]{40}$", options: .regularExpression) != nil {
            return existing
        }
        let new = randomHexID()
        UserDefaults.standard.set(new, forKey: key)
        return new
    }

    private static func randomHexID() -> String {
        (0..<40).map { _ in String(Int.random(in: 0..<16), radix: 16) }.joined()
    }
}

@MainActor
final class SpotifyCore {
    private static let tokenRefreshInterval: TimeInterval = 30 * 60

    struct CachedCredentials {
        let userID: String
        var accessToken: String
        var refreshToken: String
        var scope: String?
        var tokenType: String
        var accessTokenExpiresAt: Date?
    }

    let log = Log.make(for: "SpotifyCore")
    let api = APIClient()
    let storage: SpotifyDatabaseStorage
    private let getUserID: () -> String?

    private(set) var authState: SpotifyAuthState = .idle
    var onAuthState: ((SpotifyAuthState) -> Void)?

    var cachedCredentials: CachedCredentials?
    private var clientToken: String?
    private var clientTokenExpiresAt: Date?
    private var inFlightClientToken: Task<String, Error>?
    private var inFlightRefresh: Task<Void, Error>?
    private var pollingTask: Task<Void, Never>?
    private var tokenRefreshTask: Task<Void, Never>?
    private var authCheckRetryTask: Task<Void, Never>?
    private var authCheckAttempts = 0

    var spclientEndpoint: String?
    var activeDeviceId: String?
    var spotifyUserId: String?
    var connectStateRegistrationProvider: (() -> SpotifyConnectStateRegistration?)?

    init(storage: SpotifyDatabaseStorage, getUserID: @escaping () -> String?) {
        self.storage = storage
        self.getUserID = getUserID
    }

    private func cachedCredentials(from credentials: SpotifyDatabaseCredentials, userID: String) -> CachedCredentials {
        CachedCredentials(
            userID: userID,
            accessToken: credentials.accessToken,
            refreshToken: credentials.refreshToken,
            scope: credentials.scope,
            tokenType: credentials.tokenType,
            accessTokenExpiresAt: credentials.accessTokenExpiresAt
        )
    }

    private func adoptStoredCredentialsIfNewer(_ credentials: SpotifyDatabaseCredentials, userID: String) {
        let stored = cachedCredentials(from: credentials, userID: userID)
        guard let cached = cachedCredentials, cached.userID == userID else {
            cachedCredentials = stored
            return
        }

        let cachedExpiry = cached.accessTokenExpiresAt ?? .distantPast
        if credentials.accessTokenExpiresAt > cachedExpiry {
            cachedCredentials = stored
        }
    }

    func setAuthState(_ state: SpotifyAuthState) {
        authState = state
        if case .linked = state {
            startTokenRefreshTimer()
        } else {
            stopTokenRefreshTimer()
        }
        onAuthState?(state)
    }

    private func startTokenRefreshTimer() {
        stopTokenRefreshTimer()
        tokenRefreshTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: UInt64(Self.tokenRefreshInterval * 1_000_000_000))
                guard let self, !Task.isCancelled else { return }
                do {
                    try await self.refreshToken()
                    self.log.info("Periodic Spotify token refresh succeeded")
                } catch {
                    if error is SpotifyAuthorizationExpiredError {
                        self.log.error("Periodic refresh: Spotify authorization expired; marking unlinked")
                        self.cachedCredentials = nil
                        self.setAuthState(.idle)
                        return
                    }
                    self.log.warning("Periodic Spotify token refresh failed: \(error.localizedDescription, privacy: .public)")
                }
            }
        }
    }

    private func stopTokenRefreshTimer() {
        tokenRefreshTask?.cancel()
        tokenRefreshTask = nil
    }

    func getSpotifyUserId() async -> String? {
        if let spotifyUserId { return spotifyUserId }
        if let profile = try? await handleGetUserProfile() as? [String: Any] {
            let uri = SpotifyJSON.at(profile, "profile", "uri") as? String ?? profile["uri"] as? String
            if let uri { spotifyUserId = uri.split(separator: ":").last.map(String.init) }
            if spotifyUserId == nil {
                spotifyUserId = SpotifyJSON.at(profile, "profile", "username") as? String
                    ?? profile["username"] as? String
            }
        }
        return spotifyUserId
    }

    func checkAuthStatus(forceRefresh: Bool = false) async {
        authCheckRetryTask?.cancel()
        authCheckRetryTask = nil

        guard let userID = getUserID() else {
            authCheckAttempts = 0
            setAuthState(.idle)
            return
        }

        authCheckAttempts += 1
        do {
            let credentials = try await storage.loadCredentials(userID: userID)
            adoptStoredCredentialsIfNewer(credentials, userID: userID)

            let activeExpiresAt = cachedCredentials?.accessTokenExpiresAt ?? credentials.accessTokenExpiresAt
            let needsRefresh = forceRefresh || activeExpiresAt.timeIntervalSinceNow < 300
            if needsRefresh {
                try await refreshToken()
            }

            let displayName = await getSpotifyDisplayName()
            authCheckAttempts = 0
            setAuthState(.linked(displayName: displayName))
        } catch {
            let msg = error.localizedDescription
            if msg.contains("No credentials found") {
                authCheckAttempts = 0
                setAuthState(.idle)
                return
            }
            if error is SpotifyAuthorizationExpiredError
                || msg.contains("Authorization expired") || msg.contains("invalid_grant") {
                authCheckAttempts = 0
                log.error("Auth definitively expired: \(msg, privacy: .public), clearing credentials")
                try? await storage.deleteCredentials(userID: userID)
                cachedCredentials = nil
                setAuthState(.idle)
                return
            }
            if error is SpotifyNotAuthenticatedError {
                authCheckAttempts = 0
                log.warning("Auth check aborted: Supabase user no longer present")
                return
            }

            let attempt = authCheckAttempts
            let maxAttempts = 8
            if attempt >= maxAttempts {
                log.warning("Auth check failed (transient, giving up after \(attempt, privacy: .public) attempts): \(msg, privacy: .public)")
                authCheckAttempts = 0
                return
            }
            let delay = min(60.0, 5.0 * pow(2, Double(min(attempt - 1, 4))))
            log.warning("Auth check failed (transient, attempt \(attempt, privacy: .public)/\(maxAttempts, privacy: .public), retry in \(delay, privacy: .public)s): \(msg, privacy: .public)")
            authCheckRetryTask = Task { [weak self] in
                try? await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000))
                guard let self, !Task.isCancelled else { return }
                self.authCheckRetryTask = nil
                await self.checkAuthStatus()
            }
        }
    }

    func startDeviceAuthorization() async throws {
        setAuthState(.loading)

        let body = formEncode([
            "client_id": SpotifyConstants.spotifyClientID,
            "scope": SpotifyConstants.scopes,
        ])
        let (data, http) = try await api.request(
            URL(string: "\(SpotifyConstants.accountsBase)/oauth2/device/authorize")!,
            method: "POST", body: body, contentType: "application/x-www-form-urlencoded"
        )
        guard (200..<300).contains(http.statusCode), let json = SpotifyJSON.object(data) else {
            setAuthState(.idle)
            throw SpotifyAPIError("Device auth failed: \(http.statusCode)")
        }
        guard let deviceCode = json["device_code"] as? String,
              let userCode = json["user_code"] as? String,
              let verificationUriBase = json["verification_uri"] as? String else {
            setAuthState(.idle)
            throw SpotifyAPIError("Malformed device auth response")
        }
        let verificationUri = json["verification_uri_complete"] as? String
            ?? "\(verificationUriBase)?code=\(userCode)"
        let interval = SpotifyJSON.int(json, "interval") ?? 5

        setAuthState(.polling(
            deviceCode: deviceCode,
            userCode: userCode,
            verificationURI: verificationUri,
            interval: interval
        ))
        startPolling(deviceCode: deviceCode, interval: interval)
    }

    private func startPolling(deviceCode: String, interval: Int) {
        stopPolling()
        pollingTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: UInt64(interval) * 1_000_000_000)
                guard let self, !Task.isCancelled else { return }
                do {
                    if try await self.pollForToken(deviceCode: deviceCode) { return }
                } catch is CancellationError {
                    return
                } catch {
                    if (error as? URLError)?.code == .cancelled { return }
                    self.log.error("Polling error: \(error.localizedDescription, privacy: .public)")
                }
            }
        }
    }

    private func stopPolling() {
        pollingTask?.cancel()
        pollingTask = nil
    }

    private func pollForToken(deviceCode: String) async throws -> Bool {
        let body = formEncode([
            "client_id": SpotifyConstants.spotifyClientID,
            "device_code": deviceCode,
            "grant_type": "urn:ietf:params:oauth:grant-type:device_code",
        ])
        let (data, _) = try await api.request(
            URL(string: "\(SpotifyConstants.accountsBase)/api/token")!,
            method: "POST", body: body, contentType: "application/x-www-form-urlencoded"
        )
        guard let json = SpotifyJSON.object(data) else { return false }

        if let error = json["error"] as? String {
            switch error {
            case "authorization_pending", "slow_down":
                return false
            case "expired_token", "access_denied":
                setAuthState(.idle)
                return true
            default:
                log.error("Spotify device auth error: \(error, privacy: .public)")
                setAuthState(.idle)
                return true
            }
        }

        guard let userID = getUserID(),
              let accessToken = json["access_token"] as? String,
              let refreshToken = json["refresh_token"] as? String,
              let expiresIn = SpotifyJSON.int(json, "expires_in") else {
            log.error("Malformed token response or no user id")
            setAuthState(.idle)
            return true
        }

        let expiresAt = Date().addingTimeInterval(TimeInterval(expiresIn))
        let scope = json["scope"] as? String
        let tokenType = json["token_type"] as? String ?? "Bearer"
        cachedCredentials = CachedCredentials(
            userID: userID,
            accessToken: accessToken,
            refreshToken: refreshToken,
            scope: scope,
            tokenType: tokenType,
            accessTokenExpiresAt: expiresAt
        )
        do {
            try await storage.saveCredentials(
                accessToken: accessToken, refreshToken: refreshToken,
                scope: scope, tokenType: tokenType, expiresAt: expiresAt, userID: userID
            )
        } catch {
            log.warning("Failed to persist Spotify credentials: \(error.localizedDescription, privacy: .public)")
        }

        let displayName = await getSpotifyDisplayName()
        setAuthState(.linked(displayName: displayName))
        return true
    }

    func cancelAuthorization() {
        stopPolling()
        cancelAuthCheckRetry()
        setAuthState(.idle)
    }

    func disconnect() async {
        stopPolling()
        stopTokenRefreshTimer()
        cancelAuthCheckRetry()
        persistRetryTask?.cancel()
        persistRetryTask = nil
        persistGeneration += 1
        if let userID = getUserID() {
            do { try await storage.deleteCredentials(userID: userID) }
            catch { log.warning("Failed to delete credentials: \(error.localizedDescription, privacy: .public)") }
        }
        cachedCredentials = nil
        setAuthState(.idle)
    }

    private func cancelAuthCheckRetry() {
        authCheckRetryTask?.cancel()
        authCheckRetryTask = nil
        authCheckAttempts = 0
    }

    func getValidAccessToken() async throws -> String {
        guard let userID = getUserID() else { throw SpotifyNotAuthenticatedError() }

        if let cached = cachedCredentials, cached.userID == userID,
           let expiresAt = cached.accessTokenExpiresAt,
           expiresAt.timeIntervalSinceNow > 5 * 60 {
            return cached.accessToken
        }

        try await refreshToken()
        guard let cached = cachedCredentials, cached.userID == userID else {
            throw SpotifyAPIError("Failed to refresh token")
        }
        return cached.accessToken
    }

    func refreshToken() async throws {
        if let inFlight = inFlightRefresh {
            try await inFlight.value
            return
        }
        let task = Task { try await self.doRefreshToken() }
        inFlightRefresh = task
        defer { inFlightRefresh = nil }
        try await task.value
    }

    private func doRefreshToken() async throws {
        guard let userID = getUserID() else { throw SpotifyNotAuthenticatedError() }
        var hasRetriedInvalidGrant = false

        while true {
            var storedLoadError: Error?
            do {
                let stored = try await storage.loadCredentials(userID: userID)
                adoptStoredCredentialsIfNewer(stored, userID: userID)
            } catch {
                storedLoadError = error
            }

            var refreshToken: String?
            if let cached = cachedCredentials, cached.userID == userID {
                refreshToken = cached.refreshToken
            }
            if refreshToken == nil {
                if let storedLoadError { throw storedLoadError }
                refreshToken = try await storage.loadCredentials(userID: userID).refreshToken
            }
            guard let currentRefreshToken = refreshToken else {
                throw SpotifyAPIError("No refresh token available")
            }

            let body = formEncode([
                "client_id": SpotifyConstants.spotifyClientID,
                "grant_type": "refresh_token",
                "refresh_token": currentRefreshToken,
            ])

            let maxNetworkRetries = 10
            var result: (Data, HTTPURLResponse)?
            for attempt in 0... {
                do {
                    result = try await api.request(
                        URL(string: "\(SpotifyConstants.accountsBase)/api/token")!,
                        method: "POST", body: body, contentType: "application/x-www-form-urlencoded"
                    )
                    break
                } catch {
                    if attempt >= maxNetworkRetries { throw error }
                    let indeterminate = [URLError.networkConnectionLost, .timedOut]
                        .contains((error as? URLError)?.code)
                    let delay = max(min(pow(2, Double(attempt)), 60), indeterminate ? 10 : 1)
                    log.warning("Token refresh network error (attempt \(attempt + 1, privacy: .public)/\(maxNetworkRetries, privacy: .public)), retrying in \(delay, privacy: .public)s: \(error.localizedDescription, privacy: .public)")
                    try? await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000))
                }
            }
            guard let (data, _) = result, let json = SpotifyJSON.object(data) else {
                throw SpotifyAPIError("Malformed token refresh response")
            }

            if (json["error"] as? String) == "invalid_grant" {
                if !hasRetriedInvalidGrant {
                    hasRetriedInvalidGrant = true
                    do {
                        let stored = try await storage.loadCredentials(userID: userID)
                        if stored.refreshToken == currentRefreshToken {
                            log.error("Got invalid_grant with no newer credentials available - authorization truly expired")
                            throw SpotifyAuthorizationExpiredError()
                        }
                        log.warning("Got invalid_grant; database holds different credentials, retrying with those")
                        cachedCredentials = cachedCredentials(from: stored, userID: userID)
                        continue
                    } catch is SpotifyAuthorizationExpiredError {
                        throw SpotifyAuthorizationExpiredError()
                    } catch {
                        if error.localizedDescription.contains("No credentials found") {
                            log.error("Got invalid_grant and no stored credentials remain - authorization expired")
                            throw SpotifyAuthorizationExpiredError()
                        }
                        log.warning("Got invalid_grant but could not verify stored Spotify credentials; treating as transient: \(error.localizedDescription, privacy: .public)")
                        throw SpotifyAPIError("Spotify refresh rejected, but stored credentials could not be verified")
                    }
                }
                log.error("Got invalid_grant with no newer credentials available - authorization truly expired")
                throw SpotifyAuthorizationExpiredError()
            }
            if let error = json["error"] as? String {
                throw SpotifyAPIError(json["error_description"] as? String ?? error)
            }

            guard let accessToken = json["access_token"] as? String,
                  let expiresIn = SpotifyJSON.int(json, "expires_in") else {
                throw SpotifyAPIError("Malformed token refresh response")
            }
            let expiresAt = Date().addingTimeInterval(TimeInterval(expiresIn))
            let newRefreshToken = json["refresh_token"] as? String ?? currentRefreshToken
            let scope = json["scope"] as? String ?? cachedCredentials?.scope
            let tokenType = json["token_type"] as? String ?? "Bearer"

            cachedCredentials = CachedCredentials(
                userID: userID,
                accessToken: accessToken,
                refreshToken: newRefreshToken,
                scope: scope,
                tokenType: tokenType,
                accessTokenExpiresAt: expiresAt
            )
            persistCachedCredentials()
            return
        }
    }

    private var persistRetryTask: Task<Void, Never>?
    private var persistGeneration = 0

    private func persistCachedCredentials() {
        persistRetryTask?.cancel()
        persistGeneration += 1
        let generation = persistGeneration
        persistRetryTask = Task { @MainActor [weak self] in
            var delay: TimeInterval = 0
            while !Task.isCancelled {
                if delay > 0 {
                    try? await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000))
                }
                guard let self, !Task.isCancelled,
                      self.persistGeneration == generation,
                      let creds = self.cachedCredentials else { return }
                do {
                    try await self.storage.saveCredentials(
                        accessToken: creds.accessToken,
                        refreshToken: creds.refreshToken,
                        scope: creds.scope,
                        tokenType: creds.tokenType,
                        expiresAt: creds.accessTokenExpiresAt ?? Date(),
                        userID: creds.userID
                    )
                    if delay > 0 {
                        self.log.info("Deferred Spotify credential persist succeeded")
                    }
                    return
                } catch {
                    self.log.warning("Persisting Spotify credentials failed (will retry): \(error.localizedDescription, privacy: .public)")
                    delay = min(max(delay * 2, 30), 300)
                }
            }
        }
    }

    func getClientToken() async throws -> String {
        if let token = clientToken, let expires = clientTokenExpiresAt, expires > Date() {
            return token
        }
        if let inFlight = inFlightClientToken {
            return try await inFlight.value
        }
        let task = Task { try await self.fetchClientToken() }
        inFlightClientToken = task
        defer { inFlightClientToken = nil }
        return try await task.value
    }

    private func fetchClientToken() async throws -> String {
        let deviceId = UUID().uuidString.replacingOccurrences(of: "-", with: "").lowercased()
        let payload: [String: Any] = [
            "client_data": [
                "client_version": SpotifyConstants.appVersion,
                "client_id": SpotifyConstants.webPlayerClientID,
                "js_sdk_data": [
                    "device_brand": "Apple",
                    "device_model": "unknown",
                    "os": "macos",
                    "os_version": "10.15.7",
                    "device_id": deviceId,
                    "device_type": "computer",
                ],
            ],
        ]
        let (data, http) = try await api.request(
            URL(string: SpotifyConstants.clientTokenURL)!,
            method: "POST",
            headers: ["Accept": "application/json"],
            body: SpotifyJSON.encode(payload),
            contentType: "application/json"
        )
        guard (200..<300).contains(http.statusCode), let json = SpotifyJSON.object(data) else {
            throw SpotifyAPIError("Failed to get client token")
        }
        guard let token = SpotifyJSON.at(json, "granted_token", "token") as? String else {
            throw SpotifyAPIError("No client token in response")
        }
        let expiresAfter = SpotifyJSON.int(SpotifyJSON.dict(json, "granted_token"), "expires_after_seconds") ?? 3600
        clientToken = token
        clientTokenExpiresAt = Date().addingTimeInterval(TimeInterval(expiresAfter - 60))
        return token
    }

    func performPathfinderRequest(_ operationName: String, hash: String, variables: [String: Any]) async throws -> Any? {
        let accessToken = try await getValidAccessToken()
        let clientToken = try await getClientToken()

        let body: [String: Any] = [
            "operationName": operationName,
            "variables": variables,
            "extensions": ["persistedQuery": ["version": 1, "sha256Hash": hash]],
        ]
        let (data, http) = try await api.request(
            URL(string: SpotifyConstants.pathfinderURL)!,
            method: "POST",
            headers: [
                "Authorization": "Bearer \(accessToken)",
                "Accept": "application/json",
                "app-platform": SpotifyConstants.appPlatform,
                "spotify-app-version": SpotifyConstants.appVersion,
                "User-Agent": SpotifyConstants.userAgent,
                "Origin": "https://open.spotify.com",
                "client-token": clientToken,
            ],
            body: SpotifyJSON.encode(body),
            contentType: "application/json;charset=UTF-8"
        )
        if http.statusCode == 401 { throw SpotifyAPIError("Unauthorized") }
        guard (200..<300).contains(http.statusCode) else {
            throw SpotifyAPIError("Pathfinder request failed: \(http.statusCode)")
        }
        return SpotifyJSON.parse(data)
    }

    func getSpotifyDisplayName() async -> String? {
        do {
            let result = try await performPathfinderRequest(
                "profileAttributes", hash: SpotifyOperationHash.profileAttributes, variables: [:]
            )
            let profile = SpotifyJSON.at(result, "data", "me", "profile") as? [String: Any]
            return profile?["name"] as? String ?? profile?["displayName"] as? String
        } catch {
            log.warning("Failed to fetch profile via Pathfinder: \(error.localizedDescription, privacy: .public)")
            return nil
        }
    }

    var spclientHost: String { spclientEndpoint ?? "gue1-spclient.spotify.com" }

    static func hobsID() -> String {
        SpotifyConnectIdentity.randomHobsID()
    }

    static func randomConnectionID() -> String {
        SpotifyConnectIdentity.randomConnectionID()
    }

    func formEncode(_ params: [String: String]) -> Data {
        var allowed = CharacterSet.alphanumerics
        allowed.insert(charactersIn: "-._~")
        return params
            .map { key, value in
                let k = key.addingPercentEncoding(withAllowedCharacters: allowed) ?? key
                let v = value.addingPercentEncoding(withAllowedCharacters: allowed) ?? value
                return "\(k)=\(v)"
            }
            .joined(separator: "&")
            .data(using: .utf8) ?? Data()
    }

    @discardableResult
    func spclientPOST(_ path: String, payload: [String: Any], accept: Bool = true) async throws -> (Data, HTTPURLResponse) {
        let accessToken = try await getValidAccessToken()
        var headers = ["Authorization": "Bearer \(accessToken)"]
        if accept { headers["Accept"] = "application/json" }
        return try await api.request(
            URL(string: "https://\(spclientHost)\(path)")!,
            method: "POST", headers: headers,
            body: SpotifyJSON.encode(payload), contentType: "application/json"
        )
    }

    func fetchConnectState() async throws -> [String: Any]? {
        let accessToken = try await getValidAccessToken()
        let registration = connectStateRegistrationProvider?()
        let deviceID = registration?.deviceID ?? SpotifyConnectIdentity.snapshotDeviceID
        let connectionID = registration?.connectionID ?? SpotifyConnectIdentity.randomConnectionID()
        let payload: [String: Any] = [
            "member_type": "CONNECT_STATE",
            "device": ["device_info": ["capabilities": [
                "can_be_player": false, "hidden": true, "needs_full_player_state": true,
            ]]],
        ]
        let (data, http) = try await api.request(
            URL(string: "https://\(spclientHost)/connect-state/v1/devices/\(SpotifyConnectIdentity.hobsID(for: deviceID))")!,
            method: "PUT",
            headers: [
                "Authorization": "Bearer \(accessToken)",
                "Accept": "application/json",
                "X-Spotify-Connection-Id": connectionID,
            ],
            body: SpotifyJSON.encode(payload),
            contentType: "application/json"
        )
        guard (200..<300).contains(http.statusCode) else { return nil }
        return SpotifyJSON.object(data)
    }

    func handlePlay(_ params: [String: Any]) async throws -> Any? {
        let contextUri = params["context_uri"] as? String ?? params["contextUri"] as? String
        let uris = params["uris"] as? [String]

        if contextUri == nil, uris == nil {
            return try await simpleSpClientCommand("resume")
        }

        guard let deviceId = params["device_id"] as? String
            ?? params["deviceId"] as? String ?? activeDeviceId else {
            throw SpotifyAPIError("No active device")
        }
        let fromId = Self.hobsID()

        var command: [String: Any] = ["endpoint": "play"]
        if let contextUri {
            command["context"] = ["uri": contextUri, "url": "context://\(contextUri)"]
        }
        if let uris, contextUri == nil {
            if let spotifyUserId = await getSpotifyUserId() {
                let collectionUri = "spotify:user:\(spotifyUserId):collection"
                command["context"] = ["uri": collectionUri, "url": "context://\(collectionUri)"]
                command["options"] = ["skip_to": ["track_uri": uris.first ?? ""]]
            } else {
                command["context"] = ["uri": uris.first ?? "", "url": "context://\(uris.first ?? "")"]
                command["options"] = ["skip_to": ["track_uri": uris.first ?? ""]]
            }
        } else if uris != nil {
            command["play_origin"] = ["feature_identifier": "harmony"]
            command["options"] = ["skip_to": ["track_uri": uris?.first ?? ""]]
        }
        if let offset = params["offset"] as? [String: Any] {
            if let position = SpotifyJSON.int(offset, "position") {
                command["options"] = ["skip_to": ["track_index": position]]
            } else if let uri = offset["uri"] as? String {
                command["options"] = ["skip_to": ["track_uri": uri]]
            }
        }

        let (_, http) = try await spclientPOST(
            "/connect-state/v1/player/command/from/\(fromId)/to/\(deviceId)",
            payload: ["command": command]
        )
        return ["success": (200..<300).contains(http.statusCode) || http.statusCode == 204]
    }

    func handlePause() async throws -> Any? {
        try await simpleSpClientCommand("pause")
    }

    func handleNext(_ params: [String: Any]) async throws -> Any? {
        guard let uid = params["uid"] as? String else {
            return try await simpleSpClientCommand("skip_next")
        }
        guard let deviceId = activeDeviceId else { throw SpotifyAPIError("No active device") }
        let fromId = Self.hobsID()

        var metadata: [String: Any] = ["track_player": "audio"]
        if let contextUri = params["context_uri"] as? String {
            metadata["context_uri"] = contextUri
            metadata["entity_uri"] = contextUri
        }
        let (_, http) = try await spclientPOST(
            "/connect-state/v1/player/command/from/\(fromId)/to/\(deviceId)",
            payload: ["command": [
                "endpoint": "skip_next",
                "track": ["uid": uid, "provider": "context", "metadata": metadata],
            ]]
        )
        return ["success": (200..<300).contains(http.statusCode) || http.statusCode == 204]
    }

    func handlePrevious() async throws -> Any? {
        try await simpleSpClientCommand("skip_prev")
    }

    func handleSeek(_ params: [String: Any]) async throws -> Any? {
        guard let deviceId = params["device_id"] as? String
            ?? params["deviceId"] as? String ?? activeDeviceId else {
            throw SpotifyAPIError("No active device")
        }
        let position = SpotifyJSON.int(params, "position_ms") ?? SpotifyJSON.int(params, "positionMs") ?? 0
        _ = try await spclientPOST(
            "/connect-state/v1/player/command/from/\(deviceId)/to/\(deviceId)",
            payload: ["command": ["endpoint": "seek_to", "value": position]], accept: false
        )
        return ["success": true]
    }

    func handleVolume(_ params: [String: Any]) async throws -> Any? {
        guard let deviceId = params["device_id"] as? String
            ?? params["deviceId"] as? String ?? activeDeviceId else {
            throw SpotifyAPIError("No active device")
        }
        let percent = SpotifyJSON.int(params, "volume_percent") ?? SpotifyJSON.int(params, "volumePercent") ?? 50
        let volume = Int((Double(percent) / 100 * 65535).rounded())
        let accessToken = try await getValidAccessToken()
        _ = try await api.request(
            URL(string: "https://\(spclientHost)/connect-state/v1/connect/volume/from/\(deviceId)/to/\(deviceId)")!,
            method: "PUT",
            headers: ["Authorization": "Bearer \(accessToken)"],
            body: SpotifyJSON.encode(["volume": volume]),
            contentType: "application/json"
        )
        return ["success": true]
    }

    func handleShuffle(_ params: [String: Any]) async throws -> Any? {
        guard let deviceId = params["device_id"] as? String
            ?? params["deviceId"] as? String ?? activeDeviceId else {
            throw SpotifyAPIError("No active device")
        }
        _ = try await spclientPOST(
            "/connect-state/v1/player/command/from/\(deviceId)/to/\(deviceId)",
            payload: ["command": [
                "endpoint": "set_shuffling_context",
                "value": SpotifyJSON.bool(params, "state") ?? false,
            ]], accept: false
        )
        return ["success": true]
    }

    func handleRepeat(_ params: [String: Any]) async throws -> Any? {
        guard let deviceId = params["device_id"] as? String
            ?? params["deviceId"] as? String ?? activeDeviceId else {
            throw SpotifyAPIError("No active device")
        }
        let fromId = Self.hobsID()
        let mode = params["state"] as? String ?? params["mode"] as? String ?? "off"

        func sendCommand(_ endpoint: String, _ value: Bool) async throws {
            _ = try await spclientPOST(
                "/connect-state/v1/player/command/from/\(fromId)/to/\(deviceId)",
                payload: ["command": ["endpoint": endpoint, "value": value]]
            )
        }

        switch mode {
        case "track":
            try await sendCommand("set_repeating_track", true)
        case "context":
            try await sendCommand("set_repeating_context", true)
        default:
            try await sendCommand("set_repeating_track", false)
            try await sendCommand("set_repeating_context", false)
        }
        return ["success": true]
    }

    private func simpleSpClientCommand(_ endpoint: String) async throws -> Any? {
        guard let deviceId = activeDeviceId else { throw SpotifyAPIError("No active device") }
        let fromId = Self.hobsID()
        let (_, http) = try await spclientPOST(
            "/connect-state/v1/player/command/from/\(fromId)/to/\(deviceId)",
            payload: ["command": ["endpoint": endpoint]]
        )
        return ["success": (200..<300).contains(http.statusCode) || http.statusCode == 204]
    }

    func handleGetPlaybackState() async throws -> Any? {
        guard var state = try await fetchConnectState() else { return NSNull() }

        if let active = state["active_device_id"] as? String {
            activeDeviceId = active
        }

        if let trackUri = SpotifyJSON.at(state, "player_state", "track", "uri") as? String,
           trackUri.hasPrefix("spotify:track:") {
            let trackId = String(trackUri.dropFirst("spotify:track:".count))
            if let info = await fetchTrackInfo(trackId),
               var playerState = state["player_state"] as? [String: Any] {
                mergeTrackInfoIntoPlayerState(&playerState, info: info)
                state["player_state"] = playerState
            }
        }

        return transformConnectState(state) ?? NSNull()
    }

    func handleGetDevices() async throws -> Any? {
        guard let state = try await fetchConnectState() else { return ["devices": [:]] }
        let activeDeviceId = state["active_device_id"] as? String
        let rawDevices = state["devices"] as? [String: Any] ?? [:]
        var devices: [String: Any] = [:]

        let deviceStripKeys = [
            "audio_output_device_info", "device_software_version", "metadata_map",
            "public_ip", "spirc_version", "brand", "client_id",
        ]
        let capabilityStripKeys = [
            "command_acks", "gaia_eq_connect_id", "supports_dj", "supports_external_episodes",
            "supports_gzip_pushes", "supports_hifi", "supports_logout", "supports_ping_request",
            "supports_playlist_v2", "supports_rename", "supports_set_backend_metadata",
            "supports_set_options_command", "supported_types",
        ]
        for (id, raw) in rawDevices {
            guard var device = raw as? [String: Any] else { continue }
            for key in deviceStripKeys { device.removeValue(forKey: key) }
            if var capabilities = device["capabilities"] as? [String: Any] {
                for key in capabilityStripKeys { capabilities.removeValue(forKey: key) }
                device["capabilities"] = capabilities
            }
            devices[id] = device
        }

        if let activeDeviceId { self.activeDeviceId = activeDeviceId }
        var result: [String: Any] = ["devices": devices]
        if let activeDeviceId { result["active_device_id"] = activeDeviceId }
        return result
    }

    func handleTransferPlayback(_ params: [String: Any]) async throws -> Any? {
        let deviceIds = (params["deviceIds"] as? [String] ?? params["device_ids"] as? [String] ?? [])
            .filter { !$0.isEmpty }
        guard let targetId = deviceIds.first ?? activeDeviceId else {
            throw SpotifyAPIError("No target device")
        }
        let play = SpotifyJSON.bool(params, "play") ?? false
        let (_, http) = try await spclientPOST(
            "/connect-state/v1/connect/transfer/from/_/to/\(targetId)",
            payload: ["transfer_options": ["restore_paused": play ? "restore" : "keep"]]
        )
        return ["success": (200..<300).contains(http.statusCode) || http.statusCode == 204]
    }

    func handleGetQueue() async throws -> Any? {
        guard let state = try await fetchConnectState() else { return ["queue": []] }

        let nextTracks = SpotifyJSON.at(state, "player_state") .flatMap { ($0 as? [String: Any])?["next_tracks"] as? [[String: Any]] } ?? []
        let trackEntries = nextTracks
            .compactMap { t -> (uri: String, uid: String?)? in
                guard let uri = t["uri"] as? String, uri.hasPrefix("spotify:track:") else { return nil }
                return (uri, t["uid"] as? String)
            }
            .prefix(10)

        var queue: [[String: Any]] = []
        for trackEntry in trackEntries {
            guard let track = try? await fetchTrackDetails(trackEntry.uri) else {
                log.warning("Failed to fetch details for queue track \(trackEntry.uri, privacy: .public)")
                continue
            }
            var entry: [String: Any] = [
                "uri": track["uri"] ?? trackEntry.uri,
                "name": track["name"] ?? "",
                "explicit": track["explicit"] ?? false,
            ]
            if let uid = trackEntry.uid { entry["uid"] = uid }
            if let album = track["album"] as? [String: Any] {
                if let name = album["name"] { entry["album_name"] = name }
                if let uri = album["uri"] { entry["album_uri"] = uri }
                if let images = album["images"] as? [[String: Any]],
                   let small = images.first(where: { SpotifyJSON.int($0, "height") == 64 }),
                   let url = small["url"] {
                    entry["image_url"] = url
                }
            }
            if let artists = track["artists"] as? [[String: Any]],
               let artistUri = artists.first?["uri"] {
                entry["artist_uri"] = artistUri
            }
            queue.append(entry)
        }
        return ["queue": queue]
    }

    func handleAddToQueue(_ params: [String: Any]) async throws -> Any? {
        guard let uri = params["uri"] as? String else { throw SpotifyAPIError("Missing uri parameter") }

        var targetDeviceId = activeDeviceId
        if targetDeviceId == nil {
            let devicesResult = try await handleGetDevices() as? [String: Any]
            targetDeviceId = devicesResult?["active_device_id"] as? String
                ?? (devicesResult?["devices"] as? [String: Any])?.keys.first
            guard targetDeviceId != nil else { throw SpotifyAPIError("No playback devices available") }
        }

        let fromId = Self.hobsID()
        let commandId = (0..<16).map { _ in String(format: "%02x", Int.random(in: 0..<256)) }.joined()
        let (_, http) = try await spclientPOST(
            "/connect-state/v1/player/command/from/\(fromId)/to/\(targetDeviceId!)",
            payload: ["command": [
                "endpoint": "add_to_queue",
                "track": ["uri": uri, "metadata": ["is_queued": "true"], "provider": "queue"],
                "logging_params": ["command_id": commandId],
            ]]
        )
        guard (200..<300).contains(http.statusCode) else {
            throw SpotifyAPIError("Add to queue failed: \(http.statusCode)")
        }
        return ["success": true]
    }

    func handleSetPlaybackSpeed(_ params: [String: Any]) async throws -> Any? {
        let deviceId = params["device_id"] as? String ?? params["deviceId"] as? String ?? "unknown"
        let speed = params["speed"] ?? NSNull()
        _ = try await spclientPOST(
            "/connect-state/v1/player/command/from/\(deviceId)/to/\(deviceId)",
            payload: ["command": ["playback_speed": speed, "endpoint": "set_options"]], accept: false
        )
        return ["success": true, "speed": speed]
    }

    func handleDjStart(_ params: [String: Any]) async throws -> Any? {
        let deviceId = params["device_id"] as? String ?? params["deviceId"] as? String ?? "unknown"
        let djUri = "spotify:playlist:37i9dQZF1EYkqdzj48dyYq"
        _ = try await spclientPOST(
            "/connect-state/v1/player/command/from/\(deviceId)/to/\(deviceId)",
            payload: ["command": [
                "endpoint": "play",
                "context": [
                    "entity_uri": djUri,
                    "uri": djUri,
                    "url": "hm://lexicon-session-provider/context-resolve/v2/session?contextUri=\(djUri)",
                ],
            ]], accept: false
        )
        return ["success": true]
    }

    func handleDjSignal(_ params: [String: Any]) async throws -> Any? {
        let deviceId = params["device_id"] as? String ?? params["deviceId"] as? String ?? "unknown"
        _ = try await spclientPOST(
            "/connect-state/v1/player/command/from/\(deviceId)/to/\(deviceId)",
            payload: ["command": ["endpoint": "signal", "signal_id": "jump"]], accept: false
        )
        return ["success": true]
    }

    func transformConnectState(_ state: [String: Any]?) -> [String: Any]? {
        guard let state, let ps = state["player_state"] as? [String: Any],
              let track = ps["track"] as? [String: Any],
              let trackUri = track["uri"] as? String else {
            return nil
        }

        let metadata = track["metadata"] as? [String: Any] ?? [:]
        let trackId = trackUri.split(separator: ":").last.map(String.init) ?? ""

        var imageUrl: String?
        let rawImage = metadata["image_url"] as? String
            ?? metadata["image_xlarge_url"] as? String
            ?? metadata["image_large_url"] as? String
        if let rawImage {
            imageUrl = rawImage.hasPrefix("spotify:image:")
                ? "https://i.scdn.co/image/" + rawImage.dropFirst("spotify:image:".count)
                : rawImage
        }

        var artists: [Any] = []
        if let metaArtists = metadata["artists"] as? [Any], !metaArtists.isEmpty {
            artists = metaArtists
        } else {
            let artistName = metadata["artist_name"] as? String
                ?? metadata["album_artist_name"] as? String
                ?? metadata["artist"] as? String ?? ""
            if !artistName.isEmpty {
                let artistUri = metadata["artist_uri"] as? String ?? ""
                artists = [[
                    "id": artistUri.split(separator: ":").last.map(String.init) ?? "",
                    "name": artistName,
                    "uri": artistUri,
                    "type": "artist",
                ]]
            }
        }

        let albumUri = metadata["album_uri"] as? String ?? ""
        let album: [String: Any] = [
            "id": albumUri.split(separator: ":").last.map(String.init) ?? "",
            "name": metadata["album_title"] as? String ?? "",
            "artists": [Any](),
            "images": imageUrl.map { [["url": $0, "height": 300, "width": 300]] } ?? [[String: Any]](),
            "uri": albumUri,
        ]

        let durationMs = SpotifyJSON.int(ps, "duration")
            ?? SpotifyJSON.int(metadata, "duration")
            ?? SpotifyJSON.int(metadata, "duration_ms") ?? 0
        let progressMs = SpotifyJSON.int(ps, "position_as_of_timestamp")
        let timestamp = SpotifyJSON.int(ps, "timestamp") ?? Int(Date().timeIntervalSince1970 * 1000)

        let options = ps["options"] as? [String: Any] ?? [:]
        let shuffleState = SpotifyJSON.bool(options, "shuffling_context") ?? false
        var repeatState = "off"
        if SpotifyJSON.bool(options, "repeating_track") == true { repeatState = "track" }
        else if SpotifyJSON.bool(options, "repeating_context") == true { repeatState = "context" }

        var device: Any = NSNull()
        if let activeDeviceId = state["active_device_id"] as? String,
           let d = (state["devices"] as? [String: Any])?[activeDeviceId] as? [String: Any] {
            let volume = SpotifyJSON.int(d, "volume")
            device = [
                "id": activeDeviceId,
                "is_active": true,
                "is_private_session": false,
                "name": d["name"] as? String ?? "Unknown Device",
                "type": d["device_type"] as? String ?? "Unknown",
                "volume_percent": volume.map { Int((Double($0) / 65535 * 100).rounded()) } as Any,
            ] as [String: Any]
        }

        var context: Any = NSNull()
        if let contextUri = ps["context_uri"] as? String {
            let parts = contextUri.split(separator: ":")
            context = ["type": parts.count >= 2 ? String(parts[1]) : "", "uri": contextUri]
        }

        return [
            "device": device,
            "shuffle_state": shuffleState,
            "repeat_state": repeatState,
            "timestamp": timestamp,
            "progress_ms": progressMs as Any,
            "is_playing": !(SpotifyJSON.bool(ps, "is_paused") ?? true),
            "item": [
                "type": "track",
                "id": trackId,
                "name": metadata["title"] as? String ?? "",
                "artists": artists,
                "album": album,
                "duration_ms": durationMs,
                "uri": trackUri,
            ] as [String: Any],
            "context": context,
        ]
    }
}
