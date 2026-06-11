import Foundation

extension SpotifyCore {
    struct SpotifyTrackInfo {
        let uri: String
        let id: String
        let title: String?
        let artistName: String?
        let artists: [[String: Any]]
        let albumTitle: String?
        let albumUri: String?
        let imageUrl: String?
        let durationMs: Int?
    }

    private func contentId(_ params: [String: Any]) -> String {
        params["content_id"] as? String
            ?? params["contentId"] as? String
            ?? params["id"] as? String ?? ""
    }

    private func entityUri(_ id: String, type: String) -> String {
        id.hasPrefix("spotify:") ? id : "spotify:\(type):\(id)"
    }

    private func uriTail(_ uri: String?) -> String {
        (uri ?? "").split(separator: ":").last.map(String.init) ?? ""
    }

    private func imageSources(_ value: Any?) -> [[String: Any]] {
        (value as? [[String: Any]] ?? []).map {
            ["url": $0["url"] ?? "", "height": $0["height"] ?? 0, "width": $0["width"] ?? 0]
        }
    }

    func fetchTrackArtists(_ trackId: String) async -> [[String: Any]] {
        await fetchTrackInfo(trackId)?.artists ?? []
    }

    func fetchTrackInfo(_ trackId: String) async -> SpotifyTrackInfo? {
        if let info = try? await fetchTrackInfoFromMetadata(trackId),
           info.title != nil || !info.artists.isEmpty {
            return info
        }
        if let info = try? await fetchTrackInfoFromGraphQL(trackId),
           info.title != nil || !info.artists.isEmpty {
            return info
        }
        return nil
    }

    private func fetchTrackInfoFromMetadata(_ trackId: String) async throws -> SpotifyTrackInfo? {
        let accessToken = try await getValidAccessToken()
        let hexId = try SpotifyBase62.base62ToHex(trackId)
        let (data, http) = try await api.request(
            URL(string: "https://\(spclientHost)/metadata/4/track/\(hexId)?market=from_token")!,
            headers: ["Authorization": "Bearer \(accessToken)", "Accept": "application/json"]
        )
        guard (200..<300).contains(http.statusCode), let json = SpotifyJSON.object(data) else {
            throw SpotifyAPIError("metadata request failed: \(http.statusCode)")
        }

        let artists: [[String: Any]] = (json["artist"] as? [[String: Any]] ?? []).map { a in
            let gid = a["gid"] as? String ?? ""
            let id = gid.isEmpty ? "" : SpotifyBase62.hexToBase62(gid)
            return [
                "id": id,
                "name": a["name"] as? String ?? "",
                "uri": id.isEmpty ? "" : "spotify:artist:\(id)",
                "type": "artist",
            ]
        }
        let names = artists.compactMap { $0["name"] as? String }.filter { !$0.isEmpty }
        let artistName = names.isEmpty ? nil : names.joined(separator: ", ")

        let album = json["album"] as? [String: Any]
        let albumTitle = album?["name"] as? String
        let albumUri = (album?["gid"] as? String).map { "spotify:album:\(SpotifyBase62.hexToBase62($0))" }

        var imageUrl: String?
        if let images = SpotifyJSON.at(album, "cover_group", "image") as? [[String: Any]] {
            let withFileId = images.filter { $0["file_id"] is String }
            let picked = withFileId.max { (SpotifyJSON.int($0, "width") ?? 0) < (SpotifyJSON.int($1, "width") ?? 0) }
                ?? withFileId.first
            if let fileId = picked?["file_id"] as? String {
                imageUrl = "https://i.scdn.co/image/\(fileId.lowercased())"
            }
        }

        var durationMs = SpotifyJSON.int(json, "duration")
        if let d = durationMs, d <= 0 { durationMs = nil }

        return SpotifyTrackInfo(
            uri: "spotify:track:\(trackId)",
            id: trackId,
            title: json["name"] as? String,
            artistName: artistName,
            artists: artists,
            albumTitle: albumTitle,
            albumUri: albumUri,
            imageUrl: imageUrl,
            durationMs: durationMs
        )
    }

    private func fetchTrackInfoFromGraphQL(_ trackId: String) async throws -> SpotifyTrackInfo? {
        let result = try await performPathfinderRequest(
            "getTrack", hash: SpotifyOperationHash.getTrack,
            variables: ["uri": "spotify:track:\(trackId)"]
        )
        guard let trackUnion = SpotifyJSON.at(result, "data", "trackUnion") as? [String: Any] else {
            return nil
        }

        let items = SpotifyJSON.at(trackUnion, "artists", "items") as? [[String: Any]] ?? []
        let artists: [[String: Any]] = items.map { a in
            let uri = a["uri"] as? String ?? ""
            return [
                "id": uriTail(uri),
                "name": SpotifyJSON.at(a, "profile", "name") as? String ?? "",
                "uri": uri,
                "type": "artist",
            ]
        }
        let names = artists.compactMap { $0["name"] as? String }.filter { !$0.isEmpty }
        let artistName = names.isEmpty ? nil : names.joined(separator: ", ")

        let albumOfTrack = trackUnion["albumOfTrack"] as? [String: Any]
        let albumTitle = albumOfTrack?["name"] as? String
        let albumUri = albumOfTrack?["uri"] as? String

        var imageUrl: String?
        if let sources = SpotifyJSON.at(albumOfTrack, "coverArt", "sources") as? [[String: Any]] {
            let withUrls = sources.filter { ($0["url"] as? String)?.isEmpty == false }
            let largest = withUrls.max { (SpotifyJSON.int($0, "width") ?? 0) < (SpotifyJSON.int($1, "width") ?? 0) }
            imageUrl = largest?["url"] as? String
        }

        var durationMs: Int?
        if let dur = trackUnion["duration"] as? [String: Any] {
            durationMs = SpotifyJSON.int(dur, "totalMilliseconds")
        } else {
            durationMs = SpotifyJSON.int(trackUnion, "duration")
        }

        return SpotifyTrackInfo(
            uri: trackUnion["uri"] as? String ?? "spotify:track:\(trackId)",
            id: trackId,
            title: trackUnion["name"] as? String,
            artistName: artistName,
            artists: artists,
            albumTitle: albumTitle,
            albumUri: albumUri,
            imageUrl: imageUrl,
            durationMs: durationMs
        )
    }

    func mergeTrackInfoIntoPlayerState(_ playerState: inout [String: Any], info: SpotifyTrackInfo) {
        if var track = playerState["track"] as? [String: Any] {
            var meta = track["metadata"] as? [String: Any] ?? [:]
            if let title = info.title, meta["title"] == nil { meta["title"] = title }
            if let artistName = info.artistName, meta["artist_name"] == nil { meta["artist_name"] = artistName }
            if !info.artists.isEmpty, (meta["artists"] as? [Any])?.isEmpty != false {
                meta["artists"] = info.artists
            }
            if let albumTitle = info.albumTitle, meta["album_title"] == nil { meta["album_title"] = albumTitle }
            if let albumUri = info.albumUri, meta["album_uri"] == nil { meta["album_uri"] = albumUri }
            if let imageUrl = info.imageUrl, meta["image_url"] == nil { meta["image_url"] = imageUrl }
            if let durationMs = info.durationMs, meta["duration"] == nil { meta["duration"] = String(durationMs) }
            track["metadata"] = meta
            playerState["track"] = track
        }
        if let durationMs = info.durationMs, playerState["duration"] == nil {
            playerState["duration"] = String(durationMs)
        }
    }

    func fetchTrackDetails(_ trackUri: String) async throws -> [String: Any]? {
        let result = try await performPathfinderRequest(
            "getTrack", hash: SpotifyOperationHash.getTrack, variables: ["uri": trackUri]
        )
        guard let trackUnion = SpotifyJSON.at(result, "data", "trackUnion") as? [String: Any] else {
            return nil
        }

        var entry: [String: Any] = ["uri": trackUri]
        entry["name"] = trackUnion["name"] as? String ?? ""
        entry["explicit"] = (SpotifyJSON.at(trackUnion, "contentRating", "label") as? String) == "EXPLICIT"

        if let albumData = trackUnion["albumOfTrack"] as? [String: Any] {
            var album: [String: Any] = [:]
            if let uri = albumData["uri"] as? String {
                album["uri"] = uri
                album["id"] = uriTail(uri)
            }
            if let name = albumData["name"] { album["name"] = name }
            if let sources = SpotifyJSON.at(albumData, "coverArt", "sources") {
                album["images"] = imageSources(sources)
            }
            entry["album"] = album
        }
        if let artistItems = SpotifyJSON.at(trackUnion, "artists", "items") as? [[String: Any]] {
            entry["artists"] = flattenArtists(artistItems)
        }
        return entry
    }

    func fetchAlbumArtists(_ albumId: String) async throws -> [[String: Any]] {
        let result = try await performPathfinderRequest(
            "getAlbum", hash: SpotifyOperationHash.getAlbum,
            variables: ["uri": "spotify:album:\(albumId)", "locale": "", "offset": 0, "limit": 1]
        )
        guard let items = SpotifyJSON.at(result, "data", "albumUnion", "artists", "items") as? [[String: Any]] else {
            return []
        }
        return items.map { a in
            let uri = a["uri"] as? String ?? ""
            return [
                "id": uriTail(uri),
                "name": SpotifyJSON.at(a, "profile", "name") as? String ?? "",
                "uri": uri,
                "type": "artist",
            ]
        }
    }

    func handleGetUserPlaylists(_ params: [String: Any]) async throws -> Any? {
        let offset = SpotifyJSON.int(params, "offset") ?? 0
        let limit = SpotifyJSON.int(params, "limit") ?? 50
        let result = try await performPathfinderRequest(
            "libraryV3", hash: SpotifyOperationHash.libraryV3,
            variables: [
                "filters": ["Playlists"],
                "order": NSNull(),
                "textFilter": "",
                "features": ["LIKED_SONGS", "YOUR_EPISODES_V2", "PRERELEASES", "EVENTS"],
                "limit": limit, "offset": offset,
                "flatten": true,
                "expandedFolders": [Any](),
                "folderUri": NSNull(),
                "includeFoldersWhenFlattening": false,
            ]
        )
        guard let lib = SpotifyJSON.at(result, "data", "me", "libraryV3") as? [String: Any],
              let rawItems = lib["items"] as? [[String: Any]] else {
            return ["items": [], "total": 0, "offset": offset, "limit": limit]
        }

        var playlists: [[String: Any]] = []
        for entry in rawItems {
            guard let data = SpotifyJSON.at(entry, "item", "data") as? [String: Any] else { continue }
            let typename = data["__typename"] as? String
            guard typename == "Playlist" || typename == "PseudoPlaylist" else { continue }
            let uri = data["uri"] as? String ?? SpotifyJSON.at(entry, "item", "_uri") as? String ?? ""
            var playlist: [String: Any] = [
                "uri": uri,
                "id": uriTail(uri),
                "name": data["name"] as? String ?? "",
            ]
            if typename == "PseudoPlaylist" {
                playlist["tracks"] = ["total": SpotifyJSON.int(data, "count") ?? 0]
            }
            if let o = SpotifyJSON.at(data, "ownerV2", "data") as? [String: Any] {
                playlist["owner"] = [
                    "display_name": o["name"] ?? "",
                    "id": o["id"] as? String ?? uriTail(o["uri"] as? String),
                    "uri": o["uri"] ?? "",
                ]
            }
            if let imageItems = SpotifyJSON.at(data, "images", "items") as? [[String: Any]] {
                playlist["images"] = imageItems.compactMap { img -> [String: Any]? in
                    let sources = img["sources"] as? [[String: Any]]
                    let src = sources?.first { SpotifyJSON.int($0, "height") == 300 } ?? sources?.first
                    guard let src else { return nil }
                    return ["url": src["url"] ?? "", "height": src["height"] ?? 0, "width": src["width"] ?? 0]
                }
            }
            playlists.append(playlist)
        }

        for i in playlists.indices where playlists[i]["tracks"] == nil {
            if let id = playlists[i]["id"] as? String,
               let count = try? await fetchPlaylistTrackCount(id) {
                playlists[i]["tracks"] = ["total": count]
            }
        }

        let filteredOut = rawItems.count - playlists.count
        let adjustedTotal = max((SpotifyJSON.int(lib, "totalCount") ?? playlists.count) - filteredOut, playlists.count)
        return ["items": playlists, "total": adjustedTotal, "offset": offset, "limit": limit]
    }

    private func fetchPlaylistTrackCount(_ playlistId: String) async throws -> Int {
        let result = try await performPathfinderRequest(
            "fetchPlaylist", hash: SpotifyOperationHash.fetchPlaylist,
            variables: [
                "uri": "spotify:playlist:\(playlistId)",
                "offset": 0, "limit": 0,
                "enableWatchFeedEntrypoint": false,
            ]
        )
        return SpotifyJSON.int(SpotifyJSON.at(result, "data", "playlistV2", "content") as? [String: Any], "totalCount") ?? 0
    }

    func handleGetSavedTracks(_ params: [String: Any]) async throws -> Any? {
        let offset = SpotifyJSON.int(params, "offset") ?? 0
        let limit = SpotifyJSON.int(params, "limit") ?? 50
        let mockingbird = SpotifyJSON.bool(params, "mockingbird") ?? false
        let result = try await performPathfinderRequest(
            "fetchLibraryTracks", hash: SpotifyOperationHash.fetchLibraryTracks,
            variables: ["offset": offset, "limit": limit]
        )
        guard let tracks = SpotifyJSON.at(result, "data", "me", "library", "tracks") as? [String: Any] else {
            return ["items": [], "total": 0, "offset": offset, "limit": limit]
        }
        let items: [[String: Any]] = (tracks["items"] as? [[String: Any]] ?? []).compactMap { item in
            guard let trackData = SpotifyJSON.at(item, "track", "data") as? [String: Any] else { return nil }
            var track = transformTrackResponse(trackData)
            if (track["uri"] as? String)?.isEmpty != false,
               let fallbackUri = SpotifyJSON.at(item, "track", "_uri") as? String {
                track["uri"] = fallbackUri
                track["id"] = uriTail(fallbackUri)
            }
            if mockingbird {
                if let album = track["album"] as? [String: Any] {
                    track["album"] = slimAlbum(album)
                }
            } else {
                track.removeValue(forKey: "album")
            }
            return ["track": track]
        }
        return filterResponse([
            "items": items,
            "total": SpotifyJSON.int(tracks, "totalCount") ?? items.count,
            "offset": offset, "limit": limit,
        ])
    }

    private func slimAlbum(_ album: [String: Any]) -> [String: Any] {
        var slim: [String: Any] = [:]
        if let name = album["name"] { slim["name"] = name }
        if let uri = album["uri"] { slim["uri"] = uri }
        if let images = album["images"] as? [[String: Any]],
           let small = images.first(where: { SpotifyJSON.int($0, "height") == 64 }),
           let url = small["url"] {
            slim["image_url"] = url
        }
        return slim
    }

    func handleGetSavedShows(_ params: [String: Any]) async throws -> Any? {
        let offset = SpotifyJSON.int(params, "offset") ?? 0
        let limit = SpotifyJSON.int(params, "limit") ?? 50
        let result = try await performPathfinderRequest(
            "libraryV3", hash: SpotifyOperationHash.libraryV3,
            variables: [
                "filters": ["Podcasts & Shows"],
                "order": NSNull(),
                "textFilter": "",
                "features": ["LIKED_SONGS", "YOUR_EPISODES_V2", "PRERELEASES", "EVENTS"],
                "limit": limit, "offset": offset,
                "flatten": false,
                "expandedFolders": [Any](),
                "folderUri": NSNull(),
                "includeFoldersWhenFlattening": true,
            ]
        )
        guard let lib = SpotifyJSON.at(result, "data", "me", "libraryV3") as? [String: Any],
              let rawItems = lib["items"] as? [[String: Any]] else {
            return ["items": [], "total": 0, "offset": offset, "limit": limit]
        }
        let items: [[String: Any]] = rawItems.compactMap { entry in
            guard let data = SpotifyJSON.at(entry, "item", "data") as? [String: Any] else { return nil }
            let typename = data["__typename"] as? String
            guard typename == "Podcast" || typename == "PodcastShow" else { return nil }
            let uri = data["uri"] as? String ?? SpotifyJSON.at(entry, "item", "_uri") as? String ?? ""
            var show: [String: Any] = [
                "uri": uri,
                "id": uriTail(uri),
                "name": data["name"] as? String ?? "",
                "publisher": SpotifyJSON.at(data, "publisher", "name") as? String ?? "",
                "media_type": data["mediaType"] as? String ?? "",
                "description": data["description"] as? String ?? "",
                "explicit": SpotifyJSON.bool(data, "isExplicit") ?? false,
            ]
            if let sources = SpotifyJSON.at(data, "coverArt", "sources") {
                show["images"] = imageSources(sources)
            }
            if let totalEpisodes = SpotifyJSON.int(SpotifyJSON.at(data, "episodesV2") as? [String: Any], "totalCount") {
                show["total_episodes"] = totalEpisodes
            }
            return [
                "added_at": SpotifyJSON.at(entry, "addedAt", "isoString") as? String as Any,
                "show": show,
            ]
        }
        return [
            "items": items,
            "total": SpotifyJSON.int(lib, "totalCount") ?? items.count,
            "offset": offset, "limit": limit,
        ]
    }

    private func libraryUris(_ params: [String: Any], type: String, idKeys: [String]) -> [String] {
        var ids: [String] = []
        for key in idKeys {
            if let arr = params[key] as? [String] { ids = arr; break }
        }
        return ids.map { entityUri($0, type: type) }
    }

    func handleSaveTracks(_ params: [String: Any]) async throws -> Any? {
        let uris = libraryUris(params, type: "track", idKeys: ["track_ids", "ids", "uris"])
        _ = try await performPathfinderRequest(
            "addToLibrary", hash: SpotifyOperationHash.addToLibrary,
            variables: ["libraryItemUris": uris]
        )
        return ["success": true]
    }

    func handleRemoveTracks(_ params: [String: Any]) async throws -> Any? {
        let uris = libraryUris(params, type: "track", idKeys: ["track_ids", "ids", "uris"])
        _ = try await performPathfinderRequest(
            "removeFromLibrary", hash: SpotifyOperationHash.removeFromLibrary,
            variables: ["libraryItemUris": uris]
        )
        return ["success": true]
    }

    func handleCheckSavedTracks(_ params: [String: Any]) async throws -> Any? {
        try await checkEntitiesInLibrary(params, type: "track", idKeys: ["track_ids", "ids", "uris"])
    }

    func handleSaveShows(_ params: [String: Any]) async throws -> Any? {
        let uris = libraryUris(params, type: "show", idKeys: ["show_ids", "ids", "uris"])
        _ = try await performPathfinderRequest(
            "addToLibrary", hash: SpotifyOperationHash.addToLibrary,
            variables: ["libraryItemUris": uris]
        )
        return ["success": true]
    }

    func handleRemoveShows(_ params: [String: Any]) async throws -> Any? {
        let uris = libraryUris(params, type: "show", idKeys: ["show_ids", "ids", "uris"])
        _ = try await performPathfinderRequest(
            "removeFromLibrary", hash: SpotifyOperationHash.removeFromLibrary,
            variables: ["libraryItemUris": uris]
        )
        return ["success": true]
    }

    func handleCheckSavedShows(_ params: [String: Any]) async throws -> Any? {
        try await checkEntitiesInLibrary(params, type: "show", idKeys: ["show_ids", "ids", "uris"])
    }

    private func checkEntitiesInLibrary(_ params: [String: Any], type: String, idKeys: [String]) async throws -> Any? {
        var ids: [String] = []
        for key in idKeys {
            if let arr = params[key] as? [String] { ids = arr; break }
        }
        let uris = ids.map { entityUri($0, type: type) }
        let result = try await performPathfinderRequest(
            "areEntitiesInLibrary", hash: SpotifyOperationHash.areEntitiesInLibrary,
            variables: ["uris": uris]
        )
        guard let lookup = SpotifyJSON.at(result, "data", "lookup") as? [Any] else {
            return ids.map { _ in false }
        }
        return lookup.map { item -> Bool in
            let dict = item as? [String: Any]
            return SpotifyJSON.bool(SpotifyJSON.dict(dict, "data"), "saved")
                ?? SpotifyJSON.bool(dict, "saved") ?? false
        }
    }

    func handleGetArtist(_ params: [String: Any]) async throws -> Any? {
        let uri = entityUri(contentId(params), type: "artist")
        let result = try await performPathfinderRequest(
            "queryArtistOverview", hash: SpotifyOperationHash.queryArtistOverview,
            variables: ["uri": uri, "locale": "", "includePrerelease": true]
        )
        guard let artist = SpotifyJSON.at(result, "data", "artistUnion") as? [String: Any] else {
            return result
        }
        return transformArtistResponse(artist)
    }

    private func transformArtistResponse(_ artist: [String: Any]) -> [String: Any] {
        var result: [String: Any] = [:]
        result["uri"] = artist["uri"] ?? ""
        result["id"] = artist["id"] as? String ?? uriTail(artist["uri"] as? String)
        result["name"] = SpotifyJSON.at(artist, "profile", "name") as? String ?? ""
        result["type"] = "artist"
        result["verified"] = SpotifyJSON.bool(SpotifyJSON.dict(artist, "profile"), "verified") ?? false

        if let sources = SpotifyJSON.at(artist, "visuals", "avatarImage", "sources") {
            result["images"] = imageSources(sources)
        }
        if let stats = artist["stats"] as? [String: Any] {
            result["followers"] = ["total": SpotifyJSON.int(stats, "followers") ?? 0]
            result["monthly_listeners"] = SpotifyJSON.int(stats, "monthlyListeners") ?? 0
        }
        if let bio = SpotifyJSON.at(artist, "profile", "biography", "text") as? String {
            result["biography"] = bio
        }

        let discography = artist["discography"] as? [String: Any]
        if let topTrackItems = SpotifyJSON.at(discography, "topTracks", "items") as? [[String: Any]] {
            result["top_tracks"] = topTrackItems.map { item in
                transformTrackResponse(item["track"] as? [String: Any] ?? item)
            }
        }

        func transformReleases(_ items: [[String: Any]]) -> [[String: Any]] {
            items.map { item in
                let release = (SpotifyJSON.at(item, "releases", "items") as? [[String: Any]])?.first ?? item
                let rUri = release["uri"] as? String ?? ""
                var out: [String: Any] = [
                    "id": release["id"] as? String ?? uriTail(rUri),
                    "name": release["name"] ?? "",
                    "uri": rUri,
                    "type": (release["type"] as? String ?? "ALBUM").lowercased(),
                ]
                if let totalTracks = SpotifyJSON.int(SpotifyJSON.dict(release, "tracks"), "totalCount") {
                    out["total_tracks"] = totalTracks
                }
                if let date = release["date"] as? [String: Any], let year = SpotifyJSON.int(date, "year") {
                    let month = SpotifyJSON.int(date, "month") ?? 1
                    let day = SpotifyJSON.int(date, "day") ?? 1
                    out["release_date"] = String(format: "%d-%02d-%02d", year, month, day)
                }
                out["images"] = imageSources(SpotifyJSON.at(release, "coverArt", "sources"))
                return out
            }
        }

        if let items = SpotifyJSON.at(discography, "albums", "items") as? [[String: Any]] {
            result["albums"] = transformReleases(items)
        }
        if let items = SpotifyJSON.at(discography, "singles", "items") as? [[String: Any]] {
            result["singles"] = transformReleases(items)
        }
        if let items = SpotifyJSON.at(discography, "popularReleasesAlbums", "items") as? [[String: Any]] {
            result["popular_releases"] = transformReleases(items)
        }

        if let related = SpotifyJSON.at(artist, "relatedContent", "relatedArtists", "items") as? [[String: Any]] {
            result["related_artists"] = related.map { a -> [String: Any] in
                [
                    "id": a["id"] as? String ?? uriTail(a["uri"] as? String),
                    "name": SpotifyJSON.at(a, "profile", "name") as? String ?? "",
                    "uri": a["uri"] as? String ?? "",
                    "images": imageSources(SpotifyJSON.at(a, "visuals", "avatarImage", "sources")),
                ]
            }
        }
        return result
    }

    func handleGetArtistTopTracks(_ params: [String: Any]) async throws -> Any? {
        let uri = entityUri(contentId(params), type: "artist")
        let mockingbird = SpotifyJSON.bool(params, "mockingbird") ?? false
        let result = try await performPathfinderRequest(
            "queryArtistOverview", hash: SpotifyOperationHash.queryArtistOverview,
            variables: ["uri": uri, "locale": "", "includePrerelease": true]
        )
        let discography = SpotifyJSON.at(result, "data", "artistUnion", "discography") as? [String: Any]
        guard let items = SpotifyJSON.at(discography, "topTracks", "items") as? [[String: Any]] else {
            return ["tracks": []]
        }

        let albumLookup = mockingbird ? buildAlbumLookup(discography) : [:]
        let tracks: [[String: Any]] = items.map { item in
            let trackData = item["track"] as? [String: Any] ?? item
            var transformed = transformTrackResponse(trackData)
            if mockingbird {
                let albumOfTrack = trackData["albumOfTrack"] as? [String: Any]
                if let albumUri = albumOfTrack?["uri"] as? String,
                   let cached = albumLookup[albumUri], cached["image_url"] != nil {
                    transformed["album"] = cached
                } else if let albumOfTrack {
                    transformed["album"] = buildMinimalAlbumInfo(albumOfTrack)
                } else {
                    transformed.removeValue(forKey: "album")
                }
            } else {
                transformed.removeValue(forKey: "album")
            }
            return transformed
        }
        return filterResponse(["tracks": tracks])
    }

    private func buildMinimalAlbumInfo(_ albumOfTrack: [String: Any]) -> [String: Any] {
        var info: [String: Any] = [
            "name": albumOfTrack["name"] as? String ?? "",
            "uri": albumOfTrack["uri"] as? String ?? "",
        ]
        if let sources = SpotifyJSON.at(albumOfTrack, "coverArt", "sources") as? [[String: Any]], !sources.isEmpty {
            let preferred = sources.first { SpotifyJSON.int($0, "height") == 64 }
                ?? sources.min { (SpotifyJSON.int($0, "height") ?? .max) < (SpotifyJSON.int($1, "height") ?? .max) }
            if let url = preferred?["url"] { info["image_url"] = url }
        }
        return info
    }

    private func buildAlbumLookup(_ discography: [String: Any]?) -> [String: [String: Any]] {
        var lookup: [String: [String: Any]] = [:]

        func register(_ album: [String: Any]) {
            guard let uri = album["uri"] as? String, lookup[uri] == nil else { return }
            var info: [String: Any] = ["name": album["name"] as? String ?? "", "uri": uri]
            if let sources = SpotifyJSON.at(album, "coverArt", "sources") as? [[String: Any]],
               let small = sources.first(where: { SpotifyJSON.int($0, "height") == 64 }),
               let url = small["url"] {
                info["image_url"] = url
            }
            lookup[uri] = info
        }

        if let popular = SpotifyJSON.at(discography, "popularReleasesAlbums", "items") as? [[String: Any]] {
            popular.forEach(register)
        }
        for key in ["albums", "singles"] {
            guard let items = SpotifyJSON.at(discography, key, "items") as? [[String: Any]] else { continue }
            for item in items {
                guard let releases = SpotifyJSON.at(item, "releases", "items") as? [[String: Any]] else { continue }
                releases.forEach(register)
            }
        }
        return lookup
    }

    func handleGetAlbum(_ params: [String: Any]) async throws -> Any? {
        let uri = entityUri(contentId(params), type: "album")
        let result = try await performPathfinderRequest(
            "getAlbum", hash: SpotifyOperationHash.getAlbum,
            variables: [
                "uri": uri, "locale": "",
                "offset": SpotifyJSON.int(params, "offset") ?? 0,
                "limit": SpotifyJSON.int(params, "limit") ?? 50,
            ]
        )
        let album = SpotifyJSON.at(result, "data", "albumUnion") as? [String: Any]
        guard let album else { return result }
        return filterResponse(transformAlbumResponse(album))
    }

    private func transformAlbumResponse(_ album: [String: Any]) -> [String: Any] {
        var result: [String: Any] = [:]
        if let uri = album["uri"] as? String {
            result["uri"] = uri
            result["id"] = uriTail(uri)
        }
        result["name"] = album["name"] ?? ""
        result["album_type"] = (album["type"] as? String ?? "album").lowercased()

        if let items = SpotifyJSON.at(album, "artists", "items") as? [[String: Any]] {
            result["artists"] = flattenArtists(items)
        }
        if let sources = SpotifyJSON.at(album, "coverArt", "sources") as? [[String: Any]] {
            let at300 = sources.filter { SpotifyJSON.int($0, "height") == 300 }
            result["images"] = imageSources(at300.isEmpty ? sources : at300)
        }
        if let tracks = album["tracksV2"] ?? album["tracks"] {
            result["total_tracks"] = SpotifyJSON.int(tracks as? [String: Any], "totalCount") as Any
            result["tracks"] = tracks
        }
        if let releaseDate = SpotifyJSON.at(album, "date", "isoString") {
            result["release_date"] = releaseDate
        }
        return result
    }

    func flattenArtists(_ items: [[String: Any]]) -> [[String: Any]] {
        items.map { a in
            let uri = a["uri"] as? String ?? ""
            return [
                "id": uriTail(uri),
                "name": SpotifyJSON.at(a, "profile", "name") as? String ?? a["name"] as? String ?? "",
                "uri": uri,
            ]
        }
    }

    func transformTrackResponse(_ track: [String: Any]) -> [String: Any] {
        var result: [String: Any] = [:]
        if let uri = track["uri"] as? String {
            result["uri"] = uri
            result["id"] = uriTail(uri)
        }
        result["name"] = track["name"] ?? ""
        if let trackNumber = track["trackNumber"] { result["track_number"] = trackNumber }
        result["disc_number"] = track["discNumber"] ?? 1
        result["explicit"] = (SpotifyJSON.at(track, "contentRating", "label") as? String) == "EXPLICIT"

        let dur = track["trackDuration"] as? [String: Any] ?? track["duration"] as? [String: Any]
        if let ms = SpotifyJSON.int(dur, "totalMilliseconds") { result["duration_ms"] = ms }

        let artistsData = track["artists"] as? [String: Any] ?? track["firstArtist"] as? [String: Any]
        if let items = artistsData?["items"] as? [[String: Any]] {
            result["artists"] = flattenArtists(items)
        }

        if let ad = track["albumOfTrack"] as? [String: Any] {
            var albumResult: [String: Any] = [:]
            if let uri = ad["uri"] as? String {
                albumResult["uri"] = uri
                albumResult["id"] = uriTail(uri)
            }
            albumResult["name"] = ad["name"] ?? ""
            if let sources = SpotifyJSON.at(ad, "coverArt", "sources") {
                albumResult["images"] = imageSources(sources)
            }
            result["album"] = albumResult
        }
        if let playability = track["playability"] as? [String: Any] {
            result["is_playable"] = playability["playable"] ?? true
        }
        return result
    }

    private func transformPlaylistResponse(_ playlist: [String: Any]) -> [String: Any] {
        var result: [String: Any] = [:]
        if let uri = playlist["uri"] as? String {
            result["uri"] = uri
            result["id"] = uriTail(uri)
        }
        result["name"] = playlist["name"] ?? ""
        result["description"] = playlist["description"] ?? ""
        result["collaborative"] = SpotifyJSON.bool(playlist, "collaborative") ?? false
        if let isPublic = playlist["public"] { result["public"] = isPublic }

        if let o = SpotifyJSON.at(playlist, "ownerV2", "data") as? [String: Any] {
            result["owner"] = [
                "display_name": o["name"] ?? "",
                "uri": o["uri"] ?? "",
                "id": uriTail(o["uri"] as? String),
            ]
        }
        if let imageItems = SpotifyJSON.at(playlist, "images", "items") as? [[String: Any]] {
            result["images"] = imageItems.compactMap { item -> [String: Any]? in
                guard let src = (item["sources"] as? [[String: Any]])?.first else { return nil }
                return ["url": src["url"] ?? "", "height": src["height"] ?? 0, "width": src["width"] ?? 0]
            }
        }
        if let content = playlist["content"] as? [String: Any] {
            var tracks: [String: Any] = ["total": SpotifyJSON.int(content, "totalCount") as Any]
            if let items = content["items"] as? [[String: Any]] {
                tracks["items"] = items.compactMap { item -> [String: Any]? in
                    guard let trackData = SpotifyJSON.at(item, "itemV2", "data") as? [String: Any] else { return nil }
                    return [
                        "added_at": SpotifyJSON.at(item, "addedAt", "isoString") as? String as Any,
                        "track": transformTrackResponse(trackData),
                    ]
                }
            }
            result["tracks"] = tracks
        }
        if let followers = SpotifyJSON.int(playlist, "followers") {
            result["followers"] = ["total": followers]
        }
        return result
    }

    private func transformTopArtistResponse(_ artist: [String: Any]) -> [String: Any] {
        var result: [String: Any] = [:]
        if let uri = artist["uri"] as? String {
            result["uri"] = uri
            result["id"] = uriTail(uri)
        }
        result["name"] = SpotifyJSON.at(artist, "profile", "name") as? String ?? artist["name"] as? String ?? ""
        if let sources = SpotifyJSON.at(artist, "visuals", "avatarImage", "sources") as? [[String: Any]] {
            let at320 = sources.filter { SpotifyJSON.int($0, "height") == 320 }
            result["images"] = imageSources(at320.isEmpty ? sources : at320)
        }
        result["type"] = "artist"
        return result
    }

    func handleGetAlbumTracks(_ params: [String: Any]) async throws -> Any? {
        let id = params["albumId"] as? String ?? params["album_id"] as? String ?? params["id"] as? String ?? ""
        let uri = entityUri(id, type: "album")
        let offset = SpotifyJSON.int(params, "offset") ?? 0
        let limit = SpotifyJSON.int(params, "limit") ?? 50
        let result = try await performPathfinderRequest(
            "getAlbum", hash: SpotifyOperationHash.getAlbum,
            variables: ["uri": uri, "locale": "", "offset": offset, "limit": limit]
        )
        let album = SpotifyJSON.at(result, "data", "albumUnion") as? [String: Any]
        guard let tracksData = album?["tracksV2"] as? [String: Any] ?? album?["tracks"] as? [String: Any] else {
            return ["items": [], "total": 0, "offset": offset, "limit": limit]
        }
        let items = (tracksData["items"] as? [[String: Any]] ?? []).map { item in
            transformTrackResponse(item["track"] as? [String: Any] ?? item)
        }
        return filterResponse([
            "items": items,
            "total": SpotifyJSON.int(tracksData, "totalCount") ?? items.count,
            "offset": offset, "limit": limit,
        ])
    }

    func handleGetPlaylist(_ params: [String: Any]) async throws -> Any? {
        let uri = entityUri(contentId(params), type: "playlist")
        let result = try await performPathfinderRequest(
            "fetchPlaylist", hash: SpotifyOperationHash.fetchPlaylist,
            variables: [
                "uri": uri, "offset": 0,
                "limit": SpotifyJSON.int(params, "limit") ?? 50,
                "enableWatchFeedEntrypoint": true,
            ]
        )
        guard let playlist = SpotifyJSON.at(result, "data", "playlistV2") as? [String: Any] else {
            return result
        }
        let full = filterResponse(transformPlaylistResponse(playlist))
        if let fields = params["fields"] as? String, let dict = full as? [String: Any] {
            return filterByFields(dict, fields: fields)
        }
        return full
    }

    private func filterByFields(_ obj: [String: Any], fields: String) -> [String: Any] {
        var result: [String: Any] = [:]
        for field in fields.split(separator: ",") {
            let parts = field.trimmingCharacters(in: .whitespaces).split(separator: ".").map(String.init)
            guard !parts.isEmpty else { continue }
            var src: Any? = obj
            var chain: [String] = []
            for (i, key) in parts.enumerated() {
                guard let dict = src as? [String: Any] else { break }
                if i == parts.count - 1 {
                    var dst = result
                    setNested(&dst, path: chain + [key], value: dict[key])
                    result = dst
                } else {
                    chain.append(key)
                    src = dict[key]
                }
            }
        }
        return result
    }

    private func setNested(_ dict: inout [String: Any], path: [String], value: Any?) {
        guard let first = path.first else { return }
        if path.count == 1 {
            dict[first] = value
            return
        }
        var child = dict[first] as? [String: Any] ?? [:]
        setNested(&child, path: Array(path.dropFirst()), value: value)
        dict[first] = child
    }

    func handleGetPlaylistTracks(_ params: [String: Any]) async throws -> Any? {
        let id = params["playlistId"] as? String ?? params["playlist_id"] as? String ?? params["id"] as? String ?? ""
        let uri = entityUri(id, type: "playlist")
        let offset = SpotifyJSON.int(params, "offset") ?? 0
        let limit = SpotifyJSON.int(params, "limit") ?? 50
        let mockingbird = SpotifyJSON.bool(params, "mockingbird") ?? false
        let result = try await performPathfinderRequest(
            "fetchPlaylist", hash: SpotifyOperationHash.fetchPlaylist,
            variables: ["uri": uri, "offset": offset, "limit": limit, "enableWatchFeedEntrypoint": true]
        )
        guard let content = SpotifyJSON.at(result, "data", "playlistV2", "content") as? [String: Any] else {
            return ["items": [], "total": 0, "offset": offset, "limit": limit]
        }
        let items: [[String: Any]] = (content["items"] as? [[String: Any]] ?? []).compactMap { item in
            guard let trackData = SpotifyJSON.at(item, "itemV2", "data") as? [String: Any] else { return nil }
            var track = transformTrackResponse(trackData)
            if mockingbird {
                if let album = track["album"] as? [String: Any] {
                    track["album"] = slimAlbum(album)
                }
            } else if var album = track["album"] as? [String: Any] {
                album.removeValue(forKey: "images")
                track["album"] = album
            }
            return ["track": track]
        }
        return filterResponse([
            "items": items,
            "total": SpotifyJSON.int(content, "totalCount") ?? items.count,
            "offset": offset, "limit": limit,
        ])
    }

    func handleGetShow(_ params: [String: Any]) async throws -> Any? {
        let uri = entityUri(contentId(params), type: "show")
        let result = try await performPathfinderRequest(
            "queryShowMetadataV2", hash: SpotifyOperationHash.queryShowMetadataV2,
            variables: ["uri": uri]
        )
        guard let show = SpotifyJSON.at(result, "data", "podcastUnionV2") as? [String: Any] else {
            return result
        }
        return transformShowResponse(show)
    }

    private func transformShowResponse(_ show: [String: Any]) -> [String: Any] {
        var result: [String: Any] = [:]
        if let uri = show["uri"] as? String {
            result["uri"] = uri
            result["id"] = show["id"] as? String ?? uriTail(uri)
        }
        result["name"] = show["name"] as? String ?? ""
        result["publisher"] = SpotifyJSON.at(show, "publisher", "name") as? String
            ?? show["publisher"] as? String ?? ""
        result["description"] = show["htmlDescription"] as? String ?? show["description"] as? String ?? ""
        result["media_type"] = show["mediaType"] as? String ?? ""
        result["explicit"] = (SpotifyJSON.at(show, "contentRatingV2", "label") as? String) == "EXPLICIT"
        result["saved"] = SpotifyJSON.bool(show, "saved") ?? false

        if let sources = SpotifyJSON.at(show, "coverArt", "sources") {
            result["images"] = imageSources(sources)
        }
        if let episodes = show["episodesV2"] as? [String: Any] {
            result["total_episodes"] = SpotifyJSON.int(episodes, "totalCount")
                ?? (episodes["items"] as? [Any])?.count ?? 0
        }
        return result
    }

    private func transformEpisodeResponse(_ ep: [String: Any]) -> [String: Any] {
        var result: [String: Any] = [:]
        if let uri = ep["uri"] as? String {
            result["uri"] = uri
            result["id"] = ep["id"] as? String ?? uriTail(uri)
        }
        result["name"] = ep["name"] as? String ?? ""
        result["description"] = ep["htmlDescription"] as? String ?? ep["description"] as? String ?? ""

        if let ms = SpotifyJSON.int(SpotifyJSON.dict(ep, "duration"), "totalMilliseconds") {
            result["duration_ms"] = ms
        }
        if let releaseDate = SpotifyJSON.at(ep, "releaseDate", "isoString") {
            result["release_date"] = releaseDate
        }
        if let sources = SpotifyJSON.at(ep, "coverArt", "sources") {
            result["images"] = imageSources(sources)
        }
        if let playedState = ep["playedState"] as? [String: Any] {
            result["resume_point"] = [
                "fully_played": (playedState["state"] as? String) == "COMPLETED",
                "resume_position_ms": SpotifyJSON.int(playedState, "playPositionMilliseconds") ?? 0,
            ]
        }
        if let podcast = SpotifyJSON.at(ep, "podcastV2", "data") as? [String: Any] {
            result["show"] = [
                "name": podcast["name"] ?? "",
                "uri": podcast["uri"] ?? "",
                "id": uriTail(podcast["uri"] as? String),
            ]
        }
        return result
    }

    func handleGetShowEpisodes(_ params: [String: Any]) async throws -> Any? {
        let uri = entityUri(contentId(params), type: "show")
        let offset = SpotifyJSON.int(params, "offset") ?? 0
        let limit = SpotifyJSON.int(params, "limit") ?? 50
        let result = try await performPathfinderRequest(
            "queryPodcastEpisodes", hash: SpotifyOperationHash.queryPodcastEpisodes,
            variables: ["uri": uri, "offset": offset, "limit": limit]
        )
        guard let episodes = SpotifyJSON.at(result, "data", "podcastUnionV2", "episodesV2") as? [String: Any],
              let rawItems = episodes["items"] as? [[String: Any]] else {
            return ["items": [], "total": 0, "offset": offset, "limit": limit]
        }
        let items = rawItems
            .map { item in
                transformEpisodeResponse(
                    SpotifyJSON.at(item, "entity", "data") as? [String: Any]
                        ?? item["data"] as? [String: Any] ?? item
                )
            }
            .filter { ($0["uri"] as? String)?.isEmpty == false }
        return [
            "items": items,
            "total": SpotifyJSON.int(episodes, "totalCount") ?? items.count,
            "offset": offset, "limit": limit,
        ]
    }

    func handleGetUserProfile() async throws -> Any? {
        let result = try await performPathfinderRequest(
            "profileAttributes", hash: SpotifyOperationHash.profileAttributes, variables: [:]
        )
        return SpotifyJSON.at(result, "data", "me") ?? result
    }

    func handleGetTopArtists(_ params: [String: Any]) async throws -> Any? {
        let limit = SpotifyJSON.int(params, "limit") ?? 50
        let offset = SpotifyJSON.int(params, "offset") ?? 0
        let result = try await performPathfinderRequest(
            "userTopContent", hash: SpotifyOperationHash.userTopContent,
            variables: [
                "includeTopArtists": true,
                "includeTopTracks": false,
                "topArtistsInput": ["offset": offset, "limit": limit, "sortBy": "AFFINITY"],
                "topTracksInput": ["offset": 0, "limit": 1, "sortBy": "AFFINITY"],
            ]
        )
        let topArtists = SpotifyJSON.at(result, "data", "me", "profile", "topArtists") as? [String: Any]
            ?? SpotifyJSON.at(result, "data", "me", "topContent") as? [String: Any]
        guard let items = topArtists?["items"] as? [[String: Any]] else {
            return ["items": [], "total": 0, "offset": offset, "limit": limit]
        }
        let transformed = items.map { item in
            transformTopArtistResponse(item["data"] as? [String: Any] ?? item)
        }
        return filterResponse([
            "items": transformed,
            "total": SpotifyJSON.int(topArtists, "totalCount") ?? transformed.count,
            "offset": offset, "limit": limit,
        ])
    }

    func handleGetTopTracks(_ params: [String: Any]) async throws -> Any? {
        let limit = SpotifyJSON.int(params, "limit") ?? 50
        let offset = SpotifyJSON.int(params, "offset") ?? 0
        let result = try await performPathfinderRequest(
            "userTopContent", hash: SpotifyOperationHash.userTopContent,
            variables: [
                "includeTopArtists": false,
                "includeTopTracks": true,
                "topArtistsInput": ["offset": 0, "limit": 1, "sortBy": "AFFINITY"],
                "topTracksInput": ["offset": offset, "limit": limit, "sortBy": "AFFINITY"],
            ]
        )
        let payload = SpotifyJSON.at(result, "data", "me", "profile", "topTracks")
            ?? SpotifyJSON.at(result, "data", "me", "topContent")
            ?? result
        return filterResponse(payload)
    }

    func handleGetRecentlyPlayed(_ params: [String: Any]) async throws -> Any? {
        let accessToken = try await getValidAccessToken()
        guard let userId = await getSpotifyUserId() else { return ["albums": []] }

        let limit = SpotifyJSON.int(params, "limit") ?? 50
        let (data, http) = try await api.request(
            URL(string: "https://spclient.wg.spotify.com/recently-played/v3/user/\(userId)/recently-played?format=json&offset=0&limit=\(limit)&market=from_token")!,
            headers: ["Accept": "application/json", "Authorization": "Bearer \(accessToken)"]
        )
        guard (200..<300).contains(http.statusCode), let json = SpotifyJSON.object(data) else {
            return ["albums": []]
        }

        let playContexts = json["playContexts"] as? [[String: Any]] ?? []
        let trackUris = playContexts
            .compactMap { $0["lastPlayedTrackUri"] as? String }
            .filter { $0.hasPrefix("spotify:track:") }

        var seenAlbumUris = Set<String>()
        var albums: [[String: Any]] = []
        for trackUri in trackUris {
            if albums.count >= limit { break }
            guard let track = try? await fetchTrackDetails(trackUri),
                  let trackAlbum = track["album"] as? [String: Any],
                  let albumUri = trackAlbum["uri"] as? String, !albumUri.isEmpty,
                  !seenAlbumUris.contains(albumUri) else {
                continue
            }
            seenAlbumUris.insert(albumUri)

            var album: [String: Any] = [
                "uri": albumUri,
                "id": trackAlbum["id"] as? String ?? uriTail(albumUri),
                "name": trackAlbum["name"] as? String ?? "",
            ]
            if let images = trackAlbum["images"] as? [[String: Any]] {
                album["images"] = images.filter { SpotifyJSON.int($0, "height") == 300 }
            }
            if let artists = try? await fetchAlbumArtists(album["id"] as? String ?? "") {
                album["artists"] = artists
            }
            albums.append(album)
        }
        return ["albums": albums]
    }

    func handleGetRadioMixes() async throws -> Any? {
        let result = try await performPathfinderRequest(
            "homeSection", hash: SpotifyOperationHash.homeSection,
            variables: [
                "uri": "spotify:section:0JQ5DAUnp4wcj0bCb3wh3S",
                "timeZone": TimeZone.current.identifier,
                "sp_t": "",
                "sectionItemsOffset": 0,
                "sectionItemsLimit": 20,
            ]
        )
        guard let sections = SpotifyJSON.at(result, "data", "homeSections", "sections") as? [[String: Any]] else {
            return ["sections": []]
        }
        let transformed = sections.map { section -> [String: Any] in
            let title = SpotifyJSON.at(section, "data", "title", "transformedLabel") as? String ?? ""
            let sectionItems = SpotifyJSON.at(section, "sectionItems", "items") as? [[String: Any]] ?? []
            let items: [[String: Any]] = sectionItems.compactMap { item in
                guard let content = SpotifyJSON.at(item, "content", "data") as? [String: Any] else { return nil }
                let imageUrl = SpotifyJSON.at(content, "images", "items") as? [[String: Any]]
                let firstSource = (imageUrl?.first?["sources"] as? [[String: Any]])?.first
                return [
                    "uri": item["uri"] ?? "",
                    "name": content["name"] ?? "",
                    "format": content["format"] ?? "",
                    "image_url": firstSource?["url"] as? String as Any,
                ]
            }
            return ["title": title, "items": items]
        }
        return ["sections": transformed]
    }

    func handleGetRadioPlaylist(_ params: [String: Any]) async throws -> Any? {
        try await handleGetPlaylist(["id": contentId(params)])
    }

    func handleGetRadioTopMix() async throws -> Any? {
        let topTracks = try await handleGetTopTracks(["limit": 10]) as? [String: Any]
        guard let items = topTracks?["items"] as? [[String: Any]], !items.isEmpty,
              let seed = items.randomElement() else {
            return ["tracks": [], "total": 0]
        }
        let seedId = seed["id"] as? String ?? uriTail(seed["uri"] as? String)
        guard !seedId.isEmpty else { return ["tracks": [], "total": 0] }
        return try await recommendedTracks(seedTrackId: seedId)
    }

    func handleGetRadioDiscoveries() async throws -> Any? {
        let topArtists = try await handleGetTopArtists(["limit": 10]) as? [String: Any]
        guard let artistItems = topArtists?["items"] as? [[String: Any]], !artistItems.isEmpty,
              let seedArtist = artistItems.randomElement(),
              let artistId = seedArtist["id"] as? String, !artistId.isEmpty else {
            return ["tracks": [], "total": 0]
        }
        let artistTopTracks = try await handleGetArtistTopTracks(["id": artistId]) as? [String: Any]
        let trackItems = SpotifyJSON.at(artistTopTracks, "discography", "topTracks", "items") as? [[String: Any]]
            ?? artistTopTracks?["tracks"] as? [[String: Any]] ?? []
        guard let randomTrack = trackItems.randomElement() else { return ["tracks": [], "total": 0] }
        let trackId = randomTrack["id"] as? String
            ?? SpotifyJSON.at(randomTrack, "track", "id") as? String
            ?? uriTail(randomTrack["uri"] as? String)
        guard !trackId.isEmpty else { return ["tracks": [], "total": 0] }
        return try await recommendedTracks(seedTrackId: trackId)
    }

    private func recommendedTracks(seedTrackId: String) async throws -> Any? {
        let result = try await performPathfinderRequest(
            "internalLinkRecommenderTrack", hash: SpotifyOperationHash.internalLinkRecommenderTrack,
            variables: ["uri": "spotify:track:\(seedTrackId)", "limit": 50]
        )
        let recItems = SpotifyJSON.at(result, "data", "seoRecommendedTrack", "items") as? [[String: Any]] ?? []
        let tracks = recItems
            .map { item -> [String: Any] in
                var t = transformTrackResponse(item["data"] as? [String: Any] ?? item)
                t.removeValue(forKey: "album")
                return t
            }
            .filter { ($0["uri"] as? String)?.isEmpty == false }
        return filterResponse(["tracks": tracks, "total": tracks.count])
    }

    func handleGetLyrics(_ params: [String: Any]) async throws -> Any? {
        let trackId = params["trackId"] as? String ?? params["track_id"] as? String ?? params["id"] as? String
        if let trackId {
            if let accessToken = try? await getValidAccessToken() {
                let url = URL(string: "https://spclient.wg.spotify.com/color-lyrics/v2/track/\(trackId)?format=json&vocalRemoval=false&market=from_token")!
                if let (data, http) = try? await api.request(url, headers: [
                    "Accept": "application/json",
                    "App-Platform": "WebPlayer",
                    "Authorization": "Bearer \(accessToken)",
                ]), (200..<300).contains(http.statusCode), let json = SpotifyJSON.object(data) {
                    let filtered = filterLyricsResponse(json)
                    if let lines = SpotifyJSON.at(filtered, "lyrics", "lines") as? [Any], !lines.isEmpty {
                        return filtered
                    }
                }
            }
        }

        let trackName = params["trackName"] as? String ?? params["track_name"] as? String
        let artistName = params["artistName"] as? String ?? params["artist_name"] as? String
        if let trackName, let artistName {
            return await fetchLrcLibLyrics(
                trackName: trackName,
                artistName: artistName,
                albumName: params["albumName"] as? String ?? params["album_name"] as? String,
                duration: SpotifyJSON.int(params, "duration")
            )
        }
        return ["lyrics": ["lines": [], "syncType": "NOT_SYNCED"]]
    }

    private func fetchLrcLibLyrics(trackName: String, artistName: String, albumName: String?, duration: Int?) async -> Any {
        var comp = URLComponents(string: "https://lrclib.net/api/get")!
        var query = [
            URLQueryItem(name: "track_name", value: trackName),
            URLQueryItem(name: "artist_name", value: artistName),
        ]
        if let albumName { query.append(URLQueryItem(name: "album_name", value: albumName)) }
        if let duration { query.append(URLQueryItem(name: "duration", value: String(duration / 1000))) }
        comp.queryItems = query

        let empty: [String: Any] = ["lyrics": ["lines": [], "syncType": "NOT_SYNCED"]]
        guard let url = comp.url,
              let (data, http) = try? await api.request(url),
              (200..<300).contains(http.statusCode),
              let json = SpotifyJSON.object(data) else {
            return empty
        }

        var lines: [[String: Any]] = []
        if let synced = json["syncedLyrics"] as? String {
            let regex = try? NSRegularExpression(pattern: #"\[(\d{2}):(\d{2})\.(\d{2})\]\s*(.*)"#)
            for line in synced.split(separator: "\n", omittingEmptySubsequences: false) {
                let s = String(line)
                guard let regex,
                      let match = regex.firstMatch(in: s, range: NSRange(s.startIndex..., in: s)),
                      match.numberOfRanges == 5,
                      let minRange = Range(match.range(at: 1), in: s),
                      let secRange = Range(match.range(at: 2), in: s),
                      let centiRange = Range(match.range(at: 3), in: s),
                      let wordsRange = Range(match.range(at: 4), in: s) else { continue }
                let minutes: Int = Int(String(s[minRange])) ?? 0
                let seconds: Int = Int(String(s[secRange])) ?? 0
                let centis: Int = Int(String(s[centiRange])) ?? 0
                let ms: Int = minutes * 60000 + seconds * 1000 + centis * 10
                lines.append(["words": String(s[wordsRange]), "startTimeMs": String(ms), "endTimeMs": "0"])
            }
            return ["lyrics": ["lines": lines, "syncType": "LINE_SYNCED"]]
        }

        if let plain = json["plainLyrics"] as? String {
            for line in plain.split(separator: "\n", omittingEmptySubsequences: false) {
                let trimmed = line.trimmingCharacters(in: .whitespaces)
                if !trimmed.isEmpty {
                    lines.append(["words": String(line), "startTimeMs": "0", "endTimeMs": "0"])
                }
            }
        }
        return ["lyrics": ["lines": lines, "syncType": "NOT_SYNCED"]]
    }

    func handleFetchImage(_ params: [String: Any]) async throws -> Any? {
        guard let urlString = params["url"] as? String, let url = URL(string: urlString) else {
            throw SpotifyAPIError("Failed to fetch image")
        }
        let (data, http) = try await api.request(url)
        guard (200..<300).contains(http.statusCode) else { throw SpotifyAPIError("Failed to fetch image") }
        return [
            "data": data.base64EncodedString(),
            "contentType": http.value(forHTTPHeaderField: "Content-Type") ?? "image/jpeg",
            "size": data.count,
        ]
    }

    func handleSearch(_ params: [String: Any]) async throws -> Any? {
        let query = params["query"] as? String ?? ""
        let limit = min(SpotifyJSON.int(params, "limit") ?? 5, 5)

        let result = try await performPathfinderRequest(
            "searchDesktop", hash: SpotifyOperationHash.searchDesktop,
            variables: [
                "searchTerm": query,
                "offset": 0,
                "limit": limit,
                "numberOfTopResults": limit,
                "includeAudiobooks": false,
                "includeArtistHasConcertsField": false,
                "includePreReleases": false,
                "includeAuthors": false,
                "includeEpisodeContentRatingsV2": false,
            ]
        )
        guard let searchV2 = SpotifyJSON.at(result, "data", "searchV2") as? [String: Any] else {
            throw SpotifyAPIError("Invalid search response")
        }
        return transformSearchResponse(searchV2)
    }

    private func transformSearchResponse(_ searchV2: [String: Any]) -> [String: Any] {
        var out: [String: Any] = [:]

        func joinedArtistNames(_ items: Any?) -> String {
            (items as? [[String: Any]] ?? [])
                .compactMap { SpotifyJSON.at($0, "profile", "name") as? String }
                .filter { !$0.isEmpty }
                .joined(separator: ", ")
        }

        if let items = SpotifyJSON.at(searchV2, "tracksV2", "items") as? [[String: Any]] {
            out["tracks"] = items.compactMap { wrapper -> [String: Any]? in
                guard let trackData = SpotifyJSON.at(wrapper, "item", "data") as? [String: Any] else { return nil }
                return [
                    "name": trackData["name"] as? String ?? "",
                    "artist": joinedArtistNames(SpotifyJSON.at(trackData, "artists", "items")),
                    "uri": trackData["uri"] as? String ?? "",
                    "image_url": firstImageUrl(SpotifyJSON.at(trackData, "albumOfTrack", "coverArt", "sources")),
                ]
            }
        }
        if let items = searchV2["artists"] as? [String: Any], let artists = items["items"] as? [[String: Any]] {
            out["artists"] = artists.compactMap { wrapper -> [String: Any]? in
                guard let data = wrapper["data"] as? [String: Any] else { return nil }
                return [
                    "name": SpotifyJSON.at(data, "profile", "name") as? String ?? "",
                    "uri": data["uri"] as? String ?? "",
                    "image_url": firstImageUrl(SpotifyJSON.at(data, "visuals", "avatarImage", "sources")),
                ]
            }
        }
        if let items = SpotifyJSON.at(searchV2, "albumsV2", "items") as? [[String: Any]] {
            out["albums"] = items.compactMap { wrapper -> [String: Any]? in
                guard let data = wrapper["data"] as? [String: Any] else { return nil }
                return [
                    "name": data["name"] as? String ?? "",
                    "artist": joinedArtistNames(SpotifyJSON.at(data, "artists", "items")),
                    "uri": data["uri"] as? String ?? "",
                    "image_url": firstImageUrl(SpotifyJSON.at(data, "coverArt", "sources")),
                ]
            }
        }
        if let items = SpotifyJSON.at(searchV2, "playlists", "items") as? [[String: Any]] {
            out["playlists"] = items.compactMap { wrapper -> [String: Any]? in
                guard let data = wrapper["data"] as? [String: Any] else { return nil }
                let imageItems = SpotifyJSON.at(data, "images", "items") as? [[String: Any]]
                return [
                    "name": data["name"] as? String ?? "",
                    "uri": data["uri"] as? String ?? "",
                    "image_url": firstImageUrl(imageItems?.first?["sources"]),
                ]
            }
        }
        return out
    }

    private func firstImageUrl(_ sources: Any?) -> String {
        ((sources as? [[String: Any]])?.first?["url"] as? String) ?? ""
    }

    func filterResponse(_ value: Any?) -> Any? {
        guard let value else { return value }
        if let array = value as? [Any] {
            return array.map { filterResponse($0) as Any }
        }
        guard let dict = value as? [String: Any] else { return value }

        let removeKeys = [
            "available_markets", "preview_url", "disc_number", "copyrights",
            "audio_preview_url", "description", "html_description", "external_urls",
            "external_ids", "played_at", "seeds", "label", "is_local",
        ]
        var filtered = dict
        for key in removeKeys { filtered.removeValue(forKey: key) }
        for (key, child) in filtered where child is [String: Any] || child is [Any] {
            filtered[key] = filterResponse(child)
        }
        return filtered
    }

    func filterLyricsResponse(_ value: [String: Any]) -> [String: Any] {
        var filtered = value
        filtered.removeValue(forKey: "colors")
        filtered.removeValue(forKey: "hasVocalRemoval")

        if var lyrics = filtered["lyrics"] as? [String: Any] {
            for key in ["alternatives", "capStatus", "isDenseTypeface", "isRtlLanguage",
                        "language", "provider", "providerDisplayName", "providerLyricsId",
                        "syncLyricsUri", "colors", "previewLines"] {
                lyrics.removeValue(forKey: key)
            }
            if let lines = lyrics["lines"] as? [[String: Any]] {
                lyrics["lines"] = lines.map { line -> [String: Any] in
                    var l = line
                    l.removeValue(forKey: "syllables")
                    l.removeValue(forKey: "transliteratedWords")
                    return l
                }
            }
            filtered["lyrics"] = lyrics
        }
        return filtered
    }
}
