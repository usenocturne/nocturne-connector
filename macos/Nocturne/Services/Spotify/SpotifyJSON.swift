import Foundation

enum SpotifyJSON {
    static func parse(_ data: Data) -> Any? {
        try? JSONSerialization.jsonObject(with: data, options: [.fragmentsAllowed])
    }

    static func object(_ data: Data) -> [String: Any]? {
        parse(data) as? [String: Any]
    }

    static func encode(_ value: Any) -> Data {
        (try? JSONSerialization.data(withJSONObject: value, options: [.fragmentsAllowed])) ?? Data()
    }

    static func stringify(_ value: Any) -> String {
        String(data: encode(value), encoding: .utf8) ?? ""
    }

    static func string(_ dict: [String: Any]?, _ key: String) -> String? {
        dict?[key] as? String
    }

    static func dict(_ dict: [String: Any]?, _ key: String) -> [String: Any]? {
        dict?[key] as? [String: Any]
    }

    static func array(_ dict: [String: Any]?, _ key: String) -> [Any]? {
        dict?[key] as? [Any]
    }

    static func int(_ dict: [String: Any]?, _ key: String) -> Int? {
        if let n = dict?[key] as? Int { return n }
        if let n = dict?[key] as? Double { return Int(n) }
        if let n = dict?[key] as? NSNumber { return n.intValue }
        if let s = dict?[key] as? String { return Int(s) }
        return nil
    }

    static func double(_ dict: [String: Any]?, _ key: String) -> Double? {
        if let n = dict?[key] as? Double { return n }
        if let n = dict?[key] as? Int { return Double(n) }
        if let n = dict?[key] as? NSNumber { return n.doubleValue }
        if let s = dict?[key] as? String { return Double(s) }
        return nil
    }

    static func bool(_ dict: [String: Any]?, _ key: String) -> Bool? {
        if let b = dict?[key] as? Bool { return b }
        if let n = dict?[key] as? NSNumber { return n.boolValue }
        return nil
    }

    static func at(_ root: Any?, _ path: String...) -> Any? {
        var current: Any? = root
        for key in path {
            guard let dict = current as? [String: Any] else { return nil }
            current = dict[key]
        }
        return current
    }
}

struct SpotifyAPIError: LocalizedError {
    let message: String
    var errorDescription: String? { message }
    init(_ message: String) { self.message = message }
}
