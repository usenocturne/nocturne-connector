import AppKit
import Combine
import Foundation
import ImageIO
import UniformTypeIdentifiers
import os

@MainActor
final class NowPlayingService: ObservableObject {
    private let log = Log.make(for: "NowPlayingService")

    var onNowPlaying: (([String: Any]) -> Void)?
    var onArtwork: ((String) -> Void)?
    var onVolumeChanged: ((Int) -> Void)?

    private(set) var latestNowPlaying: [String: Any]?
    private(set) var latestArtwork: String?

    private let volume = SystemVolumeController()
    var currentVolumePercent: Int? { volume.lastKnownPercent }

    @Published private(set) var isSystemMediaEnabled = SessionStore.shared.systemMediaEnabled
    @Published private(set) var isForcedOn = false
    var isActive: Bool { isSystemMediaEnabled || isForcedOn }

    private var streamProcess: Process?
    private var stdoutBuffer = Data()
    private var stdoutScannedCount = 0
    private var streamGeneration: UInt64 = 0
    private var restartTask: Task<Void, Never>?
    private var restartDelaySeconds: UInt64 = 1
    private var started = false
    private var running = false
    private var terminationObserver: NSObjectProtocol?
    private var state: [String: Any] = [:]
    private var lastMediaSnapshot: [String: Any]?
    private var currentTrackKey: String?
    private var lastArtworkTrackKey: String?
    private var lastArtworkFingerprint: Int?
    private var artworkEncodeTask: Task<Void, Never>?
    private var appNameCache: [String: String] = [:]

    private static var frameworkURL: URL? {
        Bundle.main.privateFrameworksURL?.appendingPathComponent("MediaRemoteAdapter.framework")
    }

    private static var adapterScriptURL: URL? {
        frameworkURL?.appendingPathComponent("Resources/mediaremote-adapter.pl")
    }

    func start() {
        guard !started else { return }
        started = true
        volume.onVolumeChanged = { [weak self] percent in
            self?.onVolumeChanged?(percent)
        }
        terminationObserver = NotificationCenter.default.addObserver(
            forName: NSApplication.willTerminateNotification, object: nil, queue: .main
        ) { [weak self] _ in
            MainActor.assumeIsolated {
                self?.teardownStream()
            }
        }
        applyActivation()
    }

    func setSystemMediaEnabled(_ enabled: Bool) {
        guard isSystemMediaEnabled != enabled else { return }
        SessionStore.shared.systemMediaEnabled = enabled
        isSystemMediaEnabled = enabled
        applyActivation()
    }

    func setForcedOn(_ forced: Bool) {
        guard isForcedOn != forced else { return }
        isForcedOn = forced
        applyActivation()
    }

    private func applyActivation() {
        guard started else { return }
        if isActive {
            guard !running else { return }
            running = true
            log.info("System media reporting enabled")
            volume.start()
            launchStream()
        } else {
            guard running else { return }
            running = false
            log.info("System media reporting disabled")
            restartTask?.cancel()
            restartTask = nil
            teardownStream()
            volume.stop()
            state = [:]
            emitStoppedForLastMediaIfNeeded()
            lastMediaSnapshot = nil
            latestNowPlaying = nil
            latestArtwork = nil
            currentTrackKey = nil
            lastArtworkTrackKey = nil
            lastArtworkFingerprint = nil
            artworkEncodeTask?.cancel()
            artworkEncodeTask = nil
        }
    }

    func replayLatest() {
        guard isActive else { return }
        if let payload = latestNowPlaying {
            onNowPlaying?(payload)
        }
        if let artwork = latestArtwork {
            onArtwork?(artwork)
        }
    }

    // MARK: - Adapter stream

    private func launchStream() {
        guard streamProcess == nil else { return }
        guard let framework = Self.frameworkURL,
              let script = Self.adapterScriptURL,
              FileManager.default.fileExists(atPath: script.path) else {
            log.error("MediaRemoteAdapter not found in app bundle; system media reporting disabled")
            return
        }

        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/perl")
        process.arguments = [script.path, framework.path, "stream", "--debounce=150"]
        let stdout = Pipe()
        process.standardOutput = stdout
        process.standardError = FileHandle.nullDevice

        let generation = streamGeneration
        stdout.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            guard !data.isEmpty else { return }
            Task { @MainActor [weak self] in
                self?.consumeStreamData(data, generation: generation)
            }
        }
        process.terminationHandler = { [weak self] proc in
            Task { @MainActor [weak self] in
                self?.handleStreamExit(status: proc.terminationStatus, generation: generation)
            }
        }

        do {
            try process.run()
            streamProcess = process
            log.info("MediaRemote adapter stream started (pid \(process.processIdentifier, privacy: .public))")
        } catch {
            log.error("Failed to launch MediaRemote adapter: \(error.localizedDescription, privacy: .public)")
            scheduleRestart()
        }
    }

    private func teardownStream() {
        streamGeneration &+= 1
        if let process = streamProcess {
            process.terminationHandler = nil
            (process.standardOutput as? Pipe)?.fileHandleForReading.readabilityHandler = nil
            if process.isRunning { process.terminate() }
        }
        streamProcess = nil
        stdoutBuffer.removeAll()
        stdoutScannedCount = 0
    }

    private func handleStreamExit(status: Int32, generation: UInt64) {
        guard generation == streamGeneration else { return }
        log.warning("MediaRemote adapter stream exited (status \(status, privacy: .public))")
        teardownStream()
        scheduleRestart()
    }

    private func scheduleRestart() {
        guard running, restartTask == nil else { return }
        let delay = restartDelaySeconds
        restartDelaySeconds = min(restartDelaySeconds * 2, 30)
        restartTask = Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: delay * 1_000_000_000)
            guard let self, self.running else { return }
            self.restartTask = nil
            self.launchStream()
        }
    }

    private func consumeStreamData(_ data: Data, generation: UInt64) {
        guard running, generation == streamGeneration else { return }
        stdoutBuffer.append(data)
        while true {
            let searchStart = stdoutBuffer.index(stdoutBuffer.startIndex, offsetBy: stdoutScannedCount)
            guard let nlIndex = stdoutBuffer[searchStart...].firstIndex(of: 0x0A) else {
                stdoutScannedCount = stdoutBuffer.count
                return
            }
            let line = stdoutBuffer.subdata(in: stdoutBuffer.startIndex..<nlIndex)
            stdoutBuffer.removeSubrange(stdoutBuffer.startIndex...nlIndex)
            stdoutScannedCount = 0
            guard !line.isEmpty else { continue }
            handleStreamLine(line)
        }
    }

    private func handleStreamLine(_ line: Data) {
        guard let obj = (try? JSONSerialization.jsonObject(with: line)) as? [String: Any],
              obj["type"] as? String == "data" else { return }
        restartDelaySeconds = 1

        let payload = obj["payload"] as? [String: Any] ?? [:]
        if obj["diff"] as? Bool == true {
            for (key, value) in payload {
                if value is NSNull {
                    state.removeValue(forKey: key)
                } else {
                    state[key] = value
                }
            }
        } else {
            state = payload.filter { !($0.value is NSNull) }
        }
        stateChanged()
    }

    // MARK: - Event construction (nocturne-app wire format)

    private func stateChanged() {
        let title = state["title"] as? String
        let artist = state["artist"] as? String
        let album = state["album"] as? String
        let bundleID = state["bundleIdentifier"] as? String
        let hasContent = !(title ?? "").isEmpty || !(artist ?? "").isEmpty

        guard hasContent else {
            emitStoppedForLastMediaIfNeeded()
            return
        }

        let trackKey = "\(bundleID ?? "")|\(title ?? "")|\(artist ?? "")|\(album ?? "")"
        if trackKey != currentTrackKey {
            currentTrackKey = trackKey
            latestArtwork = nil
        }

        var media: [String: Any] = [:]
        if let title { media["MediaItemTitle"] = title }
        if let artist { media["MediaItemArtist"] = artist }
        if let album { media["MediaItemAlbumName"] = album }
        if let seconds = (state["duration"] as? NSNumber)?.doubleValue, seconds > 0 {
            let durationMs = Int64(seconds * 1000)
            media["MediaItemPlaybackDurationInMilliseconds"] = durationMs
            media["MediaItemPlaybackDurationInMilliSeconds"] = durationMs
        }

        var playback: [String: Any] = [
            "PlaybackStatus": playbackStatus(),
            "PlaybackShuffleMode": shuffleModeString(),
            "PlaybackRepeatMode": repeatModeString(),
        ]
        if let appName = appName(for: bundleID) {
            playback["PlaybackAppName"] = appName
        }

        let payload: [String: Any] = [
            "MediaItemAttributes": media,
            "PlaybackAttributes": playback,
        ]

        lastMediaSnapshot = media
        if (latestNowPlaying as NSDictionary?) != (payload as NSDictionary) {
            latestNowPlaying = payload
            log.info("media.nowPlaying.update: \(title ?? "?", privacy: .public) — \(artist ?? "?", privacy: .public) [\(playback["PlaybackStatus"] as? String ?? "", privacy: .public)]")
            onNowPlaying?(payload)
        }

        emitArtworkIfNeeded(trackKey: trackKey)
    }

    private func playbackStatus() -> String {
        switch state["playing"] as? Bool {
        case true: return "playing"
        case false: return "paused"
        default: return "unknown"
        }
    }

    private func shuffleModeString() -> String {
        switch (state["shuffleMode"] as? NSNumber)?.intValue {
        case 2: return "albums"
        case 3: return "songs"
        default: return "off"
        }
    }

    private func repeatModeString() -> String {
        switch (state["repeatMode"] as? NSNumber)?.intValue {
        case 2: return "one"
        case 3: return "all"
        default: return "off"
        }
    }

    private func emitStoppedForLastMediaIfNeeded() {
        guard let media = lastMediaSnapshot,
              let last = latestNowPlaying,
              (last["PlaybackAttributes"] as? [String: Any])?["PlaybackStatus"] as? String != "stopped" else { return }

        var playback = (last["PlaybackAttributes"] as? [String: Any]) ?? [:]
        playback["PlaybackStatus"] = "stopped"
        let payload: [String: Any] = [
            "MediaItemAttributes": media,
            "PlaybackAttributes": playback,
        ]
        latestNowPlaying = payload
        log.info("media.nowPlaying.update: stopped")
        onNowPlaying?(payload)
    }

    private func emitArtworkIfNeeded(trackKey: String) {
        guard let artworkBase64 = state["artworkData"] as? String, !artworkBase64.isEmpty else { return }

        let fingerprint = artworkBase64.count &* 31 &+ (artworkBase64.suffix(64).hashValue)
        guard trackKey != lastArtworkTrackKey || fingerprint != lastArtworkFingerprint else { return }

        artworkEncodeTask?.cancel()
        artworkEncodeTask = Task { [weak self] in
            let jpegBase64 = await Task.detached(priority: .utility, operation: {
                Self.reencodeArtworkAsJPEG(base64: artworkBase64)
            }).value
            guard let self, !Task.isCancelled, self.currentTrackKey == trackKey else { return }
            guard let jpegBase64 else { return }
            self.lastArtworkTrackKey = trackKey
            self.lastArtworkFingerprint = fingerprint
            self.latestArtwork = jpegBase64
            self.log.info("media.nowPlaying.artwork: \(jpegBase64.count, privacy: .public) base64 chars")
            self.onArtwork?(jpegBase64)
        }
    }

    nonisolated private static func reencodeArtworkAsJPEG(base64: String) -> String? {
        guard let raw = Data(base64Encoded: base64),
              let source = CGImageSourceCreateWithData(raw as CFData, nil) else { return nil }
        let thumbnailOptions: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceThumbnailMaxPixelSize: 600,
        ]
        guard let image = CGImageSourceCreateThumbnailAtIndex(source, 0, thumbnailOptions as CFDictionary) else { return nil }
        let output = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(
            output, UTType.jpeg.identifier as CFString, 1, nil
        ) else { return nil }
        CGImageDestinationAddImage(destination, image, [
            kCGImageDestinationLossyCompressionQuality: 0.8,
        ] as CFDictionary)
        guard CGImageDestinationFinalize(destination) else { return nil }
        return (output as Data).base64EncodedString()
    }

    private func appName(for bundleID: String?) -> String? {
        guard let bundleID, !bundleID.isEmpty else { return nil }
        if let cached = appNameCache[bundleID] { return cached }

        var name: String?
        if let pid = (state["processIdentifier"] as? NSNumber)?.int32Value,
           let app = NSRunningApplication(processIdentifier: pid) {
            name = app.localizedName
        }
        if name == nil,
           let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: bundleID) {
            let bundle = Bundle(url: url)
            name = bundle?.object(forInfoDictionaryKey: "CFBundleDisplayName") as? String
                ?? bundle?.object(forInfoDictionaryKey: "CFBundleName") as? String
                ?? url.deletingPathExtension().lastPathComponent
        }
        let resolved = name ?? bundleID
        appNameCache[bundleID] = resolved
        return resolved
    }

    // MARK: - Media control (Car Thing → Mac)

    func handleMediaControl(_ method: String) -> [String: Any] {
        guard isActive else {
            log.info("Ignoring \(method, privacy: .public): system media disabled")
            return ["status": "disabled", "method": method]
        }
        let action = method.hasPrefix("media.control.")
            ? String(method.dropFirst("media.control.".count))
            : method

        switch action {
        case "play": sendAdapterCommand(0)
        case "pause", "stop": sendAdapterCommand(1)
        case "playPause", "toggle", "togglePlayPause": sendAdapterCommand(2)
        case "next": sendAdapterCommand(4)
        case "previous", "prev": sendAdapterCommand(5)
        case "shuffle": sendAdapterCommand(6)
        case "repeat": sendAdapterCommand(7)
        case "volumeUp": volume.step(by: 0.0625)
        case "volumeDown": volume.step(by: -0.0625)
        default:
            log.warning("Unknown media control: \(method, privacy: .public)")
            return ["status": "unknown", "method": method]
        }
        return ["status": "ok", "method": method]
    }

    private func sendAdapterCommand(_ commandID: Int) {
        guard let framework = Self.frameworkURL, let script = Self.adapterScriptURL else { return }
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/perl")
        process.arguments = [script.path, framework.path, "send", String(commandID)]
        process.standardOutput = FileHandle.nullDevice
        process.standardError = FileHandle.nullDevice
        do {
            try process.run()
            log.info("Sent MediaRemote command \(commandID, privacy: .public)")
        } catch {
            log.error("MediaRemote command \(commandID, privacy: .public) failed: \(error.localizedDescription, privacy: .public)")
        }
    }
}
