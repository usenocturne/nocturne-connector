import Foundation

enum SpotifyConstants {
    static let supabaseURL = "https://sb.usenocturne.com"
    static let supabaseAnonKey = "sb_publishable_8Sce2-p3DlCRTpOc7WXCuH_PXVQbLoR"

    static let spotifyClientID = "65b708073fc0480ea92a077233ca87bd"
    static let webPlayerClientID = "d8a5ed958d274c2e8ee717e6a4b0971d"

    static let scopes = [
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
        "user-top-read",
    ].joined(separator: " ")

    static let userAgent =
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36"
    static let appPlatform = "WebPlayer"
    static let appVersion = "1.2.80.313.gd1726b65"

    static let accountsBase = "https://accounts.spotify.com"
    static let apiBase = "https://api.spotify.com/v1"
    static let spClientBase = "https://gue1-spclient.spotify.com"
    static let pathfinderURL = "https://api-partner.spotify.com/pathfinder/v2/query"
    static let dealerURL = "wss://gue1-dealer.spotify.com/"
    static let clientTokenURL = "https://clienttoken.spotify.com/v1/clienttoken"
    static let webTokenURL = "https://open.spotify.com/api/token"
}

enum SpotifyOperationHash {
    static let profileAttributes = "53bcb064f6cd18c23f752bc324a791194d20df612d8e1239c735144ab0399ced"
    static let getAlbum = "b9bfabef66ed756e5e13f68a942deb60bd4125ec1f1be8cc42769dc0259b4b10"
    static let getTrack = "612585ae06ba435ad26369870deaae23b5c8800a256cd8a57e08eddc25a37294"
    static let queryArtistOverview = "446130b4a0aa6522a686aafccddb0ae849165b5e0436fd802f96e0243617b5d8"
    static let fetchPlaylist = "bb67e0af06e8d6f52b531f97468ee4acd44cd0f82b988e15c2ea47b1148efc77"
    static let queryShowMetadataV2 = "26d0c98fef216dad02d31c359075c07d605974af8d82834f26e90f917f32555a"
    static let queryPodcastEpisodes = "8e2826c5993383566cc08bf9f5d3301b69513c3f6acb8d706286855e57bf44b2"
    static let libraryV3 = "9f4da031f81274d572cfedaf6fc57a737c84b43d572952200b2c36aaa8fec1c6"
    static let fetchLibraryTracks = "087278b20b743578a6262c2b0b4bcd20d879c503cc359a2285baf083ef944240"
    static let areEntitiesInLibrary = "134337999233cc6fdd6b1e6dbf94841409f04a946c5c7b744b09ba0dfe5a85ed"
    static let addToLibrary = "7c5a69420e2bfae3da5cc4e14cbc8bb3f6090f80afc00ffc179177f19be3f33d"
    static let removeFromLibrary = "7c5a69420e2bfae3da5cc4e14cbc8bb3f6090f80afc00ffc179177f19be3f33d"
    static let internalLinkRecommenderTrack = "c77098ee9d6ee8ad3eb844938722db60570d040b49f41f5ec6e7be9160a7c86b"
    static let userTopContent = "49ee15704de4a7fdeac65a02db20604aa11e46f02e809c55d9a89f6db9754356"
    static let homeSection = "c11ff5d8f508cb1a3dad3f15ee80611cda7df7e6fb45212e466fb3e84a680bf9"
    static let searchDesktop = "21b3fe49546912ba782db5c47e9ef5a7dbd20329520ba0c7d0fcfadee671d24e"
}
