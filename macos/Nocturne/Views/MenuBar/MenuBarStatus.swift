import SwiftUI

struct MenuBarLabel: View {
    @EnvironmentObject var bluetooth: BluetoothService
    let appDelegate: AppDelegate
    @Environment(\.openWindow) private var openWindow

    private static let iconConnected = makeIcon(dimmed: false)
    private static let iconDisconnected = makeIcon(dimmed: true)

    private static func makeIcon(dimmed: Bool) -> NSImage {
        let source = NSImage(named: "NocturneIcon") ?? NSImage()
        let image = NSImage(size: NSSize(width: 17, height: 17), flipped: false) { rect in
            source.draw(
                in: rect,
                from: .zero,
                operation: .sourceOver,
                fraction: dimmed ? 0.45 : 1
            )
            return true
        }
        image.isTemplate = true
        return image
    }

    var body: some View {
        Image(nsImage: bluetooth.carThingConnections.isEmpty ? Self.iconDisconnected : Self.iconConnected)
            .onAppear {
                appDelegate.openMainWindow = {
                    openWindow(id: "main")
                    AppDelegate.mainWindowVisibilityChanged(true)
                }
            }
    }
}

struct MenuBarPanel: View {
    @EnvironmentObject var bluetooth: BluetoothService
    @EnvironmentObject var rpc: RPCManager
    @Environment(\.openWindow) private var openWindow
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 14) {
                Image("CarThingFrame")
                    .renderingMode(.template)
                    .resizable()
                    .scaledToFit()
                    .frame(height: 38)
                    .foregroundStyle(Theme.fg)

                VStack(alignment: .leading, spacing: 4) {
                    Text(deviceName)
                        .font(Theme.font(15, .semibold))
                        .foregroundStyle(Theme.fg)
                    HStack(spacing: 6) {
                        Circle()
                            .fill(dotColor)
                            .frame(width: 8, height: 8)
                        Text(statusText)
                            .font(Theme.font(13))
                            .foregroundStyle(Theme.secondary)
                    }
                }
                Spacer(minLength: 0)
            }
            .padding(16)

            Rectangle()
                .fill(Theme.line)
                .frame(height: 1)

            HStack {
                Button("Open Nocturne") {
                    openWindow(id: "main")
                    AppDelegate.mainWindowVisibilityChanged(true)
                    dismiss()
                }
                .buttonStyle(.web(.primary, size: .sm))

                Spacer()

                Button("Quit") {
                    NSApp.terminate(nil)
                }
                .buttonStyle(.web(.ghost, size: .sm))
            }
            .padding(12)
        }
        .frame(width: 300)
        .background(Theme.bg)
        .preferredColorScheme(.dark)
    }

    private var deviceName: String {
        bluetooth.carThingConnections.first?.name
            ?? bluetooth.carThingDevices.first?.name
            ?? "Nocturne"
    }

    private var connected: Bool {
        !bluetooth.carThingConnections.isEmpty
    }

    private var dotColor: Color {
        if connected { return .green }
        if !bluetooth.status.powered { return .red }
        return Theme.muted
    }

    private var statusText: String {
        if connected { return "Connected" }
        if !bluetooth.status.powered { return "Bluetooth is off" }
        if bluetooth.carThingDevices.isEmpty { return "No device paired" }
        return "Waiting for Nocturne…"
    }
}
