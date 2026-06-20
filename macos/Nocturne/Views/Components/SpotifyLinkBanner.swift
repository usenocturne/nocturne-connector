import SwiftUI
#if canImport(AppKit)
import AppKit
#endif

struct SpotifyLinkBanner: View {
    @EnvironmentObject var spotify: SpotifyService
    @State private var lastError: String?

    var body: some View {
        Group {
            switch spotify.authState {
            case .linked(let displayName):
                Card {
                    HStack(spacing: 16) {
                        iconTile("music", tint: Theme.success)
                        VStack(alignment: .leading, spacing: 2) {
                            Text("Spotify linked")
                                .font(Theme.font(14, .medium))
                                .foregroundStyle(Theme.fg)
                            if let displayName {
                                Text(displayName)
                                    .font(Theme.font(14))
                                    .foregroundStyle(Theme.secondary)
                            }
                        }
                        Spacer(minLength: 16)
                        Button("Disconnect") {
                            Task { await spotify.disconnect() }
                        }
                        .buttonStyle(.web(.outline, size: .sm))
                    }
                }
            case .polling(_, _, let verificationURI, _):
                Card {
                    HStack(alignment: .top, spacing: 16) {
                        iconTile("loader-circle", tint: Theme.accent)
                        VStack(alignment: .leading, spacing: 2) {
                            Text("Authorize on Spotify")
                                .font(Theme.font(14, .medium))
                                .foregroundStyle(Theme.fg)
                            Text("Sign in on the Spotify page that just opened in your browser.")
                                .font(Theme.font(14))
                                .foregroundStyle(Theme.secondary)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                        Spacer(minLength: 16)
                        VStack(alignment: .trailing, spacing: 6) {
                            Button {
                                #if canImport(AppKit)
                                if let url = URL(string: verificationURI) {
                                    NSWorkspace.shared.open(url)
                                }
                                #endif
                            } label: {
                                HStack(spacing: 6) {
                                    Lucide(name: "external-link", size: 14, color: Theme.fg)
                                    Text("Reopen page")
                                }
                            }
                            .buttonStyle(.web(.outline, size: .sm))
                            Button("Cancel") { spotify.cancelAuthorization() }
                                .buttonStyle(.web(.ghost, size: .sm))
                        }
                    }
                }
            case .loading:
                Card {
                    HStack(spacing: 12) {
                        WebSpinner(size: 16)
                        Text("Starting Spotify authorization…")
                            .font(Theme.font(14))
                            .foregroundStyle(Theme.secondary)
                    }
                }
            case .idle, .skipped:
                Card {
                    HStack(spacing: 16) {
                        iconTile("music", tint: Theme.accent)
                        VStack(alignment: .leading, spacing: 2) {
                            Text("Link Spotify for full library and playback controls")
                                .font(Theme.font(14, .medium))
                                .foregroundStyle(Theme.fg)
                            Text("Without connecting to Spotify, Nocturne can only show Now Playing from your Mac.")
                                .font(Theme.font(14))
                                .foregroundStyle(Theme.secondary)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                        Spacer(minLength: 16)
                        Button("Link Spotify") {
                            lastError = nil
                            Task {
                                do {
                                    try await spotify.startDeviceAuthorization()
                                } catch {
                                    lastError = error.localizedDescription
                                }
                            }
                        }
                        .buttonStyle(.web(.success, size: .sm))
                    }
                    if let err = lastError {
                        HStack(alignment: .top, spacing: 8) {
                            Text(err)
                                .font(.system(size: 12, design: .monospaced))
                                .foregroundStyle(Theme.destructive)
                                .fixedSize(horizontal: false, vertical: true)
                            Spacer(minLength: 0)
                            Button {
                                #if canImport(AppKit)
                                let pb = NSPasteboard.general
                                pb.clearContents()
                                pb.setString(err, forType: .string)
                                #endif
                            } label: {
                                Label("Copy", systemImage: "doc.on.doc")
                                    .labelStyle(.iconOnly)
                            }
                            .buttonStyle(.web(.ghost, size: .xs))
                            .help("Copy error to clipboard")
                        }
                        .padding(12)
                        .background(
                            RoundedRectangle(cornerRadius: Theme.Radius.lg, style: .continuous)
                                .fill(Theme.destructive.opacity(0.08))
                        )
                        .overlay(
                            RoundedRectangle(cornerRadius: Theme.Radius.lg, style: .continuous)
                                .stroke(Theme.destructive.opacity(0.25), lineWidth: 1)
                        )
                    }
                }
            }
        }
    }

    private func iconTile(_ name: String, tint: Color) -> some View {
        ZStack {
            RoundedRectangle(cornerRadius: Theme.Radius.lg, style: .continuous)
                .fill(tint.opacity(0.1))
            Lucide(name: name, size: 20, color: tint)
        }
        .frame(width: 40, height: 40)
    }
}
