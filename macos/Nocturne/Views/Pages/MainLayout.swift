import SwiftUI

enum NavSection: String, CaseIterable, Identifiable {
    case dashboard, bluetooth, spotify, settings

    var id: String { rawValue }

    var label: String {
        switch self {
        case .dashboard: return "Dashboard"
        case .bluetooth: return "Bluetooth"
        case .spotify: return "Spotify"
        case .settings: return "Settings"
        }
    }

    var icon: String {
        switch self {
        case .dashboard: return "layout-dashboard"
        case .bluetooth: return "bluetooth"
        case .spotify: return "music"
        case .settings: return "settings"
        }
    }
}

struct MainLayout: View {
    @State private var selection: NavSection = .dashboard

    private let headerHeight: CGFloat = 64

    var body: some View {
        GeometryReader { proxy in
            ScrollView {
                VStack(spacing: 0) {
                    Group {
                        switch selection {
                        case .dashboard: DashboardView()
                        case .bluetooth: BluetoothPairingView()
                        case .spotify: SpotifyAuthView()
                        case .settings: SettingsView()
                        }
                    }
                    .frame(maxWidth: 1024, alignment: .leading)
                    .padding(.horizontal, 24)
                    .padding(.vertical, 40)
                    .frame(maxWidth: .infinity)
                    .zIndex(1)

                    Spacer(minLength: 0)

                    SiteFooter()
                }
                .frame(minHeight: max(0, proxy.size.height - headerHeight))
            }
            .safeAreaInset(edge: .top, spacing: 0) {
                header
            }
        }
        .background(Theme.bg)
    }

    private var header: some View {
        HStack {
            Button {
                selection = .dashboard
            } label: {
                NocturneLogo(height: 24)
            }
            .buttonStyle(.plain)
            .focusEffectDisabled()

            Spacer()

            HStack(spacing: 4) {
                ForEach(NavSection.allCases) { section in
                    NavItem(section: section, active: selection == section) {
                        selection = section
                    }
                }
            }
        }
        .frame(maxWidth: 1024)
        .padding(.horizontal, 24)
        .frame(maxWidth: .infinity)
        .frame(height: 64)
        .background {
            ZStack {
                Rectangle().fill(.ultraThinMaterial)
                Theme.bg.opacity(0.8)
            }
        }
        .overlay(alignment: .bottom) {
            Theme.line.frame(height: 1)
        }
    }
}

private struct NavItem: View {
    let section: NavSection
    let active: Bool
    let action: () -> Void

    @State private var hovering = false

    var body: some View {
        Button(action: action) {
            HStack(spacing: 8) {
                Lucide(name: section.icon, size: 16, color: active || hovering ? Theme.fg : Theme.secondary)
                Text(section.label)
                    .font(Theme.font(14, .medium))
                    .foregroundStyle(active || hovering ? Theme.fg : Theme.secondary)
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            .background(
                RoundedRectangle(cornerRadius: Theme.Radius.lg, style: .continuous)
                    .fill(active || hovering ? Theme.hover : .clear)
            )
            .contentShape(RoundedRectangle(cornerRadius: Theme.Radius.lg, style: .continuous))
        }
        .buttonStyle(.plain)
        .animation(.easeOut(duration: 0.2), value: hovering)
        .onHover { hovering = $0 }
    }
}

struct SiteFooter: View {
    private var year: Int { Calendar.current.component(.year, from: Date()) }

    var body: some View {
        VStack(spacing: 0) {
            Theme.line.frame(height: 1)

            VStack(spacing: 0) {
                HStack {
                    NocturneLogo(height: 24)
                    Spacer()
                    Text("© \(String(year)) Vanta Labs.")
                        .font(Theme.font(14))
                        .foregroundStyle(Theme.muted)
                }
                .padding(.vertical, 40)

                Theme.line.frame(height: 1)

                Text("\"Spotify\" is a trademark of Spotify AB. This software is not affiliated with or endorsed by Spotify AB.")
                    .font(Theme.font(14))
                    .foregroundStyle(Theme.muted)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.vertical, 24)
            }
            .frame(maxWidth: 1024)
            .padding(.horizontal, 24)
            .frame(maxWidth: .infinity)
        }
        .background(Theme.bg)
    }
}
