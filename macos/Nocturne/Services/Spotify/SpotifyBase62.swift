import Foundation

enum SpotifyBase62 {
    private static let chars = Array("0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ")
    private static let hexChars = Array("0123456789abcdef")

    static func base62ToHex(_ base62Id: String) throws -> String {
        var bytes: [UInt8] = [0]
        for ch in base62Id {
            guard let idx = chars.firstIndex(of: ch) else {
                throw SpotifyAPIError("Invalid base62 character: \(ch)")
            }
            var carry = idx
            for i in (0..<bytes.count).reversed() {
                let v = Int(bytes[i]) * 62 + carry
                bytes[i] = UInt8(v & 0xff)
                carry = v >> 8
            }
            while carry > 0 {
                bytes.insert(UInt8(carry & 0xff), at: 0)
                carry >>= 8
            }
        }
        var hex = bytes.map { String(format: "%02x", $0) }.joined()
        if let firstNonZero = hex.firstIndex(where: { $0 != "0" }) {
            hex = String(hex[firstNonZero...])
        } else {
            hex = "0"
        }
        return String(repeating: "0", count: max(0, 32 - hex.count)) + hex
    }

    static func hexToBase62(_ hex: String) -> String {
        var bytes: [UInt8] = []
        var digits = Array(hex.lowercased())
        if digits.count % 2 != 0 { digits.insert("0", at: 0) }
        var i = 0
        while i < digits.count {
            guard let hi = hexChars.firstIndex(of: digits[i]),
                  let lo = hexChars.firstIndex(of: digits[i + 1]) else { return "0" }
            bytes.append(UInt8(hi << 4 | lo))
            i += 2
        }
        if bytes.allSatisfy({ $0 == 0 }) { return "0" }

        var result: [Character] = []
        var quotient = bytes
        while !(quotient.count == 1 && quotient[0] == 0) {
            var remainder = 0
            var next: [UInt8] = []
            for byte in quotient {
                let acc = remainder << 8 | Int(byte)
                next.append(UInt8(acc / 62))
                remainder = acc % 62
            }
            while next.count > 1 && next.first == 0 { next.removeFirst() }
            result.insert(chars[remainder], at: 0)
            quotient = next
        }
        return String(result)
    }
}
