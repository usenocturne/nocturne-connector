import Foundation

enum SpotifyFilters {
    private static let globalStripKeys: Set<String> = [
        "available_markets", "preview_url", "disc_number", "copyrights",
        "audio_preview_url", "description", "html_description", "external_urls",
        "external_ids", "played_at", "seeds", "label", "is_local",
    ]

    private static let playerStateStripKeys: Set<String> = [
        "next_tracks", "prev_tracks", "is_system_initiated", "queue_revision",
        "restrictions", "session_id", "signals", "sleep_timer", "suppressions",
        "index", "context_url", "page_metadata", "play_origin", "playback_id",
        "playback_quality", "session_command_id", "is_buffering",
        "format_list_type", "ignore_enhance_lens",
        "initiated_from_list_play_esperanto", "lexicon_context_url",
    ]

    private static let trackMetadataStripKeys: Set<String> = [
        "image_large_url", "image_small_url", "image_xlarge_url",
        "album_image_large_url", "album_image_small_url", "album_image_xlarge_url",
        "entity_uri", "interaction_id", "page_instance_id", "iteration",
        "canonical_track_uri", "custom_reporting_attribution", "decision_id",
        "segment", "source-loader",
    ]

    private static let trackMetadataPrefixStrip = [
        "actions.", "audio.", "automix.", "home.card.", "narration.",
        "ANN_SEARCH_", "HAS_", "IN_", "IS_", "PLAYED_", "SKIPPED_",
    ]

    private static let contextMetadataStripKeys: Set<String> = [
        "context_owner", "enhanced_context", "playlist_volatile_context_id",
        "shuffle.algorithm", "shuffle.distribution", "shuffle.partition_shuffle",
        "fetch-limit", "filtered-items", "filtering.predicate", "albumType",
        "albumUri", "artistUris", "copyrights", "courtesyLine", "image_url",
        "releaseDate",
    ]

    private static let contextMetadataPrefixStrip = [
        "automix.", "narration.", "genre.displayName.",
        "session_control_display.", "home.card.", "dj.interactivity.",
        "header_image_url_",
    ]

    private static let clusterStripKeys: Set<String> = [
        "started_playing_at", "timestamp", "transfer_data_timestamp",
        "not_playing_since_timestamp", "need_full_player_state",
        "needs_local_devices", "needs_state_updates",
    ]

    private static let deviceStripKeys: Set<String> = [
        "audio_output_device_info", "brand", "client_id",
        "device_software_version", "metadata_map", "public_ip", "spirc_version",
    ]

    private static let deviceCapabilityStripKeys: Set<String> = [
        "command_acks", "gaia_eq_connect_id", "supported_types", "supports_dj",
        "supports_external_episodes", "supports_gzip_pushes", "supports_hifi",
        "supports_logout", "supports_ping_request", "supports_playlist_v2",
        "supports_rename", "supports_set_backend_metadata",
        "supports_set_options_command", "supports_remote_sleep_timer",
    ]

    private static func strip(_ obj: [String: Any], keys: Set<String>) -> [String: Any] {
        obj.filter { !keys.contains($0.key) }
    }

    private static func stripPrefixes(_ obj: [String: Any], prefixes: [String]) -> [String: Any] {
        obj.filter { entry in !prefixes.contains { entry.key.hasPrefix($0) } }
    }

    static func filterRecursively(_ value: Any?) -> Any? {
        guard let value else { return value }
        if let array = value as? [Any] {
            return array.map { filterRecursively($0) as Any }
        }
        guard var obj = value as? [String: Any] else { return value }

        obj = strip(obj, keys: globalStripKeys)

        let uri = obj["uri"] as? String
        let isEpisode =
            (uri?.contains("spotify:episode:") ?? false) ||
            (obj["audio_preview_url"] != nil && obj["release_date"] != nil) ||
            (obj["is_playable"] != nil && obj["release_date"] != nil)
        if !isEpisode {
            obj.removeValue(forKey: "release_date")
            obj.removeValue(forKey: "release_date_precision")
        }

        for (key, child) in obj {
            if child is [String: Any] || child is [Any] {
                obj[key] = filterRecursively(child)
            }
        }
        return obj
    }

    static func cleanupWebSocketMessage(_ event: Any?) -> (topic: String, data: Any)? {
        guard let event = event as? [String: Any] else { return nil }

        let payloads = event["payloads"] as? [Any]
        let hasPayloads = (payloads?.count ?? 0) > 0
        let firstPayload = payloads?.first as? [String: Any]
        let cluster = firstPayload?["cluster"] as? [String: Any]
        let hasPlayerCluster = cluster != nil &&
            (cluster?["player_state"] != nil || cluster?["devices"] != nil)

        if hasPayloads, hasPlayerCluster {
            var cleaned = event
            cleaned.removeValue(forKey: "headers")
            cleaned.removeValue(forKey: "type")
            cleaned.removeValue(forKey: "uri")
            cleaned["phone_timestamp_ms"] = Int(Date().timeIntervalSince1970 * 1000)

            let updateReason = firstPayload?["update_reason"] as? String

            var cleanedPayloads: [Any] = []
            for raw in (cleaned["payloads"] as? [Any]) ?? [] {
                guard var payload = raw as? [String: Any] else {
                    cleanedPayloads.append(raw)
                    continue
                }
                payload.removeValue(forKey: "update_reason")
                payload.removeValue(forKey: "devices_that_changed")
                payload.removeValue(forKey: "ack_id")

                if var payloadCluster = payload["cluster"] as? [String: Any] {
                    payloadCluster = strip(payloadCluster, keys: clusterStripKeys)
                    if let playerState = payloadCluster["player_state"] as? [String: Any] {
                        payloadCluster["player_state"] = cleanPlayerState(playerState)
                    }
                    if let devices = payloadCluster["devices"] as? [String: Any] {
                        payloadCluster["devices"] = cleanDevices(devices)
                    }
                    payload["cluster"] = payloadCluster
                }
                cleanedPayloads.append(payload)
            }
            cleaned["payloads"] = cleanedPayloads

            var topic = "spotify.player.update"
            switch updateReason {
            case "DEVICE_STATE_CHANGED": topic = "spotify.player.device_state_changed"
            case "PLAYER_STATE_CHANGED": topic = "spotify.player.state_changed"
            case "DEVICE_VOLUME_CHANGED": topic = "spotify.player.volume_changed"
            default: break
            }
            return (topic, cleaned)
        }

        if let headers = event["headers"] as? [String: Any],
           let connectionId = headers["Spotify-Connection-Id"] as? String,
           !connectionId.isEmpty {
            return ("spotify.connection.established", ["connection_id": connectionId])
        }

        if hasPayloads {
            var cleaned = event
            cleaned.removeValue(forKey: "headers")
            cleaned.removeValue(forKey: "type")
            cleaned.removeValue(forKey: "uri")
            cleaned["phone_timestamp_ms"] = Int(Date().timeIntervalSince1970 * 1000)

            var cleanedPayloads: [Any] = []
            for raw in (cleaned["payloads"] as? [Any]) ?? [] {
                guard var payload = raw as? [String: Any] else {
                    cleanedPayloads.append(raw)
                    continue
                }
                payload.removeValue(forKey: "update_reason")
                payload.removeValue(forKey: "devices_that_changed")
                payload.removeValue(forKey: "ack_id")
                cleanedPayloads.append(payload)
            }
            cleaned["payloads"] = cleanedPayloads
            return ("spotify.message", cleaned)
        }

        return nil
    }

    static func cleanPlayerState(_ input: [String: Any]) -> [String: Any] {
        var state = strip(input, keys: playerStateStripKeys)

        if var options = state["options"] as? [String: Any] {
            options.removeValue(forKey: "modes")
            state["options"] = options
        }

        if var track = state["track"] as? [String: Any],
           var metadata = track["metadata"] as? [String: Any] {
            metadata = strip(metadata, keys: trackMetadataStripKeys)
            metadata = stripPrefixes(metadata, prefixes: trackMetadataPrefixStrip)
            if let imageURL = metadata["image_url"] as? String,
               imageURL.hasPrefix("spotify:image:") {
                metadata["image_url"] = "i.scdn.co/image/" + imageURL.dropFirst("spotify:image:".count)
            }
            track["metadata"] = metadata
            state["track"] = track
        }

        if var contextMetadata = state["context_metadata"] as? [String: Any] {
            contextMetadata = strip(contextMetadata, keys: contextMetadataStripKeys)
            contextMetadata = stripPrefixes(contextMetadata, prefixes: contextMetadataPrefixStrip)
            state["context_metadata"] = contextMetadata
        }

        return state
    }

    private static func cleanDevices(_ devices: [String: Any]) -> [String: Any] {
        var result = devices
        for (key, raw) in devices {
            guard var device = raw as? [String: Any] else { continue }
            device = strip(device, keys: deviceStripKeys)
            if let capabilities = device["capabilities"] as? [String: Any] {
                device["capabilities"] = strip(capabilities, keys: deviceCapabilityStripKeys)
            }
            result[key] = device
        }
        return result
    }

    static func filterDeviceResponse(_ data: Any?) -> Any? {
        guard var dict = data as? [String: Any],
              let devices = dict["devices"] as? [Any] else { return data }
        dict["devices"] = devices.map { raw -> Any in
            guard var device = raw as? [String: Any] else { return raw }
            device = strip(device, keys: deviceStripKeys)
            if let capabilities = device["capabilities"] as? [String: Any] {
                device["capabilities"] = strip(capabilities, keys: deviceCapabilityStripKeys)
            }
            return device
        }
        return dict
    }

    static func filterRecentlyPlayedResponse(_ data: Any?) -> Any? {
        guard var dict = data as? [String: Any],
              let items = dict["items"] as? [Any] else { return data }
        dict["items"] = items.map { raw -> Any in
            guard var item = raw as? [String: Any] else { return raw }
            item.removeValue(forKey: "context")
            if var track = item["track"] as? [String: Any] {
                track.removeValue(forKey: "popularity")
                track.removeValue(forKey: "track_number")
                track.removeValue(forKey: "duration_ms")
                track.removeValue(forKey: "explicit")
                item["track"] = track
            }
            return item
        }
        return filterRecursively(dict)
    }

    static func filterLyricsResponse(_ data: Any?) -> Any? {
        guard var dict = data as? [String: Any],
              var lyrics = dict["lyrics"] as? [String: Any] else { return data }

        dict.removeValue(forKey: "colors")
        dict.removeValue(forKey: "hasVocalRemoval")

        for key in ["alternatives", "capStatus", "isDenseTypeface", "isRtlLanguage",
                    "language", "provider", "providerDisplayName", "providerLyricsId",
                    "syncLyricsUri", "colors", "previewLines"] {
            lyrics.removeValue(forKey: key)
        }

        if let lines = lyrics["lines"] as? [Any] {
            lyrics["lines"] = lines.map { raw -> Any in
                guard var line = raw as? [String: Any] else { return raw }
                line.removeValue(forKey: "syllables")
                line.removeValue(forKey: "transliteratedWords")
                return line
            }
        }

        dict["lyrics"] = lyrics
        return dict
    }
}
