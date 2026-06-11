import SwiftUI

struct ServerStatusCard: View {
    @EnvironmentObject var bluetooth: BluetoothService

    var body: some View {
        let listening = bluetooth.serverChannel > 0
        Card {
            HStack(alignment: .top, spacing: 16) {
                ZStack {
                    RoundedRectangle(cornerRadius: Theme.Radius.lg, style: .continuous)
                        .fill(Theme.accent.opacity(0.1))
                    Lucide(name: listening ? "bluetooth" : "external-link",
                           size: 20,
                           color: Theme.accent)
                }
                .frame(width: 40, height: 40)

                VStack(alignment: .leading, spacing: 2) {
                    Text(listening
                         ? "Listening for Car Thing on RFCOMM channel \(bluetooth.serverChannel)"
                         : "Outbound-only mode")
                        .font(Theme.font(14, .medium))
                        .foregroundStyle(Theme.fg)

                    Text(listening
                         ? "Once paired, the Car Thing's nocturned daemon dials in."
                         : "Pair the Car Thing in System Settings → Bluetooth; the Mac will dial out to it on RFCOMM channel 2 within a few seconds — same path the Pi connector uses after pairing.")
                        .font(Theme.font(14))
                        .foregroundStyle(Theme.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }

                Spacer(minLength: 0)
            }
        }
    }
}
