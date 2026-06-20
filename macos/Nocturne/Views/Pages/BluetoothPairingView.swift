import SwiftUI
import AppKit

struct BluetoothPairingView: View {
    @EnvironmentObject var bluetooth: BluetoothService

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 8) {
                    Text("Bluetooth")
                        .font(Theme.font(30, .semibold))
                        .tracking(-0.75)
                        .foregroundStyle(Theme.fg)
                    Text("Pair your Nocturne device in System Settings, then manage the connection here.")
                        .font(Theme.font(16))
                        .foregroundStyle(Theme.secondary)
                }
                Spacer()
                Button(action: openBluetoothSettings) {
                    HStack(spacing: 6) {
                        Lucide(name: "external-link", size: 14)
                        Text("Open Bluetooth Settings")
                    }
                }
                .buttonStyle(.web(.outline, size: .sm))
                .padding(.top, 4)
            }
            .padding(.bottom, 40)

            if !bluetooth.carThingConnections.isEmpty {
                VStack(alignment: .leading, spacing: 12) {
                    SectionLabel(text: "Active Connections")
                    VStack(spacing: 8) {
                        ForEach(bluetooth.carThingConnections) { conn in
                            connectionCard(conn)
                        }
                    }
                }
                .padding(.bottom, 32)
            }

            if bluetooth.carThingDevices.isEmpty {
                pairingInstructions
            } else {
                VStack(alignment: .leading, spacing: 12) {
                    SectionLabel(text: "Paired Devices")
                    VStack(spacing: 8) {
                        ForEach(bluetooth.carThingDevices) { device in
                            DeviceCard(device: device)
                        }
                    }
                    Text("To unpair, remove the device in System Settings → Bluetooth.")
                        .font(Theme.font(12))
                        .foregroundStyle(Theme.muted)
                        .padding(.top, 4)
                }
            }

            if let err = bluetooth.lastError {
                Text(err)
                    .font(Theme.font(14))
                    .foregroundStyle(Theme.destructive)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.top, 16)
            }
        }
        .padding(.bottom, 24)
        .onAppear { bluetooth.loadPairedDevices() }
    }

    private var pairingInstructions: some View {
        Card {
            VStack(alignment: .leading, spacing: 20) {
                HStack(spacing: 12) {
                    ZStack {
                        RoundedRectangle(cornerRadius: Theme.Radius.lg, style: .continuous)
                            .fill(Theme.accent.opacity(0.1))
                        Lucide(name: "bluetooth", size: 18, color: Theme.accent)
                    }
                    .frame(width: 40, height: 40)
                    Text("Pair your device")
                        .font(Theme.font(18, .medium))
                        .foregroundStyle(Theme.fg)
                }

                VStack(alignment: .leading, spacing: 14) {
                    instructionStep(1, "Click below to open settings (or go to Settings > Bluetooth).")
                    instructionStep(2, "Choose \"Nocturne (XXXX)\" when it appears and finish pairing.")
                    instructionStep(3, "Return to the app to finish setting up your device.")
                }

                Button(action: openBluetoothSettings) {
                    HStack(spacing: 6) {
                        Lucide(name: "external-link", size: 14, color: Theme.bg)
                        Text("Open Bluetooth Settings")
                    }
                }
                .buttonStyle(.web(.primary))
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    private func instructionStep(_ number: Int, _ text: String) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 12) {
            Text("\(number)")
                .font(Theme.font(12, .medium))
                .foregroundStyle(Theme.fg)
                .frame(width: 22, height: 22)
                .background(Circle().fill(Theme.raised))
                .overlay(Circle().stroke(Theme.line, lineWidth: 1))
            Text(text)
                .font(Theme.font(14))
                .foregroundStyle(Theme.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    private func openBluetoothSettings() {
        guard let url = URL(string: "x-apple.systempreferences:com.apple.BluetoothSettings") else { return }
        NSWorkspace.shared.open(url)
    }

    private func connectionCard(_ conn: BTConnection) -> some View {
        HStack(spacing: 12) {
            ZStack {
                RoundedRectangle(cornerRadius: Theme.Radius.lg, style: .continuous)
                    .fill(Theme.success.opacity(0.1))
                Lucide(name: "bluetooth", size: 16, color: Theme.success)
            }
            .frame(width: 36, height: 36)
            Text(conn.name ?? "Device")
                .font(Theme.font(16, .medium))
                .foregroundStyle(Theme.fg)
            Spacer()
            WebBadge(text: "Connected", variant: .success)
        }
        .padding(24)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            RoundedRectangle(cornerRadius: Theme.Radius.xxl, style: .continuous)
                .fill(Theme.success.opacity(0.05))
        )
        .overlay(
            RoundedRectangle(cornerRadius: Theme.Radius.xxl, style: .continuous)
                .stroke(Theme.success.opacity(0.2), lineWidth: 1)
        )
    }
}

private struct DeviceCard: View {
    let device: BTDeviceInfo

    var body: some View {
        Card {
            HStack(alignment: .center) {
                VStack(alignment: .leading, spacing: 6) {
                    Text(device.displayName)
                        .font(Theme.font(16, .medium))
                        .foregroundStyle(Theme.fg)
                    HStack(spacing: 8) {
                        if device.paired {
                            WebBadge(text: "Paired", variant: .success)
                        }
                        if device.connected {
                            WebBadge(text: "Connected", variant: .accent)
                        }
                    }
                }
                Spacer()
                if device.paired {
                    if !device.connected {
                        WebBadge(text: "Waiting", variant: .outline)
                    }
                } else {
                    Text("Waiting for pairing in System Settings…")
                        .font(Theme.font(13))
                        .foregroundStyle(Theme.muted)
                }
            }
        }
    }
}
