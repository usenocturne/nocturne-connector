import Foundation
import os

enum Log {
    static func make(for subsystem: String) -> os.Logger {
        os.Logger(subsystem: "com.usenocturne.connector.mac", category: subsystem)
    }
}
