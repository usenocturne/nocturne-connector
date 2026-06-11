import AppKit

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    static var startsInBackground = false
    var openMainWindow: (() -> Void)?

    func applicationDidFinishLaunching(_ notification: Notification) {
        if Self.startsInBackground {
            NSApp.setActivationPolicy(.accessory)
        }
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        if !flag {
            openMainWindow?()
        }
        return true
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        false
    }

    static func mainWindowVisibilityChanged(_ visible: Bool) {
        if visible {
            NSApp.setActivationPolicy(.regular)
            DispatchQueue.main.async {
                NSApp.activate()
                NSApp.windows
                    .first { $0.identifier?.rawValue.hasPrefix("main") == true }?
                    .makeKeyAndOrderFront(nil)
            }
        } else {
            NSApp.setActivationPolicy(.accessory)
        }
    }
}
