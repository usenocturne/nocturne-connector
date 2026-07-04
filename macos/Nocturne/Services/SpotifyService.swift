import Foundation
import Combine
import os
import AppKit

@MainActor
final class SpotifyService: ObservableObject, SpotifyCommandHandling {
    private let log = Log.make(for: "SpotifyService")

    @Published private(set) var authState: SpotifyAuthState = .idle

    var onDeviceBroadcast: ((String, Any) -> Void)?

    private let auth: AuthService
    private let core: SpotifyCore
    private let registry: SpotifyCommandRegistry
    private let dealer: SpotifyDealerSocket
    private(set) var cachedPlayerState: [String: Any]?
    private var cachedPlayerStateAt: Date?
    private var wakeObserver: NSObjectProtocol?

    init(auth: AuthService) {
        self.auth = auth
        let getUserID: () -> String? = {
            SessionStore.shared.loadSupabaseTokens()
                .flatMap { SpotifyCredentialCrypto.userID(fromJWT: $0.accessToken) }
        }
        let storage = SpotifyDatabaseStorage(accessTokenProvider: { forceRefresh in
            try await auth.validAccessToken(forceRefresh: forceRefresh)
        })
        let core = SpotifyCore(storage: storage, getUserID: getUserID)
        self.core = core
        self.registry = SpotifyCommandRegistry(core: core)
        let dealer = SpotifyDealerSocket(
            getAccessToken: { try await core.getValidAccessToken() },
            setSpclientEndpoint: { core.spclientEndpoint = $0 }
        )
        self.dealer = dealer
        core.connectStateRegistrationProvider = { [weak dealer] in
            dealer?.connectStateRegistration
        }

        dealer.onPlayerEvent = { [weak self] event in
            self?.handleDealerEvent(event)
        }
        dealer.onConnectionStateChange = { [weak self] connected in
            self?.log.info("Spotify dealer WebSocket \(connected ? "connected" : "disconnected", privacy: .public)")
        }
        core.onAuthState = { [weak self] state in
            guard let self else { return }
            self.authState = state
            if case .linked = state {
                Task { [weak self] in
                    do { try await self?.dealer.connect() }
                    catch { self?.log.error("WebSocket connect failed: \(error.localizedDescription, privacy: .public)") }
                }
            } else {
                self.dealer.disconnect()
            }
        }

        wakeObserver = NSWorkspace.shared.notificationCenter.addObserver(
            forName: NSWorkspace.didWakeNotification, object: nil, queue: .main
        ) { _ in
            Task { @MainActor [weak self] in
                await self?.recoverAfterWake()
            }
        }
    }

    deinit {
        if let wakeObserver {
            NSWorkspace.shared.notificationCenter.removeObserver(wakeObserver)
        }
    }

    var isSpotifyLinked: Bool {
        if case .linked = authState { return true }
        return false
    }

    func startDeviceAuthorization() async throws {
        try await core.startDeviceAuthorization()
    }

    func cancelAuthorization() {
        core.cancelAuthorization()
    }

    func disconnect() async {
        dealer.disconnect()
        await core.disconnect()
    }

    func getAccessToken() async -> String? {
        try? await core.getValidAccessToken()
    }

    func checkAuthStatus() async {
        await core.checkAuthStatus()
    }

    func recoverAfterWake() async {
        log.info("Mac woke; reconciling Spotify auth and Dealer socket")
        await auth.recoverAfterWake()
        await core.checkAuthStatus(forceRefresh: true)
        guard isSpotifyLinked else { return }
        await dealer.recoverAfterWake()
    }

    func supports(_ method: String) -> Bool {
        registry.supports(method)
    }

    func dispatch(_ method: String, params: [String: Any]) async throws -> Any? {
        if method == "spotify.player.state" {
            do {
                let result = try await registry.dispatch(method, params: params)
                if Self.hasUsablePlaybackItem(result) {
                    return result
                }
                return cachedPlaybackSnapshot() ?? result
            } catch {
                if error is SpotifyNotAuthenticatedError || error is SpotifyAuthorizationExpiredError {
                    throw error
                }
                if let cached = cachedPlaybackSnapshot() {
                    return cached
                }
                throw error
            }
        }
        return try await registry.dispatch(method, params: params)
    }

    private func handleDealerEvent(_ event: [String: Any]) {
        guard let (topic, data) = SpotifyFilters.cleanupWebSocketMessage(event) else { return }
        Task { [weak self] in
            guard let self else { return }
            var payload = data
            if var dict = payload as? [String: Any] {
                await self.enrichTrackMetadata(&dict)
                payload = dict
            }
            self.cachePlayerState(payload)
            self.onDeviceBroadcast?(topic, payload)
        }
    }

    private func cachePlayerState(_ data: Any) {
        guard let payloads = (data as? [String: Any])?["payloads"] as? [Any],
              let cluster = (payloads.first as? [String: Any])?["cluster"] as? [String: Any] else { return }
        if cluster["player_state"] != nil {
            cachedPlayerState = cluster
            cachedPlayerStateAt = Date()
        }
        if let activeDeviceId = cluster["active_device_id"] as? String {
            core.activeDeviceId = activeDeviceId
        }
    }

    private func cachedPlaybackSnapshot(maxAge: TimeInterval = 180) -> Any? {
        guard let cachedPlayerState,
              let cachedPlayerStateAt,
              Date().timeIntervalSince(cachedPlayerStateAt) <= maxAge else { return nil }
        let transformed = core.transformConnectState(cachedPlayerState)
        return Self.hasUsablePlaybackItem(transformed) ? transformed : nil
    }

    private static func hasUsablePlaybackItem(_ value: Any?) -> Bool {
        guard let playback = value as? [String: Any],
              let item = playback["item"] as? [String: Any],
              let uri = item["uri"] as? String,
              !uri.isEmpty else { return false }
        let name = (item["name"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return !name.isEmpty
    }

    private func enrichTrackMetadata(_ data: inout [String: Any]) async {
        guard var payloads = data["payloads"] as? [Any],
              var firstPayload = payloads.first as? [String: Any],
              var cluster = firstPayload["cluster"] as? [String: Any],
              var playerState = cluster["player_state"] as? [String: Any],
              var track = playerState["track"] as? [String: Any],
              let uri = track["uri"] as? String else { return }

        var metadata = track["metadata"] as? [String: Any] ?? [:]
        var hasArtists = (metadata["artists"] as? [Any])?.isEmpty == false

        if uri.hasPrefix("spotify:track:") {
            let trackId = String(uri.dropFirst("spotify:track:".count))
            if let info = await core.fetchTrackInfo(trackId) {
                core.mergeTrackInfoIntoPlayerState(&playerState, info: info)
                track = playerState["track"] as? [String: Any] ?? track
                metadata = track["metadata"] as? [String: Any] ?? metadata
                hasArtists = (metadata["artists"] as? [Any])?.isEmpty == false
            }
        } else if uri.hasPrefix("spotify:local:") {
            let parts = uri.split(separator: ":", omittingEmptySubsequences: false)
            if parts.count >= 5, !hasArtists {
                let decoded = (String(parts[2]).removingPercentEncoding ?? String(parts[2]))
                    .replacingOccurrences(of: "+", with: " ")
                let names = decoded.split(separator: ",")
                    .map { $0.trimmingCharacters(in: .whitespaces) }
                    .filter { !$0.isEmpty }
                if !names.isEmpty {
                    metadata["artists"] = names.map {
                        ["id": "", "name": $0, "uri": "", "type": "artist"]
                    }
                    track["metadata"] = metadata
                    playerState["track"] = track
                    hasArtists = true
                }
            }
        }

        if !hasArtists,
           let albumUri = metadata["album_uri"] as? String,
           albumUri.hasPrefix("spotify:album:") {
            let albumId = String(albumUri.dropFirst("spotify:album:".count))
            if let artists = try? await core.fetchAlbumArtists(albumId), !artists.isEmpty {
                metadata["artists"] = artists
                track["metadata"] = metadata
                playerState["track"] = track
            }
        }

        cluster["player_state"] = playerState
        firstPayload["cluster"] = cluster
        payloads[0] = firstPayload
        data["payloads"] = payloads
    }
}
