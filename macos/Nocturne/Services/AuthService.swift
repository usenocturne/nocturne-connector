import Foundation
import os
import Combine

@MainActor
final class AuthService: ObservableObject {
    private let log = Log.make(for: "AuthService")
    private let api = APIClient()
    private let store = SessionStore.shared

    @Published private(set) var status: AuthStatus = AuthStatus(isInitializing: true)

    private var refreshTimer: Timer?
    private static let refreshInterval: TimeInterval = 30 * 60

    init() {
        status.setupComplete = store.setupComplete
    }

    func initialize() async {
        status.isInitializing = true
        defer { status.isInitializing = false }

        guard let tokens = store.loadSupabaseTokens() else {
            log.info("No persisted Supabase session")
            return
        }

        do {
            try await refresh(with: tokens.refreshToken)
            startRefreshTimer()
        } catch {
            log.warning("Stored session refresh failed: \(error.localizedDescription, privacy: .public)")
            status.authenticated = false
        }
    }

    func pair(code: String) async throws -> NocturneUser {
        let url = AppConfig.nocturneSiteURL.appendingPathComponent("api/pair/redeem")
        let body = try JSONSerialization.data(withJSONObject: ["code": code])
        let (data, http) = try await api.request(url, method: "POST", body: body)

        let decoded = (try? JSONDecoder().decode(PairRedeemResponse.self, from: data)) ?? PairRedeemResponse(access_token: nil, refresh_token: nil, error: nil)

        guard (200..<300).contains(http.statusCode),
              let access = decoded.access_token,
              let refresh = decoded.refresh_token else {
            throw HTTPError.status(http.statusCode, decoded.error ?? String(data: data, encoding: .utf8))
        }

        let tokens = SupabaseTokens(accessToken: access, refreshToken: refresh)
        store.saveSupabaseTokens(tokens)

        let user = try await fetchUser(accessToken: access)
        status.authenticated = true
        status.user = user
        startRefreshTimer()
        return user
    }

    func signOut() async {
        stopRefreshTimer()
        if let tokens = store.loadSupabaseTokens() {
            let url = AppConfig.supabaseURL.appendingPathComponent("auth/v1/logout")
            _ = try? await api.request(
                url,
                method: "POST",
                headers: authHeaders(accessToken: tokens.accessToken),
                body: Data("{}".utf8)
            )
        }
        store.clearSupabaseTokens()
        status.authenticated = false
        status.user = nil
    }

    func deleteAccount() async throws {
        guard let tokens = store.loadSupabaseTokens(), let user = status.user else {
            throw HTTPError.status(401, "Not authenticated")
        }
        let url = AppConfig.supabaseURL.appendingPathComponent("functions/v1/delete-account")
        let body = try JSONSerialization.data(withJSONObject: ["userId": user.id])
        let (data, http) = try await api.request(
            url,
            method: "POST",
            headers: authHeaders(accessToken: tokens.accessToken),
            body: body
        )
        guard (200..<300).contains(http.statusCode) else {
            let msg = (try? JSONSerialization.jsonObject(with: data) as? [String: Any])
                .flatMap { ($0["message"] as? String) ?? ($0["error"] as? String) }
            if http.statusCode == 404 {
                throw HTTPError.status(404, "Account deletion is not yet available. Please try again later.")
            }
            throw HTTPError.status(http.statusCode, msg)
        }
        await signOut()
    }

    func markSetupComplete() {
        store.setupComplete = true
        status.setupComplete = true
    }

    func currentAccessToken() async throws -> String {
        guard let tokens = store.loadSupabaseTokens() else {
            throw HTTPError.status(401, "Not authenticated")
        }
        return tokens.accessToken
    }

    private func startRefreshTimer() {
        stopRefreshTimer()
        let timer = Timer(timeInterval: AuthService.refreshInterval, repeats: true) { [weak self] _ in
            Task { @MainActor in
                guard let self, let tokens = self.store.loadSupabaseTokens() else { return }
                try? await self.refresh(with: tokens.refreshToken)
            }
        }
        RunLoop.main.add(timer, forMode: .common)
        refreshTimer = timer
    }

    private func stopRefreshTimer() {
        refreshTimer?.invalidate()
        refreshTimer = nil
    }

    private func refresh(with refreshToken: String) async throws {
        let url = AppConfig.supabaseURL.appendingPathComponent("auth/v1/token")
        var comp = URLComponents(url: url, resolvingAgainstBaseURL: false)!
        comp.queryItems = [URLQueryItem(name: "grant_type", value: "refresh_token")]
        let body = try JSONSerialization.data(withJSONObject: ["refresh_token": refreshToken])

        let (data, http) = try await api.request(
            comp.url!,
            method: "POST",
            headers: ["apikey": AppConfig.supabaseAnonKey],
            body: body
        )

        let decoded = try JSONDecoder().decode(SupabaseTokenResponse.self, from: data)

        guard (200..<300).contains(http.statusCode),
              let access = decoded.access_token,
              let refresh = decoded.refresh_token else {
            if http.statusCode == 400 || http.statusCode == 401 {
                store.clearSupabaseTokens()
                status.authenticated = false
                status.user = nil
            }
            let msg = decoded.error_description ?? decoded.error ?? decoded.msg ?? decoded.message
            throw HTTPError.status(http.statusCode, msg)
        }

        store.saveSupabaseTokens(SupabaseTokens(accessToken: access, refreshToken: refresh))
        if let u = decoded.user {
            status.user = NocturneUser(id: u.id, email: u.email)
        } else {
            status.user = (try? await fetchUser(accessToken: access))
        }
        status.authenticated = true
    }

    private func fetchUser(accessToken: String) async throws -> NocturneUser {
        let url = AppConfig.supabaseURL.appendingPathComponent("auth/v1/user")
        let (data, http) = try await api.request(
            url,
            method: "GET",
            headers: authHeaders(accessToken: accessToken)
        )
        guard (200..<300).contains(http.statusCode) else {
            throw HTTPError.status(http.statusCode, String(data: data, encoding: .utf8))
        }
        let supaUser = try JSONDecoder().decode(SupabaseUser.self, from: data)
        return NocturneUser(id: supaUser.id, email: supaUser.email)
    }

    private func authHeaders(accessToken: String) -> [String: String] {
        [
            "apikey": AppConfig.supabaseAnonKey,
            "Authorization": "Bearer \(accessToken)"
        ]
    }
}
