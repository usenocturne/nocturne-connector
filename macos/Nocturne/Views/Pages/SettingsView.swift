import SwiftUI

struct SettingsView: View {
    @EnvironmentObject var auth: AuthService
    @EnvironmentObject var spotify: SpotifyService
    @EnvironmentObject var nowPlaying: NowPlayingService
    @EnvironmentObject var analytics: AnalyticsService
    @EnvironmentObject var loginItem: LoginItemService

    @State private var deleteOpen = false
    @State private var deleting = false
    @State private var deleteError: String? = nil

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            VStack(alignment: .leading, spacing: 8) {
                Text("Settings")
                    .font(Theme.font(30, .semibold))
                    .tracking(-0.75)
                    .foregroundStyle(Theme.fg)
                Text("Manage your account, view system info, and configure your connector.")
                    .font(Theme.font(16))
                    .foregroundStyle(Theme.secondary)
            }
            .padding(.bottom, 40)

            VStack(alignment: .leading, spacing: 32) {
                section("Account") {
                    Card {
                        HStack(alignment: .center) {
                            VStack(alignment: .leading, spacing: 2) {
                                Text("Signed in as")
                                    .font(Theme.font(14))
                                    .foregroundStyle(Theme.secondary)
                                Text(auth.status.user?.email ?? "—")
                                    .font(Theme.font(18, .medium))
                                    .foregroundStyle(Theme.fg)
                            }
                            Spacer()
                            Button {
                                Task { await auth.signOut() }
                            } label: {
                                HStack(spacing: 6) {
                                    Lucide(name: "log-out", size: 14)
                                    Text("Sign Out")
                                }
                            }
                            .buttonStyle(.web(.outline, size: .sm))
                        }
                        Rectangle()
                            .fill(Theme.line)
                            .frame(height: 1)
                        AccountLink()
                    }
                }

                section("System") {
                    Card {
                        VStack(spacing: 12) {
                            InfoRow(label: "Connector Version", value: AppConfig.connectorVersion)
                            InfoRow(label: "OS Version", value: AppConfig.osVersion)
                        }
                    }
                }

                section("Startup") {
                    Card {
                        HStack(alignment: .center) {
                            VStack(alignment: .leading, spacing: 2) {
                                Text("Launch at Login")
                                    .font(Theme.font(16, .medium))
                                    .foregroundStyle(Theme.fg)
                                Text("Start the connector in the menu bar after a reboot so your device reconnects on its own.")
                                    .font(Theme.font(14))
                                    .foregroundStyle(Theme.secondary)
                            }
                            Spacer()
                            Toggle("", isOn: Binding(
                                get: { loginItem.isEnabled || loginItem.needsApproval },
                                set: { loginItem.setEnabled($0) }
                            ))
                            .toggleStyle(WebSwitchStyle())
                            .labelsHidden()
                        }
                        if loginItem.needsApproval {
                            Rectangle()
                                .fill(Theme.line)
                                .frame(height: 1)
                            HStack(alignment: .center) {
                                Text("macOS is waiting for you to approve Nocturne in Login Items.")
                                    .font(Theme.font(14))
                                    .foregroundStyle(Theme.secondary)
                                Spacer()
                                Button("Open Login Items") {
                                    loginItem.openLoginItemsSettings()
                                }
                                .buttonStyle(.web(.outline, size: .sm))
                            }
                        }
                        if let error = loginItem.lastError {
                            Text(error)
                                .font(Theme.font(14))
                                .foregroundStyle(Theme.destructive)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                    }
                }

                section("Media") {
                    Card {
                        HStack(alignment: .center) {
                            VStack(alignment: .leading, spacing: 2) {
                                Text("System media")
                                    .font(Theme.font(16, .medium))
                                    .foregroundStyle(Theme.fg)
                                Text(spotify.authState.isSkipped
                                     ? "Always on while Spotify is skipped, so Nocturne can still show what's playing."
                                     : "Show media playing on this Mac from any app on Nocturne. Turn off to use Spotify only.")
                                    .font(Theme.font(14))
                                    .foregroundStyle(Theme.secondary)
                                    .fixedSize(horizontal: false, vertical: true)
                            }
                            Spacer()
                            Toggle("", isOn: Binding(
                                get: { spotify.authState.isSkipped || nowPlaying.isSystemMediaEnabled },
                                set: { nowPlaying.setSystemMediaEnabled($0) }
                            ))
                            .toggleStyle(WebSwitchStyle())
                            .labelsHidden()
                            .disabled(spotify.authState.isSkipped)
                        }
                    }
                }

                section("Privacy") {
                    Card {
                        HStack(alignment: .center) {
                            VStack(alignment: .leading, spacing: 2) {
                                Text("Analytics")
                                    .font(Theme.font(16, .medium))
                                    .foregroundStyle(Theme.fg)
                                Text("Help improve Nocturne by sharing usage data.")
                                    .font(Theme.font(14))
                                    .foregroundStyle(Theme.secondary)
                            }
                            Spacer()
                            Toggle("", isOn: Binding(
                                get: { analytics.isEnabled },
                                set: { analytics.setEnabled($0) }
                            ))
                            .toggleStyle(WebSwitchStyle())
                            .labelsHidden()
                        }
                    }
                }

                section("Danger Zone", color: Theme.destructive.opacity(0.6)) {
                    VStack(alignment: .leading, spacing: 16) {
                        HStack(alignment: .center) {
                            VStack(alignment: .leading, spacing: 2) {
                                Text("Delete Account")
                                    .font(Theme.font(16, .medium))
                                    .foregroundStyle(Theme.fg)
                                Text("Permanently removes your account and all associated data.")
                                    .font(Theme.font(14))
                                    .foregroundStyle(Theme.secondary)
                            }
                            Spacer()
                            Button {
                                deleteError = nil
                                deleteOpen = true
                            } label: {
                                HStack(spacing: 6) {
                                    Lucide(name: "trash-2", size: 14, color: .white)
                                    Text("Delete Account")
                                }
                            }
                            .buttonStyle(.web(.destructive, size: .sm))
                        }
                    }
                    .padding(24)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(
                        RoundedRectangle(cornerRadius: Theme.Radius.xxl, style: .continuous)
                            .fill(Theme.raised)
                    )
                    .overlay(
                        RoundedRectangle(cornerRadius: Theme.Radius.xxl, style: .continuous)
                            .stroke(Theme.destructive.opacity(0.2), lineWidth: 1)
                    )
                }
            }
        }
        .padding(.bottom, 24)
        .webDialog(isPresented: $deleteOpen, dismissOnBackdropTap: false) {
            DialogTitle(text: "Delete Account")
            DialogDescription(text: "Deleting your account will remove all associated data. This action cannot be undone.")
            if let deleteError {
                Text(deleteError)
                    .font(Theme.font(14))
                    .foregroundStyle(Theme.destructive)
                    .fixedSize(horizontal: false, vertical: true)
            }
            HStack(spacing: 8) {
                Spacer()
                Button("Cancel") { deleteOpen = false }
                    .buttonStyle(.web(.outline))
                    .disabled(deleting)
                Button(deleting ? "Deleting..." : "Delete Account") { performDelete() }
                    .buttonStyle(.web(.destructive))
                    .disabled(deleting)
            }
        }
    }

    @ViewBuilder
    private func section<Content: View>(
        _ title: String,
        color: Color = Theme.muted,
        @ViewBuilder content: () -> Content
    ) -> some View {
        VStack(alignment: .leading, spacing: 16) {
            SectionLabel(text: title, color: color)
            content()
        }
    }

    private func performDelete() {
        deleting = true
        deleteError = nil
        Task {
            do {
                try await auth.deleteAccount()
                deleteOpen = false
            } catch {
                deleteError = error.localizedDescription
            }
            deleting = false
        }
    }
}

private struct AccountLink: View {
    @State private var hovering = false

    var body: some View {
        HStack(spacing: 4) {
            Text("Manage your password and account at \(Text("usenocturne.com").foregroundStyle(hovering ? Theme.accentHover : Theme.accent))")
                .font(Theme.font(14))
                .foregroundStyle(Theme.secondary)
            Lucide(name: "external-link", size: 12, color: hovering ? Theme.accentHover : Theme.accent)
        }
        .contentShape(Rectangle())
        .onHover { hovering = $0 }
        .onTapGesture {
            NSWorkspace.shared.open(URL(string: "https://usenocturne.com")!)
        }
        .animation(.easeOut(duration: 0.2), value: hovering)
    }
}

private struct WebSwitchStyle: ToggleStyle {
    func makeBody(configuration: Configuration) -> some View {
        Button {
            configuration.isOn.toggle()
        } label: {
            Capsule()
                .fill(configuration.isOn ? Theme.accent : Theme.line)
                .frame(width: 36, height: 20)
                .overlay(alignment: configuration.isOn ? .trailing : .leading) {
                    Circle()
                        .fill(.white)
                        .frame(width: 16, height: 16)
                        .padding(2)
                }
        }
        .buttonStyle(.plain)
        .animation(.easeOut(duration: 0.15), value: configuration.isOn)
    }
}
