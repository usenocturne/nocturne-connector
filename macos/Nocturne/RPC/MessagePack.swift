import Foundation

enum MessagePackValue: Equatable {
    case nilValue
    case bool(Bool)
    case int(Int64)
    case uint(UInt64)
    case double(Double)
    case string(String)
    case data(Data)
    case array([MessagePackValue])
    case map([(MessagePackValue, MessagePackValue)])

    static func == (lhs: MessagePackValue, rhs: MessagePackValue) -> Bool {
        switch (lhs, rhs) {
        case (.nilValue, .nilValue): return true
        case (.bool(let a), .bool(let b)): return a == b
        case (.int(let a), .int(let b)): return a == b
        case (.uint(let a), .uint(let b)): return a == b
        case (.double(let a), .double(let b)): return a == b
        case (.string(let a), .string(let b)): return a == b
        case (.data(let a), .data(let b)): return a == b
        case (.array(let a), .array(let b)): return a == b
        case (.map(let a), .map(let b)):
            guard a.count == b.count else { return false }
            for (ka, va) in a {
                if !b.contains(where: { $0.0 == ka && $0.1 == va }) { return false }
            }
            return true
        default: return false
        }
    }

    var stringValue: String? {
        if case .string(let s) = self { return s }
        return nil
    }
    var intValue: Int? {
        if case .int(let i) = self { return Int(i) }
        if case .uint(let u) = self { return Int(u) }
        return nil
    }
    var boolValue: Bool? {
        if case .bool(let b) = self { return b }
        return nil
    }
    var arrayValue: [MessagePackValue]? {
        if case .array(let a) = self { return a }
        return nil
    }
    func mapValue(_ key: String) -> MessagePackValue? {
        if case .map(let entries) = self {
            return entries.first(where: { $0.0.stringValue == key })?.1
        }
        return nil
    }
}

enum MessagePackError: Error {
    case truncated
    case unsupportedType(UInt8)
    case malformed(String)
}

enum MessagePack {

    static func encode(_ value: MessagePackValue) -> Data {
        var out = Data()
        encode(value, into: &out)
        return out
    }

    private static func encode(_ value: MessagePackValue, into out: inout Data) {
        switch value {
        case .nilValue:
            out.append(0xc0)
        case .bool(let b):
            out.append(b ? 0xc3 : 0xc2)
        case .int(let i):
            encodeInt(i, into: &out)
        case .uint(let u):
            encodeUInt(u, into: &out)
        case .double(let d):
            out.append(0xcb)
            let bits = d.bitPattern.bigEndian
            withUnsafeBytes(of: bits) { out.append(contentsOf: $0) }
        case .string(let s):
            let bytes = Array(s.utf8)
            let n = bytes.count
            if n < 32 {
                out.append(0xa0 | UInt8(n))
            } else if n <= 0xff {
                out.append(0xd9); out.append(UInt8(n))
            } else if n <= 0xffff {
                out.append(0xda); appendBigEndian(UInt16(n), into: &out)
            } else {
                out.append(0xdb); appendBigEndian(UInt32(n), into: &out)
            }
            out.append(contentsOf: bytes)
        case .data(let d):
            let n = d.count
            if n <= 0xff {
                out.append(0xc4); out.append(UInt8(n))
            } else if n <= 0xffff {
                out.append(0xc5); appendBigEndian(UInt16(n), into: &out)
            } else {
                out.append(0xc6); appendBigEndian(UInt32(n), into: &out)
            }
            out.append(d)
        case .array(let a):
            let n = a.count
            if n < 16 {
                out.append(0x90 | UInt8(n))
            } else if n <= 0xffff {
                out.append(0xdc); appendBigEndian(UInt16(n), into: &out)
            } else {
                out.append(0xdd); appendBigEndian(UInt32(n), into: &out)
            }
            for v in a { encode(v, into: &out) }
        case .map(let m):
            let n = m.count
            if n < 16 {
                out.append(0x80 | UInt8(n))
            } else if n <= 0xffff {
                out.append(0xde); appendBigEndian(UInt16(n), into: &out)
            } else {
                out.append(0xdf); appendBigEndian(UInt32(n), into: &out)
            }
            for (k, v) in m {
                encode(k, into: &out)
                encode(v, into: &out)
            }
        }
    }

    private static func encodeInt(_ i: Int64, into out: inout Data) {
        if i >= 0 {
            encodeUInt(UInt64(i), into: &out)
            return
        }
        if i >= -32 {
            out.append(UInt8(bitPattern: Int8(i)))
        } else if i >= Int64(Int8.min) {
            out.append(0xd0); out.append(UInt8(bitPattern: Int8(i)))
        } else if i >= Int64(Int16.min) {
            out.append(0xd1); appendBigEndian(UInt16(bitPattern: Int16(i)), into: &out)
        } else if i >= Int64(Int32.min) {
            out.append(0xd2); appendBigEndian(UInt32(bitPattern: Int32(i)), into: &out)
        } else {
            out.append(0xd3); appendBigEndian(UInt64(bitPattern: i), into: &out)
        }
    }

    private static func encodeUInt(_ u: UInt64, into out: inout Data) {
        if u <= 0x7f {
            out.append(UInt8(u))
        } else if u <= UInt64(UInt8.max) {
            out.append(0xcc); out.append(UInt8(u))
        } else if u <= UInt64(UInt16.max) {
            out.append(0xcd); appendBigEndian(UInt16(u), into: &out)
        } else if u <= UInt64(UInt32.max) {
            out.append(0xce); appendBigEndian(UInt32(u), into: &out)
        } else {
            out.append(0xcf); appendBigEndian(u, into: &out)
        }
    }

    private static func appendBigEndian<T: FixedWidthInteger>(_ value: T, into out: inout Data) {
        let be = value.bigEndian
        withUnsafeBytes(of: be) { out.append(contentsOf: $0) }
    }

    static func decode(_ data: Data) throws -> MessagePackValue {
        var cursor = 0
        let value = try decode(data, cursor: &cursor)
        return value
    }

    private static func decode(_ data: Data, cursor: inout Int) throws -> MessagePackValue {
        guard cursor < data.count else { throw MessagePackError.truncated }
        let b = data[data.startIndex + cursor]
        cursor += 1

        if b & 0x80 == 0 { return .uint(UInt64(b)) }
        if b & 0xe0 == 0xe0 { return .int(Int64(Int8(bitPattern: b))) }
        if b & 0xf0 == 0x80 {
            return try decodeMap(count: Int(b & 0x0f), data: data, cursor: &cursor)
        }
        if b & 0xf0 == 0x90 {
            return try decodeArray(count: Int(b & 0x0f), data: data, cursor: &cursor)
        }
        if b & 0xe0 == 0xa0 {
            return try decodeString(count: Int(b & 0x1f), data: data, cursor: &cursor)
        }

        switch b {
        case 0xc0: return .nilValue
        case 0xc2: return .bool(false)
        case 0xc3: return .bool(true)
        case 0xc4: let n = try readUInt8(data, &cursor); return .data(try readBytes(data, &cursor, count: Int(n)))
        case 0xc5: let n = try readBigEndian(data, &cursor, UInt16.self); return .data(try readBytes(data, &cursor, count: Int(n)))
        case 0xc6: let n = try readBigEndian(data, &cursor, UInt32.self); return .data(try readBytes(data, &cursor, count: Int(n)))
        case 0xca:
            let raw = try readBigEndian(data, &cursor, UInt32.self)
            return .double(Double(Float(bitPattern: raw)))
        case 0xcb:
            let raw = try readBigEndian(data, &cursor, UInt64.self)
            return .double(Double(bitPattern: raw))
        case 0xcc: return .uint(UInt64(try readUInt8(data, &cursor)))
        case 0xcd: return .uint(UInt64(try readBigEndian(data, &cursor, UInt16.self)))
        case 0xce: return .uint(UInt64(try readBigEndian(data, &cursor, UInt32.self)))
        case 0xcf: return .uint(try readBigEndian(data, &cursor, UInt64.self))
        case 0xd0: return .int(Int64(Int8(bitPattern: try readUInt8(data, &cursor))))
        case 0xd1: return .int(Int64(Int16(bitPattern: try readBigEndian(data, &cursor, UInt16.self))))
        case 0xd2: return .int(Int64(Int32(bitPattern: try readBigEndian(data, &cursor, UInt32.self))))
        case 0xd3: return .int(Int64(bitPattern: try readBigEndian(data, &cursor, UInt64.self)))
        case 0xd9: let n = try readUInt8(data, &cursor); return try decodeString(count: Int(n), data: data, cursor: &cursor)
        case 0xda: let n = try readBigEndian(data, &cursor, UInt16.self); return try decodeString(count: Int(n), data: data, cursor: &cursor)
        case 0xdb: let n = try readBigEndian(data, &cursor, UInt32.self); return try decodeString(count: Int(n), data: data, cursor: &cursor)
        case 0xdc: let n = try readBigEndian(data, &cursor, UInt16.self); return try decodeArray(count: Int(n), data: data, cursor: &cursor)
        case 0xdd: let n = try readBigEndian(data, &cursor, UInt32.self); return try decodeArray(count: Int(n), data: data, cursor: &cursor)
        case 0xde: let n = try readBigEndian(data, &cursor, UInt16.self); return try decodeMap(count: Int(n), data: data, cursor: &cursor)
        case 0xdf: let n = try readBigEndian(data, &cursor, UInt32.self); return try decodeMap(count: Int(n), data: data, cursor: &cursor)
        default:
            throw MessagePackError.unsupportedType(b)
        }
    }

    private static func decodeString(count: Int, data: Data, cursor: inout Int) throws -> MessagePackValue {
        let bytes = try readBytes(data, &cursor, count: count)
        guard let s = String(data: bytes, encoding: .utf8) else {
            throw MessagePackError.malformed("invalid UTF-8 string")
        }
        return .string(s)
    }

    private static func decodeArray(count: Int, data: Data, cursor: inout Int) throws -> MessagePackValue {
        var arr: [MessagePackValue] = []
        arr.reserveCapacity(count)
        for _ in 0..<count {
            arr.append(try decode(data, cursor: &cursor))
        }
        return .array(arr)
    }

    private static func decodeMap(count: Int, data: Data, cursor: inout Int) throws -> MessagePackValue {
        var entries: [(MessagePackValue, MessagePackValue)] = []
        entries.reserveCapacity(count)
        for _ in 0..<count {
            let k = try decode(data, cursor: &cursor)
            let v = try decode(data, cursor: &cursor)
            entries.append((k, v))
        }
        return .map(entries)
    }

    private static func readUInt8(_ data: Data, _ cursor: inout Int) throws -> UInt8 {
        guard cursor < data.count else { throw MessagePackError.truncated }
        let b = data[data.startIndex + cursor]
        cursor += 1
        return b
    }

    private static func readBigEndian<T: FixedWidthInteger>(_ data: Data, _ cursor: inout Int, _ type: T.Type) throws -> T {
        let size = MemoryLayout<T>.size
        guard cursor + size <= data.count else { throw MessagePackError.truncated }
        var value: T = 0
        for i in 0..<size {
            value = (value << 8) | T(data[data.startIndex + cursor + i])
        }
        cursor += size
        return value
    }

    private static func readBytes(_ data: Data, _ cursor: inout Int, count: Int) throws -> Data {
        guard cursor + count <= data.count else { throw MessagePackError.truncated }
        let start = data.startIndex + cursor
        let end = start + count
        cursor += count
        return data.subdata(in: start..<end)
    }
}

extension MessagePackValue: ExpressibleByNilLiteral,
                            ExpressibleByBooleanLiteral,
                            ExpressibleByIntegerLiteral,
                            ExpressibleByFloatLiteral,
                            ExpressibleByStringLiteral {
    init(nilLiteral: ()) { self = .nilValue }
    init(booleanLiteral value: Bool) { self = .bool(value) }
    init(integerLiteral value: Int) { self = .int(Int64(value)) }
    init(floatLiteral value: Double) { self = .double(value) }
    init(stringLiteral value: String) { self = .string(value) }
}

extension MessagePackValue {
    static func wrap(_ value: Any?) -> MessagePackValue {
        guard let value else { return .nilValue }
        switch value {
        case let v as MessagePackValue: return v
        case is NSNull: return .nilValue
        case let b as Bool: return .bool(b)
        case let i as Int: return .int(Int64(i))
        case let i as Int8: return .int(Int64(i))
        case let i as Int16: return .int(Int64(i))
        case let i as Int32: return .int(Int64(i))
        case let i as Int64: return .int(i)
        case let u as UInt: return .uint(UInt64(u))
        case let u as UInt8: return .uint(UInt64(u))
        case let u as UInt16: return .uint(UInt64(u))
        case let u as UInt32: return .uint(UInt64(u))
        case let u as UInt64: return .uint(u)
        case let d as Double: return .double(d)
        case let f as Float: return .double(Double(f))
        case let s as String: return .string(s)
        case let d as Data: return .data(d)
        case let n as NSNumber:
            if CFGetTypeID(n) == CFBooleanGetTypeID() { return .bool(n.boolValue) }
            if CFNumberIsFloatType(n) { return .double(n.doubleValue) }
            return .int(n.int64Value)
        case let arr as [Any?]: return .array(arr.map { wrap($0) })
        case let dict as [String: Any?]:
            return .map(dict.map { (.string($0.key), wrap($0.value)) })
        case let dict as [String: Any]:
            return .map(dict.map { (.string($0.key), wrap($0.value)) })
        default:
            return .string(String(describing: value))
        }
    }
}
