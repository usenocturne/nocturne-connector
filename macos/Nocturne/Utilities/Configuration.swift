import Foundation

enum AppConfig {
    static let supabaseURL = URL(string: "https://qrrtjdmdclkpssjzhzhw.supabase.co")!
    static let supabaseAnonKey = "sb_publishable_sUnSM7qjeWn6rcI9x_fmWg_VJddosT-"

    static let spotifyClientID = "06b976f397ee4ce8a78dc511976a3baf"

    static let nocturneSiteURL = URL(string: "https://main-nocturne-site.vantalabs.workers.dev/")!
    static let otaServerURL = URL(string: "https://ota.usenocturne.com")!

    static let rfcommUUID = "00001101-0000-1000-8000-00805f9b34fb"

    static let spotifyScopes: [String] = [
        "app-remote-control",
        "playlist-modify-private",
        "playlist-modify-public",
        "playlist-read-collaborative",
        "playlist-read-private",
        "streaming",
        "ugc-image-upload",
        "user-follow-modify",
        "user-follow-read",
        "user-library-modify",
        "user-library-read",
        "user-modify-playback-state",
        "user-read-currently-playing",
        "user-read-email",
        "user-read-playback-position",
        "user-read-playback-state",
        "user-read-private",
        "user-read-recently-played",
        "user-top-read"
    ]

    static var connectorVersion: String {
        let info = Bundle.main.infoDictionary ?? [:]
        return (info["CFBundleShortVersionString"] as? String) ?? "1.0.0"
    }

    static var osVersion: String {
        let v = ProcessInfo.processInfo.operatingSystemVersion
        return "macOS \(v.majorVersion).\(v.minorVersion).\(v.patchVersion)"
    }
}
