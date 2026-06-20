import SwiftUI

struct DashboardView: View {
    @EnvironmentObject var bluetooth: BluetoothService
    @EnvironmentObject var rpc: RPCManager
    @State private var selectedDevice: ConnectedDevice? = nil
    @State private var deviceDialogOpen = false

    private var connectedDevices: [ConnectedDevice] {
        var seen = Set<String>()
        return bluetooth.carThingConnections.compactMap { conn -> ConnectedDevice? in
            guard seen.insert(conn.address).inserted else { return nil }
            return ConnectedDevice(id: conn.address, address: conn.address, info: rpc.deviceInfo)
        }
    }

    private var pendingDevices: [BTDeviceInfo] {
        let activeAddresses = Set(bluetooth.carThingConnections.map(\.address))
        return bluetooth.carThingDevices.filter { $0.paired && !activeAddresses.contains($0.address) }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
                .padding(.bottom, 40)

            if !connectedDevices.isEmpty {
                VStack(spacing: 12) {
                    ForEach(connectedDevices) { device in
                        ConnectedDeviceRow(device: device) {
                            selectedDevice = device
                            deviceDialogOpen = true
                        }
                    }
                }
            } else if !pendingDevices.isEmpty {
                VStack(alignment: .leading, spacing: 12) {
                    SectionLabel(text: "Paired Devices")
                    ForEach(pendingDevices) { device in
                        pendingDeviceCard(for: device)
                    }
                    if let err = bluetooth.lastError {
                        Text(err)
                            .font(Theme.font(12))
                            .foregroundStyle(Theme.destructive)
                            .padding(.horizontal, 4)
                    }
                }
            } else {
                emptyState
            }
        }
        .webDialog(isPresented: $deviceDialogOpen) {
            deviceDialog
        }
    }

    private var header: some View {
        HStack(alignment: .top) {
            VStack(alignment: .leading, spacing: 8) {
                Text("Dashboard")
                    .font(Theme.font(30, .semibold))
                    .tracking(-0.75)
                    .foregroundStyle(Theme.fg)
                Text("Monitor and manage your connected Car Thing devices.")
                    .font(Theme.font(16))
                    .foregroundStyle(Theme.secondary)
            }
            Spacer()
            Button {
                bluetooth.retryPendingCarThingLinks()
            } label: {
                HStack(spacing: 6) {
                    Lucide(name: "refresh-cw", size: 14, color: Theme.fg)
                    Text("Refresh")
                }
            }
            .buttonStyle(.web(.outline, size: .sm))
            .padding(.top, 4)
        }
    }

    private var emptyState: some View {
        VStack(spacing: 0) {
            ZStack {
                RoundedRectangle(cornerRadius: Theme.Radius.xl, style: .continuous)
                    .fill(Theme.hover)
                Lucide(name: "bluetooth", size: 28, color: Theme.muted)
            }
            .frame(width: 56, height: 56)
            .padding(.bottom, 16)

            Text("No Car Thing connected")
                .font(Theme.font(18, .medium))
                .foregroundStyle(Theme.fg)

            Text("Connect your Car Thing via Bluetooth to start managing playback and settings.")
                .font(Theme.font(14))
                .foregroundStyle(Theme.secondary)
                .multilineTextAlignment(.center)
                .frame(maxWidth: 384)
                .padding(.top, 6)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 32)
        .padding(24)
        .background(
            RoundedRectangle(cornerRadius: Theme.Radius.xxl, style: .continuous)
                .fill(Theme.raised)
        )
        .overlay(
            RoundedRectangle(cornerRadius: Theme.Radius.xxl, style: .continuous)
                .strokeBorder(Theme.line, style: StrokeStyle(lineWidth: 1, dash: [4]))
        )
    }

    @ViewBuilder
    private var deviceDialog: some View {
        let info = rpc.deviceInfo ?? selectedDevice?.info
        HStack(alignment: .top) {
            DialogTitle(text: info?.device ?? "Nocturne Car Thing")
            Spacer(minLength: 16)
            DialogCloseButton { deviceDialogOpen = false }
        }
        if let info {
            VStack(spacing: 12) {
                dialogRow("Firmware", info.version)
                dialogRow("Full Version", info.fullVersion)
                dialogRow("Build Date", info.buildDate)
                dialogRow("Git Hash", info.gitHash, mono: true)
                dialogRow("Serial Number", info.serialNumber, mono: true)
            }
        } else {
            Text("No device info available")
                .font(Theme.font(14))
                .foregroundStyle(Theme.secondary)
        }
    }

    @ViewBuilder
    private func dialogRow(_ label: String, _ value: String?, mono: Bool = false) -> some View {
        if let value, !value.isEmpty {
            InfoRow(label: label, value: value, mono: mono)
        }
    }

    @ViewBuilder
    private func pendingDeviceCard(for device: BTDeviceInfo) -> some View {
        let state = bluetooth.peerConnectability[device.address] ?? .unknown
        Card {
            HStack(spacing: 16) {
                ZStack {
                    RoundedRectangle(cornerRadius: Theme.Radius.lg, style: .continuous)
                        .fill(state.tint.opacity(0.1))
                    Image(systemName: state.icon)
                        .font(.system(size: 18, weight: .medium))
                        .foregroundStyle(state.tint)
                }
                .frame(width: 40, height: 40)

                VStack(alignment: .leading, spacing: 2) {
                    Text(device.displayName)
                        .font(Theme.font(16, .medium))
                        .foregroundStyle(Theme.fg)
                    Text(state.headline)
                        .font(Theme.font(14))
                        .foregroundStyle(Theme.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }

                Spacer(minLength: 16)

                WebBadge(text: state.badgeText, variant: state.badgeVariant)
            }
        }
    }
}

private struct DialogCloseButton: View {
    let action: () -> Void
    @State private var hovering = false

    var body: some View {
        Button(action: action) {
            Lucide(name: "x", size: 16, color: hovering ? Theme.fg : Theme.secondary)
                .frame(width: 24, height: 24)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .animation(.easeOut(duration: 0.2), value: hovering)
        .onHover { hovering = $0 }
    }
}

private struct ConnectedDeviceRow: View {
    let device: ConnectedDevice
    let action: () -> Void

    @State private var hovering = false

    var body: some View {
        Button(action: action) {
            HStack(spacing: 16) {
                ZStack {
                    RoundedRectangle(cornerRadius: Theme.Radius.lg, style: .continuous)
                        .fill(Theme.success.opacity(0.1))
                    Lucide(name: "monitor", size: 20, color: Theme.success)
                }
                .frame(width: 40, height: 40)

                VStack(alignment: .leading, spacing: 2) {
                    Text(device.info?.device ?? "Nocturne Car Thing")
                        .font(Theme.font(16, .medium))
                        .foregroundStyle(Theme.fg)
                    Text(device.info?.version.map { "Firmware \($0)" } ?? "Connected via Bluetooth")
                        .font(Theme.font(14))
                        .foregroundStyle(Theme.secondary)
                }

                Spacer(minLength: 16)

                HStack(spacing: 12) {
                    WebBadge(text: "Connected", variant: .success)
                    Lucide(name: "chevron-right", size: 16, color: Theme.muted)
                }
            }
            .padding(24)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(
                RoundedRectangle(cornerRadius: Theme.Radius.xxl, style: .continuous)
                    .fill(hovering ? Theme.hover : Theme.raised)
            )
            .overlay(
                RoundedRectangle(cornerRadius: Theme.Radius.xxl, style: .continuous)
                    .stroke(hovering ? Theme.lineHover : Theme.line, lineWidth: 1)
            )
            .contentShape(RoundedRectangle(cornerRadius: Theme.Radius.xxl, style: .continuous))
        }
        .buttonStyle(.plain)
        .pointerStyle(.link)
        .animation(.easeOut(duration: 0.2), value: hovering)
        .onHover { hovering = $0 }
    }
}

private extension BluetoothService.PeerConnectability {
    var icon: String {
        switch self {
        case .rejecting:  return "exclamationmark.triangle.fill"
        case .connecting: return "antenna.radiowaves.left.and.right"
        case .connected:  return "checkmark.circle.fill"
        case .unknown:    return "hourglass"
        }
    }
    var tint: SwiftUI.Color {
        switch self {
        case .rejecting:  return Theme.destructive
        case .connecting: return Theme.accent
        case .connected:  return Theme.success
        case .unknown:    return Theme.accent
        }
    }
    var headline: String {
        switch self {
        case .rejecting:
            return "Couldn't open the RPC channel. Make sure the Car Thing is paired and in range, then try again."
        case .connecting:
            return "Opening RFCOMM channel…"
        case .connected:
            return "Connected"
        case .unknown:
            return "Paired — waiting for the Car Thing to request the connector"
        }
    }
    var badgeText: String {
        switch self {
        case .rejecting:  return "Needs Probe"
        case .connecting: return "Responding"
        case .connected:  return "Connected"
        case .unknown:    return "Waiting"
        }
    }
    var badgeVariant: BadgeVariant {
        switch self {
        case .rejecting:  return .destructive
        case .connecting: return .accent
        case .connected:  return .success
        case .unknown:    return .outline
        }
    }
}
