import Foundation
import Network
import os

@MainActor
final class LocalhostCallbackServer {
    private let log = Log.make(for: "LocalhostCallbackServer")
    private let port: UInt16
    private var listener: NWListener?
    private var continuation: CheckedContinuation<[String: String], Error>?
    private var connections: [NWConnection] = []

    init(port: UInt16) { self.port = port }

    func start() throws {
        guard let nwPort = NWEndpoint.Port(rawValue: port) else {
            throw HTTPError.status(0, "invalid port")
        }
        let params = NWParameters.tcp
        params.allowLocalEndpointReuse = true
        params.requiredInterfaceType = .loopback
        let listener = try NWListener(using: params, on: nwPort)
        listener.newConnectionHandler = { [weak self] conn in
            Task { @MainActor [weak self] in
                self?.handle(conn)
            }
        }
        listener.start(queue: .main)
        self.listener = listener
        log.info("LocalhostCallbackServer listening on 127.0.0.1:\(self.port, privacy: .public)")
    }

    func waitForCallback(timeout: TimeInterval = 300) async throws -> [String: String] {
        return try await withCheckedThrowingContinuation { cont in
            self.continuation = cont
            Task { @MainActor [weak self] in
                try? await Task.sleep(nanoseconds: UInt64(timeout * 1_000_000_000))
                self?.completeIfPending(.failure(HTTPError.status(0, "OAuth timeout — user did not authorize within \(Int(timeout))s")))
            }
        }
    }

    func stop() {
        listener?.cancel()
        listener = nil
        for conn in connections { conn.cancel() }
        connections.removeAll()
    }

    private func handle(_ conn: NWConnection) {
        connections.append(conn)
        conn.start(queue: .main)
        conn.receive(minimumIncompleteLength: 1, maximumLength: 65536) { [weak self] data, _, _, _ in
            Task { @MainActor [weak self] in
                guard let self else { return }
                let parsed = data.flatMap { self.parseRequestLine($0) }
                self.respondSuccess(on: conn)
                if let parsed {
                    self.completeIfPending(.success(parsed))
                }
            }
        }
    }

    private func parseRequestLine(_ data: Data) -> [String: String]? {
        guard let request = String(data: data, encoding: .utf8) else { return nil }
        guard let firstLine = request.split(separator: "\r\n").first else { return nil }
        let parts = firstLine.split(separator: " ")
        guard parts.count >= 2 else { return nil }
        let path = String(parts[1])
        guard let queryStart = path.firstIndex(of: "?") else { return [:] }
        let qs = String(path[path.index(after: queryStart)...])
        var params: [String: String] = [:]
        for pair in qs.split(separator: "&") {
            let kv = pair.split(separator: "=", maxSplits: 1)
            guard kv.count == 2 else { continue }
            let key = String(kv[0]).removingPercentEncoding ?? String(kv[0])
            let val = String(kv[1]).removingPercentEncoding ?? String(kv[1])
            params[key] = val
        }
        return params
    }

    private func respondSuccess(on conn: NWConnection) {
        let body = """
        <!doctype html><html><head><meta charset='utf-8'>
        <title>Nocturne</title>
        <style>body{font-family:-apple-system,system-ui,sans-serif;background:#0a0a0b;color:#e8e8ea;
        display:flex;align-items:center;justify-content:center;height:100vh;margin:0;text-align:center}
        h1{font-weight:600;margin:0 0 8px}p{color:#a1a1a4;margin:0}</style>
        </head><body><div><h1>Spotify linked</h1>
        <p>You can close this tab and return to Nocturne.</p></div></body></html>
        """
        let bytes = body.data(using: .utf8) ?? Data()
        let header = """
        HTTP/1.1 200 OK\r
        Content-Type: text/html; charset=utf-8\r
        Content-Length: \(bytes.count)\r
        Connection: close\r
        \r

        """
        var response = header.data(using: .utf8) ?? Data()
        response.append(bytes)
        conn.send(content: response, completion: .contentProcessed { _ in
            conn.cancel()
        })
    }

    private func completeIfPending(_ result: Result<[String: String], Error>) {
        guard let cont = continuation else { return }
        continuation = nil
        cont.resume(with: result)
    }
}
