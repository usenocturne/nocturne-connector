import Foundation

enum AppConfig {
    static let supabaseURL = URL(string: "https://sb.usenocturne.com")!
    static let supabaseAnonKey = "sb_publishable_8Sce2-p3DlCRTpOc7WXCuH_PXVQbLoR"

    static let spotifyClientID = "65b708073fc0480ea92a077233ca87bd"

    static let nocturneSiteURL = URL(string: "https://usenocturne.com/")!
    static let otaServerURL = URL(string: "https://ota.usenocturne.com")!

    static let rfcommUUID = "00001101-0000-1000-8000-00805f9b34fb"

    static let spotifyScopes: [String] = [
        "app-remote-control",
        "playlist-modify",
        "playlist-modify-private",
        "playlist-modify-public",
        "playlist-read",
        "playlist-read-collaborative",
        "playlist-read-private",
        "streaming",
        "ugc-image-upload",
        "user-follow-modify",
        "user-follow-read",
        "user-library-modify",
        "user-library-read",
        "user-modify",
        "user-modify-playback-state",
        "user-modify-private",
        "user-personalized",
        "user-read-birthdate",
        "user-read-currently-playing",
        "user-read-email",
        "user-read-play-history",
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
