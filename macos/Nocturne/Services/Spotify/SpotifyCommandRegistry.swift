import Foundation

@MainActor
final class SpotifyCommandRegistry {
    private typealias Handler = ([String: Any]) async throws -> Any?

    private let core: SpotifyCore
    private var handlers: [String: Handler] = [:]

    init(core: SpotifyCore) {
        self.core = core
        registerHandlers()
    }

    private func register(_ command: String, _ handler: @escaping Handler) {
        handlers[command] = handler
    }

    private func registerHandlers() {
        let s = core
        func filtered(_ handler: @escaping Handler) -> Handler {
            { params in SpotifyFilters.filterRecursively(try await handler(params)) }
        }

        register("spotify.player.play") { try await s.handlePlay($0) }
        register("spotify.player.pause") { _ in try await s.handlePause() }
        register("spotify.player.next") { try await s.handleNext($0) }
        register("spotify.player.previous") { _ in try await s.handlePrevious() }
        register("spotify.player.seek") { try await s.handleSeek($0) }
        register("spotify.player.volume") { try await s.handleVolume($0) }
        register("spotify.player.shuffle") { try await s.handleShuffle($0) }
        register("spotify.player.repeat") { try await s.handleRepeat($0) }

        register("spotify.player.state", filtered { _ in try await s.handleGetPlaybackState() })
        register("spotify.player.queue") { _ in try await s.handleGetQueue() }
        register("spotify.player.queue.add") { try await s.handleAddToQueue($0) }
        register("spotify.devices") { _ in try await s.handleGetDevices() }
        register("spotify.player.transfer") { try await s.handleTransferPlayback($0) }

        register("spotify.me.playlists", filtered { try await s.handleGetUserPlaylists($0) })
        register("spotify.me.tracks", filtered { try await s.handleGetSavedTracks($0) })
        register("spotify.me.tracks.save") { try await s.handleSaveTracks($0) }
        register("spotify.me.tracks.remove") { try await s.handleRemoveTracks($0) }
        register("spotify.me.tracks.contains") { try await s.handleCheckSavedTracks($0) }
        register("spotify.me.shows", filtered { try await s.handleGetSavedShows($0) })
        register("spotify.me.shows.save") { try await s.handleSaveShows($0) }
        register("spotify.me.shows.remove") { try await s.handleRemoveShows($0) }
        register("spotify.me.shows.contains") { try await s.handleCheckSavedShows($0) }

        register("spotify.artist.get", filtered { try await s.handleGetArtist($0) })
        register("spotify.artist.topTracks", filtered { try await s.handleGetArtistTopTracks($0) })
        register("spotify.album.get", filtered { try await s.handleGetAlbum($0) })
        register("spotify.album.tracks", filtered { try await s.handleGetAlbumTracks($0) })
        register("spotify.playlist.get", filtered { try await s.handleGetPlaylist($0) })
        register("spotify.playlist.tracks", filtered { try await s.handleGetPlaylistTracks($0) })
        register("spotify.show.get", filtered { try await s.handleGetShow($0) })
        register("spotify.show.episodes", filtered { try await s.handleGetShowEpisodes($0) })

        register("spotify.me.profile") { _ in try await s.handleGetUserProfile() }
        register("spotify.me.topArtists", filtered { try await s.handleGetTopArtists($0) })
        register("spotify.me.topTracks", filtered { try await s.handleGetTopTracks($0) })
        register("spotify.me.recentlyPlayed") { try await s.handleGetRecentlyPlayed($0) }

        register("spotify.radio.mixes") { _ in try await s.handleGetRadioMixes() }
        register("spotify.radio.playlist") { try await s.handleGetRadioPlaylist($0) }
        register("spotify.radio.topMix") { _ in try await s.handleGetRadioTopMix() }
        register("spotify.radio.discoveries") { _ in try await s.handleGetRadioDiscoveries() }

        register("spotify.track.lyrics") {
            SpotifyFilters.filterLyricsResponse(try await s.handleGetLyrics($0))
        }
        register("spotify.player.speed") { try await s.handleSetPlaybackSpeed($0) }
        register("spotify.dj.start") { try await s.handleDjStart($0) }
        register("spotify.dj.signal") { try await s.handleDjSignal($0) }
        register("spotify.image.fetch") { try await s.handleFetchImage($0) }

        register("spotify.search") { try await s.handleSearch($0) }
    }

    func supports(_ command: String) -> Bool {
        handlers[command] != nil
    }

    var supportedCommands: [String] {
        handlers.keys.sorted()
    }

    func dispatch(_ command: String, params: [String: Any]) async throws -> Any? {
        guard let handler = handlers[command] else {
            throw SpotifyAPIError("Unknown Spotify command: \(command)")
        }
        return try await handler(params)
    }
}
