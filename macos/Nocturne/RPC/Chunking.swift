import Foundation

/// Chunked transport framing — port of `src/server/rpc/chunking.ts`.
///
/// Each chunk is:
///   [1 byte  id length]
///   [N bytes UUID id (36 ASCII bytes)]
///   [2 bytes BE chunk index]
///   [2 bytes BE total chunks]
///   [4 bytes BE CRC32 of payload]
///   [2 bytes BE payload length]
///   [payload bytes...]
///
/// CRC32 polynomial is the standard reflected 0xEDB88320 (IEEE 802.3).
enum Chunking {

    static let crcPolynomial: UInt32 = 0xEDB88320

    static func crc32(_ data: Data) -> UInt32 {
        var crc: UInt32 = 0xFFFFFFFF
        for byte in data {
            crc ^= UInt32(byte)
            for _ in 0..<8 {
                if crc & 1 == 1 {
                    crc = (crc >> 1) ^ crcPolynomial
                } else {
                    crc >>= 1
                }
            }
        }
        return crc ^ 0xFFFFFFFF
    }

    struct Envelope: Equatable {
        let messageId: String
        let index: Int
        let total: Int
        let checksum: UInt32
        let payloadLength: Int
        let headerLength: Int
    }

    enum ParseResult {
        case success(envelope: Envelope, payload: Data, consumed: Int)
        case needMoreData
        case invalid(reason: String, dropBytes: Int)
    }

    static func createChunks(data: Data, messageId: String, chunkSize: Int = 2000) -> [Data] {
        let total = max(1, Int((Double(data.count) / Double(chunkSize)).rounded(.up)))
        guard let idBytes = messageId.data(using: .utf8) else { return [] }

        var chunks: [Data] = []
        chunks.reserveCapacity(total)

        for i in 0..<total {
            let start = i * chunkSize
            let end = min(start + chunkSize, data.count)
            let payload = data.subdata(in: start..<end)
            let checksum = crc32(payload)

            var chunk = Data()
            chunk.append(UInt8(idBytes.count))
            chunk.append(idBytes)
            appendBE(UInt16(i), into: &chunk)
            appendBE(UInt16(total), into: &chunk)
            appendBE(checksum, into: &chunk)
            appendBE(UInt16(payload.count), into: &chunk)
            chunk.append(payload)
            chunks.append(chunk)
        }

        return chunks
    }

    static func parseChunk(_ buffer: Data, maxPayloadSize: Int = 4096) -> ParseResult {
        guard !buffer.isEmpty else { return .needMoreData }

        let idLength = Int(buffer[buffer.startIndex])
        if idLength == 0 { return .invalid(reason: "id length is zero", dropBytes: 1) }
        if idLength > 64 { return .invalid(reason: "id length \(idLength) exceeds limit", dropBytes: 1) }

        let headerLength = 1 + idLength + 2 + 2 + 4 + 2
        if buffer.count < headerLength { return .needMoreData }

        let idStart = buffer.startIndex + 1
        let idEnd = idStart + idLength
        let idData = buffer.subdata(in: idStart..<idEnd)
        guard let messageId = String(data: idData, encoding: .utf8),
              messageId.count == idLength else {
            return .invalid(reason: "id length mismatch", dropBytes: headerLength)
        }

        if idLength != 36 || !isUUIDLike(messageId) {
            return .invalid(reason: "unexpected message id format", dropBytes: headerLength)
        }

        var cursor = idEnd
        let index = Int(readBE(buffer, &cursor, UInt16.self))
        let total = Int(readBE(buffer, &cursor, UInt16.self))

        if total == 0 { return .invalid(reason: "total is zero", dropBytes: headerLength) }
        if total > 1000 { return .invalid(reason: "total exceeds limit", dropBytes: headerLength) }
        if index >= total { return .invalid(reason: "index \(index) out of bounds", dropBytes: headerLength) }

        let checksum = readBE(buffer, &cursor, UInt32.self)
        let payloadLength = Int(readBE(buffer, &cursor, UInt16.self))

        if payloadLength > maxPayloadSize {
            return .invalid(reason: "payload too large: \(payloadLength)", dropBytes: headerLength)
        }

        let totalNeeded = headerLength + payloadLength
        if buffer.count < totalNeeded { return .needMoreData }

        let payloadStart = buffer.startIndex + headerLength
        let payloadEnd = payloadStart + payloadLength
        let payload = buffer.subdata(in: payloadStart..<payloadEnd)
        let computedCrc = crc32(payload)
        if computedCrc != checksum {
            return .invalid(reason: "checksum mismatch", dropBytes: 1)
        }

        let envelope = Envelope(
            messageId: messageId,
            index: index,
            total: total,
            checksum: checksum,
            payloadLength: payloadLength,
            headerLength: headerLength
        )
        return .success(envelope: envelope, payload: payload, consumed: totalNeeded)
    }

    private static func isUUIDLike(_ value: String) -> Bool {
        guard value.count == 36 else { return false }
        let chars = Array(value)
        return chars[8] == "-" && chars[13] == "-" && chars[18] == "-" && chars[23] == "-"
    }

    private static func appendBE<T: FixedWidthInteger>(_ value: T, into out: inout Data) {
        let be = value.bigEndian
        withUnsafeBytes(of: be) { out.append(contentsOf: $0) }
    }

    private static func readBE<T: FixedWidthInteger>(_ data: Data, _ cursor: inout Int, _ type: T.Type) -> T {
        let size = MemoryLayout<T>.size
        var value: T = 0
        for i in 0..<size {
            value = (value << 8) | T(data[data.startIndex + cursor + i])
        }
        cursor += size
        return value
    }
}

final class ChunkedMessageAssembler {
    private struct Pending {
        var total: Int
        var chunks: [Int: Data]
        var updatedAt: Date
    }

    private static let pendingTTL: TimeInterval = 30
    private static let maxPendingMessages = 5

    private var pending: [String: Pending] = [:]

    var pendingCount: Int { pending.count }

    func addChunk(messageId: String, index: Int, total: Int, payload: Data) -> Data? {
        cleanupStale()

        var entry: Pending
        if let existing = pending[messageId], existing.total == total {
            entry = existing
        } else {
            entry = Pending(total: total, chunks: [:], updatedAt: Date())
        }
        entry.chunks[index] = payload
        entry.updatedAt = Date()
        pending[messageId] = entry

        if entry.chunks.count == entry.total {
            pending.removeValue(forKey: messageId)
            var assembled = Data()
            for i in 0..<entry.total {
                guard let part = entry.chunks[i] else { return nil }
                assembled.append(part)
            }
            return assembled
        }
        enforcePendingLimit()
        return nil
    }

    func cleanupStale(now: Date = Date()) {
        let cutoff = now.addingTimeInterval(-Self.pendingTTL)
        pending = pending.filter { $0.value.updatedAt >= cutoff }
        enforcePendingLimit()
    }

    func clear() {
        pending.removeAll()
    }

    private func enforcePendingLimit() {
        guard pending.count > Self.maxPendingMessages else { return }
        let sortedIds = pending
            .sorted { $0.value.updatedAt < $1.value.updatedAt }
            .map(\.key)
        for messageId in sortedIds.dropLast(Self.maxPendingMessages) {
            pending.removeValue(forKey: messageId)
        }
    }
}
