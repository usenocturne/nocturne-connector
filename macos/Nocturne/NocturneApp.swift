import SwiftUI
import Combine

@main
struct NocturneApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate

    @StateObject private var auth: AuthService
    @StateObject private var spotify: SpotifyService
    @StateObject private var bluetooth: BluetoothService
    @StateObject private var analytics: AnalyticsService
    @StateObject private var rpc: RPCManager
    @StateObject private var loginItem = LoginItemService()

    private let authSpotifySync: AnyCancellable
    private let authAnalyticsSync: AnyCancellable
    private let startsInBackground: Bool

    init() {
        FontLoader.registerBundledFonts()
        let auth = AuthService()
        let spotify = SpotifyService(auth: auth)
        let analytics = AnalyticsService(accessTokenProvider: {
            try await auth.currentAccessToken()
        })
        let rpcManager = RPCManager(
            spotify: spotify,
            analytics: analytics,
            currentUserID: { auth.status.user?.id }
        )
        let bluetooth = BluetoothService()
        bluetooth.rpcManager = rpcManager
        rpcManager.onStaleConnection = { [weak bluetooth] address in
            bluetooth?.teardownStaleLink(address: address)
        }
        _auth = StateObject(wrappedValue: auth)
        _spotify = StateObject(wrappedValue: spotify)
        _bluetooth = StateObject(wrappedValue: bluetooth)
        _analytics = StateObject(wrappedValue: analytics)
        _rpc = StateObject(wrappedValue: rpcManager)

        let background = SessionStore.shared.setupComplete
            && SessionStore.shared.loadSupabaseTokens() != nil
        startsInBackground = background
        AppDelegate.startsInBackground = background

        authSpotifySync = auth.$status
            .map(\.authenticated)
            .removeDuplicates()
            .dropFirst()
            .sink { _ in
                Task { await spotify.checkAuthStatus() }
            }

        authAnalyticsSync = auth.$status
            .map(\.authenticated)
            .removeDuplicates()
            .dropFirst()
            .sink { authenticated in
                guard authenticated else { return }
                Task { await analytics.syncPendingAnalytics() }
            }

        Task {
            await auth.initialize()
        }
    }

    var body: some Scene {
        Window("Nocturne Connector", id: "main") {
            rootContent
                .frame(minWidth: 1280, minHeight: 800)
        }
        .windowStyle(.titleBar)
        .windowToolbarStyle(.unified)
        .defaultLaunchBehavior(startsInBackground ? .suppressed : .automatic)
        .restorationBehavior(startsInBackground ? .disabled : .automatic)
        .commands {
            CommandGroup(replacing: .newItem) {}
        }

        MenuBarExtra {
            MenuBarPanel()
                .environmentObject(bluetooth)
                .environmentObject(rpc)
        } label: {
            MenuBarLabel(appDelegate: appDelegate)
                .environmentObject(bluetooth)
        }
        .menuBarExtraStyle(.window)

        Settings {
            EmptyView()
        }
    }

    private var rootContent: some View {
        RootView()
            .environmentObject(auth)
            .environmentObject(spotify)
            .environmentObject(bluetooth)
            .environmentObject(analytics)
            .environmentObject(rpc)
            .environmentObject(loginItem)
            .onAppear { AppDelegate.mainWindowVisibilityChanged(true) }
            .onDisappear { AppDelegate.mainWindowVisibilityChanged(false) }
    }
}
