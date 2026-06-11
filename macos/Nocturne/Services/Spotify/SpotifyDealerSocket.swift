import Foundation
import os

struct SpotifyNotAuthenticatedError: LocalizedError {
    let message: String
    init(_ message: String = "Not authenticated") { self.message = message }
    var errorDescription: String? { message }
}

struct SpotifyAuthorizationExpiredError: LocalizedError {
    let message: String
    init(_ message: String = "Spotify authorization expired") { self.message = message }
    var errorDescription: String? { message }
}

private func isTerminalAuthError(_ error: Error) -> Bool {
    error is SpotifyNotAuthenticatedError || error is SpotifyAuthorizationExpiredError
}

@MainActor
final class SpotifyDealerSocket {
    private let log = Log.make(for: "SpotifyDealerSocket")

    var onPlayerEvent: (([String: Any]) -> Void)?
    var onConnectionStateChange: ((Bool) -> Void)?
    var onError: ((Error) -> Void)?

    private let getAccessToken: () async throws -> String
    private let setSpclientEndpoint: (String) -> Void

    private var ws: URLSessionWebSocketTask?
    private var session: URLSession

    private var dealerEndpoint: String?
    private(set) var spclientEndpoint: String?
    private(set) var connectionId: String?
    private(set) var isConnected = false
    private var isConnecting = false
    private var hasReceivedConnectionId = false
    private var shouldMaintainConnection = true
    private var isIntentionalDisconnect = false
    private var reconnectAttempts = 0
    private let reconnectBaseDelay: Double = 1.0
    private let reconnectMaxDelay: Double = 60.0
    private var generation = 0

    private var pingTask: Task<Void, Never>?
    private var reconnectTask: Task<Void, Never>?
    private var healthCheckTask: Task<Void, Never>?
    private var tokenRefreshTask: Task<Void, Never>?
    private var receiveTask: Task<Void, Never>?
    private var lastMessageTime = Date()
    private var lastPlayerEventTime: Date?
    private let connectionTimeout: TimeInterval = 180
    private let playerEventStaleTimeout: TimeInterval = 90
    private let tokenRefreshInterval: TimeInterval = 50 * 60

    init(
        getAccessToken: @escaping () async throws -> String,
        setSpclientEndpoint: @escaping (String) -> Void
    ) {
        self.getAccessToken = getAccessToken
        self.setSpclientEndpoint = setSpclientEndpoint
        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = 30
        self.session = URLSession(configuration: config)
    }

    private func resolveEndpoints() async throws -> (dealer: String, spclient: String) {
        if let dealer = dealerEndpoint, let spclient = spclientEndpoint {
            return (dealer, spclient)
        }
        let url = URL(string: "https://apresolve.spotify.com/?type=dealer-g2&type=spclient")!
        let (data, response) = try await session.data(from: url)
        guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode),
              let json = SpotifyJSON.object(data) else {
            throw SpotifyAPIError("Failed to resolve endpoints")
        }
        let dealerArray = (json["dealer-g2"] as? [String]) ?? (json["dealer"] as? [String]) ?? []
        let spclientArray = (json["spclient"] as? [String]) ?? []
        guard let dealerRaw = dealerArray.first, let spclientRaw = spclientArray.first else {
            throw SpotifyAPIError("Missing dealer or spclient endpoints")
        }
        let dealer = String(dealerRaw.split(separator: ":")[0])
        let spclient = String(spclientRaw.split(separator: ":")[0])
        dealerEndpoint = dealer
        spclientEndpoint = spclient
        setSpclientEndpoint(spclient)
        return (dealer, spclient)
    }

    func connect() async throws {
        if isConnected || isConnecting { return }

        isConnecting = true
        shouldMaintainConnection = true
        hasReceivedConnectionId = false

        do {
            let (dealer, _) = try await resolveEndpoints()
            let accessToken = try await getAccessToken()

            if !shouldMaintainConnection || isIntentionalDisconnect {
                isConnecting = false
                return
            }

            if let existing = ws {
                existing.cancel(with: .normalClosure, reason: nil)
                ws = nil
            }
            receiveTask?.cancel()

            guard let url = URL(string: "wss://\(dealer)/?access_token=\(accessToken)") else {
                isConnecting = false
                throw SpotifyAPIError("Invalid dealer URL")
            }

            let task = session.webSocketTask(with: url)
            ws = task
            task.resume()

            let now = Date()
            isConnected = true
            isConnecting = false
            reconnectAttempts = 0
            lastMessageTime = now
            lastPlayerEventTime = now
            onConnectionStateChange?(true)
            startPingTimer()
            startHealthCheck()
            startTokenRefreshTimer()
            startReceiveLoop(task)
        } catch {
            isConnecting = false
            throw error
        }
    }

    private func startReceiveLoop(_ task: URLSessionWebSocketTask) {
        receiveTask?.cancel()
        receiveTask = Task { [weak self] in
            while !Task.isCancelled {
                do {
                    let message = try await task.receive()
                    guard let self, self.ws === task else { return }
                    self.lastMessageTime = Date()
                    switch message {
                    case .string(let text):
                        self.handleMessage(text)
                    case .data(let data):
                        if let text = String(data: data, encoding: .utf8) {
                            self.handleMessage(text)
                        }
                    @unknown default:
                        break
                    }
                } catch {
                    guard let self, self.ws === task else { return }
                    if !self.isIntentionalDisconnect {
                        self.log.error("WebSocket error: \(error.localizedDescription, privacy: .public)")
                        self.handleConnectionError(SpotifyAPIError("Connection closed"))
                    }
                    return
                }
            }
        }
    }

    func disconnect() {
        generation += 1
        shouldMaintainConnection = false
        isIntentionalDisconnect = true
        stopPingTimer()
        stopReconnectTimer()
        stopHealthCheck()
        stopTokenRefreshTimer()
        receiveTask?.cancel()
        receiveTask = nil

        if let task = ws {
            task.cancel(with: .normalClosure, reason: nil)
            ws = nil
        }

        isConnected = false
        isConnecting = false
        hasReceivedConnectionId = false
        connectionId = nil
        lastPlayerEventTime = nil
        reconnectAttempts = 0
        onConnectionStateChange?(false)

        Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: 100_000_000)
            self?.isIntentionalDisconnect = false
        }
    }

    private func handleMessage(_ text: String) {
        guard let json = SpotifyJSON.parse(Data(text.utf8)) as? [String: Any] else {
            log.error("Failed to parse WebSocket message")
            return
        }

        if !hasReceivedConnectionId {
            if let headers = json["headers"] as? [String: Any],
               let connId = headers["Spotify-Connection-Id"] as? String {
                connectionId = connId
                hasReceivedConnectionId = true
                Task { [weak self] in
                    do { try await self?.registerDevice() }
                    catch { self?.log.error("Device registration failed: \(error.localizedDescription, privacy: .public)") }
                }
                onPlayerEvent?(json)
                return
            }
        }

        if (json["type"] as? String) == "pong" { return }

        if json["payloads"] != nil {
            lastPlayerEventTime = Date()
            onPlayerEvent?(json)
        }
    }

    private func registerDevice() async throws {
        guard let connectionId, let spclientEndpoint else { return }

        let accessToken = try await getAccessToken()
        let deviceId = (0..<40).map { _ in String(Int.random(in: 0..<16), radix: 16) }.joined()
        let hobsId = "hobs_\(deviceId)"

        var request = URLRequest(url: URL(string: "https://\(spclientEndpoint)/connect-state/v1/devices/\(hobsId)")!)
        request.httpMethod = "PUT"
        request.setValue("Bearer \(accessToken)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue(connectionId, forHTTPHeaderField: "X-Spotify-Connection-Id")
        request.httpBody = SpotifyJSON.encode([
            "member_type": "CONNECT_STATE",
            "device": [
                "device_info": [
                    "capabilities": [
                        "can_be_player": false,
                        "hidden": true,
                        "needs_full_player_state": true,
                    ]
                ]
            ],
        ])

        let (_, response) = try await session.data(for: request)
        if let http = response as? HTTPURLResponse,
           !(200..<300).contains(http.statusCode), http.statusCode != 204 {
            log.error("Device registration failed: \(http.statusCode, privacy: .public)")
        }
    }

    private func startPingTimer() {
        stopPingTimer()
        pingTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 10_000_000_000)
                guard let self, !Task.isCancelled else { return }
                if let task = self.ws, task.state == .running {
                    task.send(.string("{\"type\":\"ping\"}")) { [log = self.log] error in
                        if let error {
                            log.warning("Ping send failed: \(error.localizedDescription, privacy: .public)")
                        }
                    }
                }
            }
        }
    }

    private func stopPingTimer() {
        pingTask?.cancel()
        pingTask = nil
    }

    private func startHealthCheck() {
        stopHealthCheck()
        healthCheckTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 30_000_000_000)
                guard let self, !Task.isCancelled, self.isConnected else { continue }
                let now = Date()
                if now.timeIntervalSince(self.lastMessageTime) > self.connectionTimeout {
                    self.log.warning("Connection stale, reconnecting...")
                    do { try await self.reconnect() }
                    catch { self.log.error("Stale reconnect failed: \(error.localizedDescription, privacy: .public)") }
                    continue
                }
                if let lastEvent = self.lastPlayerEventTime,
                   now.timeIntervalSince(lastEvent) > self.playerEventStaleTimeout {
                    self.log.warning("Dealer alive but no player events received, reconnecting...")
                    do { try await self.reconnect() }
                    catch { self.log.error("Player-event reconnect failed: \(error.localizedDescription, privacy: .public)") }
                }
            }
        }
    }

    private func stopHealthCheck() {
        healthCheckTask?.cancel()
        healthCheckTask = nil
    }

    private func startTokenRefreshTimer() {
        stopTokenRefreshTimer()
        tokenRefreshTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: UInt64((self?.tokenRefreshInterval ?? 3000) * 1_000_000_000))
            guard let self, !Task.isCancelled else { return }
            guard self.isConnected, self.shouldMaintainConnection else { return }
            self.log.info("Token refresh interval reached, reconnecting with fresh token...")
            do {
                try await self.reconnect()
            } catch {
                if isTerminalAuthError(error) {
                    self.log.warning("Token-refresh reconnect aborted (auth lost). Disconnecting.")
                    self.disconnect()
                } else {
                    self.log.error("Token-refresh reconnect failed: \(error.localizedDescription, privacy: .public)")
                    if self.shouldMaintainConnection { self.scheduleReconnect() }
                }
            }
        }
    }

    private func stopTokenRefreshTimer() {
        tokenRefreshTask?.cancel()
        tokenRefreshTask = nil
    }

    private func handleConnectionError(_ error: Error) {
        if isIntentionalDisconnect { return }

        isConnected = false
        isConnecting = false
        hasReceivedConnectionId = false
        stopPingTimer()
        stopHealthCheck()
        stopTokenRefreshTimer()

        onError?(error)
        onConnectionStateChange?(false)

        if shouldMaintainConnection {
            scheduleReconnect()
        }
    }

    private func scheduleReconnect() {
        stopReconnectTimer()
        reconnectAttempts += 1
        let baseDelay = min(reconnectBaseDelay * pow(2, Double(reconnectAttempts - 1)), reconnectMaxDelay)
        let jitter = 0.5 + Double.random(in: 0..<0.5)
        let delay = baseDelay * jitter

        log.info("Scheduling reconnect attempt \(self.reconnectAttempts, privacy: .public) in \(String(format: "%.1f", delay), privacy: .public)s")

        reconnectTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000))
            guard let self, !Task.isCancelled else { return }
            guard self.shouldMaintainConnection, !self.isConnected else { return }
            do {
                try await self.connect()
            } catch {
                self.log.error("Reconnect attempt \(self.reconnectAttempts, privacy: .public) failed: \(error.localizedDescription, privacy: .public)")
                if isTerminalAuthError(error) {
                    self.log.warning("Reconnect aborted: auth lost. Stopping reconnect loop.")
                    self.disconnect()
                } else if self.shouldMaintainConnection {
                    self.scheduleReconnect()
                }
            }
        }
    }

    private func stopReconnectTimer() {
        reconnectTask?.cancel()
        reconnectTask = nil
    }

    func reconnect() async throws {
        disconnect()
        let cancelGen = generation
        reconnectAttempts = 0
        try? await Task.sleep(nanoseconds: 100_000_000)
        if generation != cancelGen {
            log.info("Reconnect cancelled: disconnected externally during reconnect window")
            return
        }
        isIntentionalDisconnect = false
        shouldMaintainConnection = true
        try await connect()
    }
}
