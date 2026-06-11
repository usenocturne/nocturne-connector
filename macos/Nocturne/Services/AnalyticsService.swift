import Foundation
import os
import Combine

@MainActor
final class AnalyticsService: ObservableObject {
    private let log = Log.make(for: "AnalyticsService")
    private let store = SessionStore.shared

    @Published var isEnabled: Bool

    init() {
        self.isEnabled = SessionStore.shared.analyticsEnabled
    }

    func setEnabled(_ enabled: Bool) {
        isEnabled = enabled
        store.analyticsEnabled = enabled
        log.info("Analytics enabled = \(enabled, privacy: .public)")
    }
}
