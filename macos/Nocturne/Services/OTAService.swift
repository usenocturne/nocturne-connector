import Foundation
import CryptoKit
import os

struct OTAUpdateCheck: Decodable {
    struct Metadata: Decodable {
        let autoUpdateable: Bool
        let critical: Bool

        enum CodingKeys: String, CodingKey {
            case autoUpdateable = "auto_updateable"
            case critical
        }
    }

    let updateAvailable: Bool
    let version: String?
    let channel: String?
    let metadata: Metadata?
}

struct OTAError: LocalizedError {
    let message: String
    init(_ message: String) { self.message = message }
    var errorDescription: String? { message }
}

final class OTAService: Sendable {
    private let log = Log.make(for: "OTAService")
    private let session: URLSession

    init() {
        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = 120
        config.timeoutIntervalForResource = 600
        config.requestCachePolicy = .reloadIgnoringLocalCacheData
        session = URLSession(configuration: config)
    }

    func checkForUpdates(currentVersion: String, channel: String) async throws -> OTAUpdateCheck {
        let request = try makeRequest(path: "check-update", body: [
            "currentVersion": currentVersion,
            "channel": channel
        ])
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw OTAError("OTA server returned an invalid response")
        }
        guard (200..<300).contains(http.statusCode) else {
            throw OTAError("OTA server returned \(http.statusCode)")
        }
        let result = try JSONDecoder().decode(OTAUpdateCheck.self, from: data)
        if result.updateAvailable {
            log.info("Update available: \(result.version ?? "?", privacy: .public)")
        } else {
            log.info("No updates available")
        }
        return result
    }

    func downloadUpdate(currentVersion: String, targetVersion: String) async throws -> URL {
        log.info("Downloading update: \(currentVersion, privacy: .public) -> \(targetVersion, privacy: .public)")
        let request = try makeRequest(path: "update", body: [
            "currentVersion": currentVersion,
            "targetVersion": targetVersion
        ])
        let (tempURL, response) = try await session.download(for: request)
        guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
            try? FileManager.default.removeItem(at: tempURL)
            let status = (response as? HTTPURLResponse)?.statusCode ?? -1
            throw OTAError("Download failed: \(status)")
        }

        let dir = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("nocturne-ota", isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let dest = dir.appendingPathComponent("nocturne-update.swu")
        try? FileManager.default.removeItem(at: dest)
        try FileManager.default.moveItem(at: tempURL, to: dest)

        let size = try fileSize(at: dest)
        log.info("Downloaded \(size, privacy: .public) bytes to \(dest.path, privacy: .public)")
        return dest
    }

    func readChunk(at url: URL, offset: Int, size: Int) async throws -> String {
        guard FileManager.default.fileExists(atPath: url.path) else {
            throw OTAError("Update file not found")
        }
        let totalSize = try fileSize(at: url)
        guard offset >= 0, offset < totalSize else {
            throw OTAError("Invalid offset: \(offset)")
        }
        let handle = try FileHandle(forReadingFrom: url)
        defer { try? handle.close() }
        try handle.seek(toOffset: UInt64(offset))
        let bytesToRead = min(size, totalSize - offset)
        let data = try handle.read(upToCount: bytesToRead) ?? Data()
        return data.base64EncodedString()
    }

    func calculateMD5(at url: URL) async throws -> String {
        guard FileManager.default.fileExists(atPath: url.path) else {
            throw OTAError("Update file not found")
        }
        let handle = try FileHandle(forReadingFrom: url)
        defer { try? handle.close() }
        var hasher = Insecure.MD5()
        while true {
            guard let chunk = try handle.read(upToCount: 1_048_576), !chunk.isEmpty else { break }
            hasher.update(data: chunk)
        }
        return hasher.finalize().map { String(format: "%02x", $0) }.joined()
    }

    func fileSize(at url: URL) throws -> Int {
        let attrs = try FileManager.default.attributesOfItem(atPath: url.path)
        guard let size = (attrs[.size] as? NSNumber)?.intValue else {
            throw OTAError("Update file not found")
        }
        return size
    }

    private func makeRequest(path: String, body: [String: String]) throws -> URLRequest {
        var request = URLRequest(url: AppConfig.otaServerURL.appendingPathComponent(path))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONSerialization.data(withJSONObject: body)
        return request
    }
}
