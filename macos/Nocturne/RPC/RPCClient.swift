import Foundation
import os

@MainActor
final class RPCClient {
    typealias CallHandler = (String, MessagePackValue) async -> (result: MessagePackValue?, error: String?)
    typealias EventHandler = (String, MessagePackValue) -> Void

    var onCall: CallHandler?
    var onEvent: EventHandler?
    var onWrite: ((Data) -> Void)?

    private let log = Log.make(for: "RPCClient")
    private let id: String

    private var inputBuffer = Data()
    private let assembler = ChunkedMessageAssembler()
    private var pendingRequests: [String: CheckedContinuation<MessagePackValue, Error>] = [:]
    private var pendingTimers: [String: Task<Void, Never>] = [:]
    private var sentChunks: [String: [Data]] = [:]
    private var sentChunkOrder: [String] = []
    private let sentChunksLimit = 32
    private var invalidBase64SampleCount = 0
    private var cleanupTask: Task<Void, Never>?
    private static let cleanupIntervalNs: UInt64 = 30 * 1_000_000_000

    init(id: String) {
        self.id = id
        startPeriodicCleanup()
    }

    func ingest(_ data: Data) async {
        inputBuffer.append(data)
        await processBuffer()
    }

    private func processBuffer() async {
        while true {
            guard let nlIndex = inputBuffer.firstIndex(of: 0x0A) else { return }
            let line = inputBuffer.subdata(in: inputBuffer.startIndex..<nlIndex)
            inputBuffer.removeSubrange(inputBuffer.startIndex...nlIndex)
            if line.isEmpty { continue }

            let trimmed = stripTrailingWhitespace(line)
            if trimmed.isEmpty { continue }

            guard let decoded = Data(base64Encoded: trimmed, options: [.ignoreUnknownCharacters]) else {
                if invalidBase64SampleCount < 3 {
                    invalidBase64SampleCount += 1
                    let preview = trimmed.prefix(48).map { String(format: "%02X", $0) }.joined(separator: " ")
                    let asciiPreview = String(data: trimmed.prefix(48), encoding: .ascii) ?? "<not ascii>"
                    log.warning("Invalid base64 line (\(line.count, privacy: .public) bytes) hex: \(preview, privacy: .public) ascii: \(asciiPreview, privacy: .public)")
                } else {
                    log.warning("Invalid base64 line (\(line.count, privacy: .public) bytes)")
                }
                continue
            }

            if let msg = try? RPCMessage.decode(from: decoded) {
                await handle(msg)
                continue
            }

            let result = Chunking.parseChunk(decoded)
            switch result {
            case .needMoreData:
                continue
            case .invalid(let reason, _):
                log.warning("Failed to parse line: \(reason, privacy: .public)")
                continue
            case .success(let env, let payload, _):
                if env.total == 1 {
                    do {
                        let msg = try RPCMessage.decode(from: payload)
                        await handle(msg)
                    } catch {
                        log.warning("decode single-chunk payload: \(error.localizedDescription, privacy: .public)")
                    }
                } else if let assembled = assembler.addChunk(
                    messageId: env.messageId,
                    index: env.index,
                    total: env.total,
                    payload: payload
                ) {
                    do {
                        let msg = try RPCMessage.decode(from: assembled)
                        await handle(msg)
                    } catch {
                        log.warning("decode multi-chunk payload: \(error.localizedDescription, privacy: .public)")
                    }
                }
            }
        }
    }

    private func handle(_ msg: RPCMessage) async {
        switch msg {
        case .result(let id, let value):
            if let cont = pendingRequests.removeValue(forKey: id) {
                pendingTimers.removeValue(forKey: id)?.cancel()
                cont.resume(returning: value)
            }
        case .error(let id, let err):
            if let cont = pendingRequests.removeValue(forKey: id) {
                pendingTimers.removeValue(forKey: id)?.cancel()
                cont.resume(throwing: RPCError.remote(err))
            }
        case .event(let topic, let data):
            log.info("RPC event ← \(topic, privacy: .public)")
            onEvent?(topic, data)
        case .call(let id, let method, let params):
            log.info("RPC call ← \(method, privacy: .public)")
            let response: (result: MessagePackValue?, error: String?)
            if let handler = onCall {
                response = await handler(method, params)
            } else {
                response = (nil, "no handler")
            }
            let reply: RPCMessage = response.error.map { .error(id: id, error: $0) }
                ?? .result(id: id, result: response.result ?? .nilValue)
            await send(reply)
        }
    }

    @discardableResult
    func call(method: String, params: MessagePackValue, timeout: TimeInterval = 30) async throws -> MessagePackValue {
        let id = UUID().uuidString.lowercased()
        let msg = RPCMessage.call(id: id, method: method, params: params)
        return try await withCheckedThrowingContinuation { cont in
            pendingRequests[id] = cont
            pendingTimers[id] = Task { @MainActor [weak self] in
                try? await Task.sleep(nanoseconds: UInt64(timeout * 1_000_000_000))
                guard let self else { return }
                if let cont = self.pendingRequests.removeValue(forKey: id) {
                    self.pendingTimers.removeValue(forKey: id)
                    cont.resume(throwing: RPCError.timeout(method))
                }
            }
            Task { @MainActor in
                await self.send(msg)
            }
        }
    }

    func sendEvent(topic: String, data: MessagePackValue) async {
        await send(.event(topic: topic, data: data))
    }

    private func send(_ msg: RPCMessage) async {
        let encoded = msg.encoded()
        let messageId = msg.id
        let chunks = Chunking.createChunks(data: encoded, messageId: messageId)
        rememberChunks(chunks, messageId: messageId)
        for (i, chunk) in chunks.enumerated() {
            let line = chunk.base64EncodedData() + Data([0x0A])
            onWrite?(line)
            if i < chunks.count - 1 {
                try? await Task.sleep(nanoseconds: 5 * 1_000_000)
            }
        }
    }

    private func rememberChunks(_ chunks: [Data], messageId: String) {
        if sentChunks[messageId] == nil {
            sentChunkOrder.append(messageId)
        }
        sentChunks[messageId] = chunks
        while sentChunkOrder.count > sentChunksLimit {
            sentChunks.removeValue(forKey: sentChunkOrder.removeFirst())
        }
    }

    private func startPeriodicCleanup() {
        cleanupTask = Task { @MainActor [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: Self.cleanupIntervalNs)
                guard let self, !Task.isCancelled else { return }
                self.assembler.cleanupStale()
            }
        }
    }

    func retransmitChunk(messageId: String, chunkIndex: Int) {
        guard let chunks = sentChunks[messageId], chunks.indices.contains(chunkIndex) else {
            log.error("Cannot retransmit chunk \(chunkIndex, privacy: .public) for \(messageId, privacy: .public): not found")
            return
        }
        log.warning("Retransmitting chunk \(chunkIndex + 1, privacy: .public) for \(messageId, privacy: .public)")
        onWrite?(chunks[chunkIndex].base64EncodedData() + Data([0x0A]))
    }

    func cleanup() {
        cleanupTask?.cancel()
        cleanupTask = nil
        for (_, cont) in pendingRequests {
            cont.resume(throwing: RPCError.disconnected)
        }
        pendingRequests.removeAll()
        for (_, task) in pendingTimers { task.cancel() }
        pendingTimers.removeAll()
        inputBuffer.removeAll()
        assembler.clear()
        sentChunks.removeAll()
        sentChunkOrder.removeAll()
    }

    private func stripTrailingWhitespace(_ d: Data) -> Data {
        var end = d.endIndex
        while end > d.startIndex {
            let b = d[end - 1]
            if b == 0x0D || b == 0x20 || b == 0x09 || b == 0x0A {
                end -= 1
            } else { break }
        }
        return d.subdata(in: d.startIndex..<end)
    }
}

enum RPCError: LocalizedError {
    case remote(String)
    case timeout(String)
    case disconnected

    var errorDescription: String? {
        switch self {
        case .remote(let m): return m
        case .timeout(let method): return "RPC call timed out: \(method)"
        case .disconnected: return "RPC channel disconnected"
        }
    }
}
