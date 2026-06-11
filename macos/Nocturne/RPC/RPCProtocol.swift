import Foundation

enum RPCMessage {
    case call(id: String, method: String, params: MessagePackValue)
    case result(id: String, result: MessagePackValue)
    case error(id: String, error: String)
    case event(topic: String, data: MessagePackValue)

    var id: String {
        switch self {
        case .call(let id, _, _): return id
        case .result(let id, _): return id
        case .error(let id, _): return id
        case .event: return UUID().uuidString.lowercased()
        }
    }

    func encoded() -> Data {
        let mp: MessagePackValue
        switch self {
        case .call(let id, let method, let params):
            mp = .map([
                (.string("type"), .string("call")),
                (.string("id"), .string(id)),
                (.string("method"), .string(method)),
                (.string("params"), params)
            ])
        case .result(let id, let result):
            mp = .map([
                (.string("type"), .string("result")),
                (.string("id"), .string(id)),
                (.string("result"), result)
            ])
        case .error(let id, let error):
            mp = .map([
                (.string("type"), .string("error")),
                (.string("id"), .string(id)),
                (.string("error"), .string(error))
            ])
        case .event(let topic, let data):
            mp = .map([
                (.string("type"), .string("event")),
                (.string("topic"), .string(topic)),
                (.string("data"), data)
            ])
        }
        return MessagePack.encode(mp)
    }

    static func decode(from data: Data) throws -> RPCMessage {
        let value = try MessagePack.decode(data)
        guard let type = value.mapValue("type")?.stringValue else {
            throw MessagePackError.malformed("missing 'type' field")
        }
        switch type {
        case "call":
            guard let id = value.mapValue("id")?.stringValue,
                  let method = value.mapValue("method")?.stringValue else {
                throw MessagePackError.malformed("call missing id/method")
            }
            let params = value.mapValue("params") ?? .nilValue
            return .call(id: id, method: method, params: params)
        case "result", "response":
            guard let id = value.mapValue("id")?.stringValue else {
                throw MessagePackError.malformed("result missing id")
            }
            return .result(id: id, result: value.mapValue("result") ?? .nilValue)
        case "error":
            guard let id = value.mapValue("id")?.stringValue,
                  let err = value.mapValue("error")?.stringValue else {
                throw MessagePackError.malformed("error missing id/error")
            }
            return .error(id: id, error: err)
        case "event":
            guard let topic = value.mapValue("topic")?.stringValue else {
                throw MessagePackError.malformed("event missing topic")
            }
            return .event(topic: topic, data: value.mapValue("data") ?? .nilValue)
        default:
            throw MessagePackError.malformed("unknown type: \(type)")
        }
    }
}
