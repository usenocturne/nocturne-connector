import Foundation

enum RPCValueBridge {
    static func pack(_ value: Any?) -> MessagePackValue {
        MessagePackValue.wrap(value)
    }

    static func unpack(_ value: MessagePackValue) -> Any {
        switch value {
        case .nilValue:
            return NSNull()
        case .bool(let b):
            return b
        case .int(let i):
            return Int(i)
        case .uint(let u):
            if u <= UInt64(Int.max) { return Int(u) }
            return u
        case .double(let d):
            return d
        case .string(let s):
            return s
        case .data(let d):
            return d
        case .array(let items):
            return items.map { unpack($0) }
        case .map(let entries):
            var dict = [String: Any](minimumCapacity: entries.count)
            for (key, val) in entries {
                let k = key.stringValue ?? String(describing: unpack(key))
                dict[k] = unpack(val)
            }
            return dict
        }
    }

    static func dictionary(_ value: MessagePackValue) -> [String: Any] {
        unpack(value) as? [String: Any] ?? [:]
    }
}
