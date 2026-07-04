import Foundation
import os
import Combine

@MainActor
final class AnalyticsService: ObservableObject {
    typealias AccessTokenProvider = () async throws -> String

    private let log = Log.make(for: "AnalyticsService")
    private let api = APIClient()
    private let store = SessionStore.shared
    private let accessTokenProvider: AccessTokenProvider
    private let pendingQueueKey = "nocturne.analyticsPending"
    private let pendingQueueLimit = 200

    @Published var isEnabled: Bool

    init(accessTokenProvider: @escaping AccessTokenProvider) {
        self.accessTokenProvider = accessTokenProvider
        self.isEnabled = SessionStore.shared.analyticsEnabled
    }

    func setEnabled(_ enabled: Bool) {
        isEnabled = enabled
        store.analyticsEnabled = enabled
        log.info("Analytics enabled = \(enabled, privacy: .public)")
    }

    func recordDailyActive(
        deviceSerial: String,
        userId: String?,
        appVersion: String,
        firmwareVersion: String,
        phoneVersion: String = "Connector"
    ) async {
        guard isEnabled else { return }
        guard let userId else {
            log.info("Skipping daily analytics: not authenticated")
            return
        }

        let payload: [String: Any] = [
            "device_serial": deviceSerial,
            "user_id": userId,
            "last_active_date": Self.todayDateString(),
            "app_version": appVersion,
            "device_firmware_version": firmwareVersion,
            "phone_version": phoneVersion,
        ]

        do {
            try await upsertDailyActive(payload)
            log.info("Recorded daily analytics")
        } catch {
            log.warning("Daily analytics failed, queueing: \(error.localizedDescription, privacy: .public)")
            queue(type: "dailyActive", data: payload)
        }
    }

    func trackEvent(
        deviceSerial: String,
        userId: String?,
        eventType: String,
        eventData: [String: Any]? = nil
    ) async {
        guard isEnabled else { return }
        guard let userId else {
            log.info("Skipping event \(eventType, privacy: .public): not authenticated")
            return
        }

        var payload: [String: Any] = [
            "device_serial": deviceSerial,
            "user_id": userId,
            "event_type": eventType,
        ]
        if let eventData {
            payload["event_data"] = eventData
        }

        do {
            try await insertEvent(payload)
            log.info("Tracked event: \(eventType, privacy: .public)")
        } catch {
            log.warning("Event \(eventType, privacy: .public) failed, queueing: \(error.localizedDescription, privacy: .public)")
            queue(type: "event", data: payload)
        }
    }

    func syncPendingAnalytics() async {
        guard isEnabled else { return }

        let pending = loadQueue()
        guard !pending.isEmpty else { return }

        var remaining: [[String: Any]] = []
        var synced = 0
        var dropped = 0

        for item in pending {
            guard let type = item["type"] as? String,
                  let data = item["data"] as? [String: Any],
                  data["user_id"] is String else {
                dropped += 1
                continue
            }

            do {
                if type == "dailyActive" {
                    try await upsertDailyActive(data)
                } else {
                    try await insertEvent(data)
                }
                synced += 1
            } catch {
                let msg = error.localizedDescription.lowercased()
                if msg.contains("unique_device_date") || msg.contains("duplicate key") {
                    synced += 1
                    continue
                }
                if msg.contains("row-level security") || msg.contains("violates row-level") {
                    dropped += 1
                    continue
                }
                log.warning("Sync failed for pending analytic: \(error.localizedDescription, privacy: .public)")
                remaining.append(item)
            }
        }

        saveQueue(remaining)
        if synced > 0 {
            log.info("Synced \(synced, privacy: .public) pending analytics")
        }
        if dropped > 0 {
            log.info("Dropped \(dropped, privacy: .public) unprocessable pending analytics")
        }
    }

    private func authHeaders() async throws -> [String: String] {
        let token = try await accessTokenProvider()
        return [
            "apikey": AppConfig.supabaseAnonKey,
            "Authorization": "Bearer \(token)",
        ]
    }

    private func upsertDailyActive(_ payload: [String: Any]) async throws {
        var comp = URLComponents(
            url: AppConfig.supabaseURL.appendingPathComponent("rest/v1/analytics"),
            resolvingAgainstBaseURL: false
        )!
        comp.queryItems = [
            URLQueryItem(name: "on_conflict", value: "device_serial,last_active_date")
        ]
        let body = try JSONSerialization.data(withJSONObject: payload)
        var headers = try await authHeaders()
        headers["Prefer"] = "resolution=merge-duplicates"
        let (data, http) = try await api.request(comp.url!, method: "POST", headers: headers, body: body)
        guard (200..<300).contains(http.statusCode) else {
            throw HTTPError.status(http.statusCode, String(data: data, encoding: .utf8))
        }
    }

    private func insertEvent(_ payload: [String: Any]) async throws {
        let url = AppConfig.supabaseURL.appendingPathComponent("rest/v1/analytics_events")
        let body = try JSONSerialization.data(withJSONObject: payload)
        let (data, http) = try await api.request(url, method: "POST", headers: try await authHeaders(), body: body)
        guard (200..<300).contains(http.statusCode) else {
            throw HTTPError.status(http.statusCode, String(data: data, encoding: .utf8))
        }
    }

    private func queue(type: String, data: [String: Any]) {
        var queue = loadQueue()
        queue.append([
            "id": UUID().uuidString.replacingOccurrences(of: "-", with: "").lowercased(),
            "type": type,
            "data": data,
            "timestamp": Int(Date().timeIntervalSince1970 * 1000),
        ])
        if queue.count > pendingQueueLimit {
            queue.removeFirst(queue.count - pendingQueueLimit)
        }
        saveQueue(queue)
    }

    private func loadQueue() -> [[String: Any]] {
        guard let data = UserDefaults.standard.data(forKey: pendingQueueKey) else { return [] }
        do {
            let raw = try JSONSerialization.jsonObject(with: data)
            guard let items = raw as? [[String: Any]] else { return [] }
            return items.filter { item in
                guard let type = item["type"] as? String,
                      item["id"] is String,
                      item["data"] is [String: Any] else { return false }
                return type == "dailyActive" || type == "event"
            }
        } catch {
            log.warning("Failed to load pending analytics: \(error.localizedDescription, privacy: .public)")
            return []
        }
    }

    private func saveQueue(_ queue: [[String: Any]]) {
        guard !queue.isEmpty else {
            UserDefaults.standard.removeObject(forKey: pendingQueueKey)
            return
        }
        do {
            let data = try JSONSerialization.data(withJSONObject: queue)
            UserDefaults.standard.set(data, forKey: pendingQueueKey)
        } catch {
            log.warning("Failed to save pending analytics: \(error.localizedDescription, privacy: .public)")
        }
    }

    private static func todayDateString() -> String {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(secondsFromGMT: 0) ?? .gmt
        let components = calendar.dateComponents([.year, .month, .day], from: Date())
        return String(format: "%04d-%02d-%02d", components.year ?? 0, components.month ?? 0, components.day ?? 0)
    }
}
