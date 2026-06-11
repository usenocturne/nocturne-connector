import CoreText
import Foundation
import os

enum FontLoader {
    private static let log = Log.make(for: "FontLoader")

    static func registerBundledFonts() {
        let names = ["Switzer-Regular", "Switzer-Medium", "Switzer-Semibold", "Switzer-Bold"]
        let urls = names.compactMap { Bundle.main.url(forResource: $0, withExtension: "otf") }
        guard !urls.isEmpty else {
            log.warning("No bundled Switzer fonts found; falling back to system font")
            return
        }
        CTFontManagerRegisterFontURLs(urls as CFArray, .process, true) { _, _ in true }
    }
}
