import Foundation

enum HTTPError: LocalizedError {
    case invalidResponse
    case status(Int, String?)
    case decoding(Error)
    case noData

    var errorDescription: String? {
        switch self {
        case .invalidResponse: return "Invalid HTTP response"
        case .status(let code, let body):
            if let body, !body.isEmpty { return body }
            return "HTTP \(code)"
        case .decoding(let err): return "Failed to decode response: \(err.localizedDescription)"
        case .noData: return "No data returned"
        }
    }
}
