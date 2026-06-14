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
                         : "Connector probe listener unavailable")
                        .font(Theme.font(14, .medium))
                        .foregroundStyle(Theme.fg)

                    Text(listening
                         ? "Once paired, the Car Thing sends a request to the Mac, then connects to the Car Thing."
                         : bluetooth.serverError ?? "Bluetooth must be on before the connector can listen for the Car Thing.")
                        .font(Theme.font(14))
                        .foregroundStyle(Theme.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }

                Spacer(minLength: 0)
            }
        }
    }
}
