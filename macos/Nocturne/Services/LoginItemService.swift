import Foundation
import AppKit
import Combine
import ServiceManagement
import os

@MainActor
final class LoginItemService: ObservableObject {
    private let log = Log.make(for: "LoginItemService")

    @Published private(set) var status: SMAppService.Status = SMAppService.mainApp.status
    @Published private(set) var lastError: String? = nil

    private static let configuredKey = "loginItemConfigured"

    var isEnabled: Bool { status == .enabled }
    var needsApproval: Bool { status == .requiresApproval }

    init() {
        registerByDefaultIfNeeded()
        refresh()
        NotificationCenter.default.addObserver(
            forName: NSApplication.didBecomeActiveNotification, object: nil, queue: .main
        ) { _ in
            Task { @MainActor [weak self] in self?.refresh() }
        }
    }

    func refresh() {
        let current = SMAppService.mainApp.status
        if current != status {
            status = current
        }
    }

    func setEnabled(_ enabled: Bool) {
        UserDefaults.standard.set(true, forKey: Self.configuredKey)
        lastError = nil
        do {
            if enabled {
                if SMAppService.mainApp.status != .enabled {
                    try SMAppService.mainApp.register()
                }
            } else {
                try SMAppService.mainApp.unregister()
            }
        } catch {
            log.error("Login item \(enabled ? "register" : "unregister", privacy: .public) failed: \(error.localizedDescription, privacy: .public)")
            lastError = error.localizedDescription
        }
        refresh()
    }

    func openLoginItemsSettings() {
        SMAppService.openSystemSettingsLoginItems()
    }

    private func registerByDefaultIfNeeded() {
        let status = SMAppService.mainApp.status
        log.info("Login item status at launch: \(status.rawValue, privacy: .public)")
        guard !UserDefaults.standard.bool(forKey: Self.configuredKey) else { return }
        UserDefaults.standard.set(true, forKey: Self.configuredKey)
        guard status != .enabled && status != .requiresApproval else { return }
        do {
            try SMAppService.mainApp.register()
            log.info("Registered as a login item (first-run default)")
        } catch {
            log.warning("Default login-item registration failed: \(error.localizedDescription, privacy: .public)")
        }
    }
}
