import SwiftUI
#if canImport(AppKit)
import AppKit
#endif

struct SpotifyAuthView: View {
    @EnvironmentObject var spotify: SpotifyService
    var onLinked: (() -> Void)? = nil

    @State private var loading = false
    @State private var errorMessage: String? = nil
    @State private var wasLinked = false
    @State private var openedURL: String? = nil

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            VStack(alignment: .leading, spacing: 8) {
                Text("Spotify")
                    .font(Theme.font(30, .semibold))
                    .tracking(-0.75)
                    .foregroundStyle(Theme.fg)
                Text("Link your Spotify account to control playback on your Car Thing.")
                    .font(Theme.font(16))
                    .foregroundStyle(Theme.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .padding(.bottom, 40)

            switch spotify.authState {
            case .linked(let displayName):
                linkedCard(displayName: displayName)
            case .polling(_, let userCode, let verificationURI, _):
                pollingCard(userCode: userCode, verificationURI: verificationURI)
            case .loading:
                loadingCard()
            case .idle, .skipped:
                idleCard()
            }

            if let errorMessage {
                Text(errorMessage)
                    .font(Theme.font(14))
                    .foregroundStyle(Theme.destructive)
                    .padding(.top, 16)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .onChange(of: spotify.authState) { _, newValue in
            let isLinked = newValue.isLinked
            if isLinked && !wasLinked { onLinked?() }
            wasLinked = isLinked
            if case .polling(_, _, let uri, _) = newValue { autoOpen(uri) }
            if case .idle = newValue { openedURL = nil }
        }
        .onAppear {
            wasLinked = spotify.authState.isLinked
        }
    }

    private func autoOpen(_ urlString: String) {
        guard openedURL != urlString else { return }
        openedURL = urlString
        #if canImport(AppKit)
        if let url = URL(string: urlString) { NSWorkspace.shared.open(url) }
        #endif
    }

    private func linkedCard(displayName: String?) -> some View {
        Card {
            HStack(spacing: 16) {
                ZStack {
                    RoundedRectangle(cornerRadius: Theme.Radius.lg, style: .continuous)
                        .fill(Theme.success.opacity(0.1))
                    Lucide(name: "music", size: 24, color: Theme.success)
                }
                .frame(width: 48, height: 48)
                VStack(alignment: .leading, spacing: 2) {
                    Text("Connected to Spotify")
                        .font(Theme.font(18, .medium))
                        .foregroundStyle(Theme.fg)
                    Text(displayName ?? "Spotify User")
                        .font(Theme.font(14))
                        .foregroundStyle(Theme.secondary)
                }
                Spacer()
                Button("Disconnect") {
                    Task { await spotify.disconnect() }
                }
                .buttonStyle(.web(.outline, size: .sm))
            }
        }
    }

    private func pollingCard(userCode: String, verificationURI: String) -> some View {
        Card {
            VStack(spacing: 0) {
                Text("Waiting for Spotify Authorization")
                    .font(Theme.font(18, .medium))
                    .foregroundStyle(Theme.fg)
                    .padding(.bottom, 16)
                Text("A browser tab should have opened automatically.")
                    .font(Theme.font(14))
                    .foregroundStyle(Theme.secondary)
                    .padding(.bottom, 8)
                HStack(spacing: 4) {
                    Text("If not,")
                        .font(Theme.font(14))
                        .foregroundStyle(Theme.secondary)
                    Button {
                        #if canImport(AppKit)
                        if let url = URL(string: verificationURI) {
                            NSWorkspace.shared.open(url)
                        }
                        #endif
                    } label: {
                        HStack(spacing: 4) {
                            Text("open Spotify authorization")
                                .font(Theme.font(14))
                            Lucide(name: "external-link", size: 12, color: Theme.accent)
                        }
                        .foregroundStyle(Theme.accent)
                    }
                    .buttonStyle(.plain)
                }
                .padding(.bottom, 24)
                HStack(spacing: 8) {
                    PulsingDot()
                    Text("Waiting for authorization...")
                        .font(Theme.font(12))
                        .foregroundStyle(Theme.muted)
                }
                .padding(.bottom, 24)
                Button("Cancel") {
                    spotify.cancelAuthorization()
                }
                .buttonStyle(.web(.outline, size: .sm))
            }
            .multilineTextAlignment(.center)
            .frame(maxWidth: .infinity)
            .padding(.vertical, 24)
        }
    }

    private func loadingCard() -> some View {
        Card {
            HStack(spacing: 12) {
                SpinningLoader(size: 20)
                Text("Starting authorization...")
                    .font(Theme.font(16))
                    .foregroundStyle(Theme.secondary)
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 32)
        }
    }

    private func idleCard() -> some View {
        Card {
            VStack(spacing: 0) {
                ZStack {
                    RoundedRectangle(cornerRadius: Theme.Radius.xl, style: .continuous)
                        .fill(Theme.success.opacity(0.1))
                    Lucide(name: "music", size: 28, color: Theme.success)
                }
                .frame(width: 56, height: 56)
                .padding(.bottom, 16)
                Text("Link your Spotify account")
                    .font(Theme.font(18, .medium))
                    .foregroundStyle(Theme.fg)
                Text("Connect your Spotify account to enable playback control on your Car Thing.")
                    .font(Theme.font(14))
                    .foregroundStyle(Theme.secondary)
                    .multilineTextAlignment(.center)
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: 384)
                    .padding(.top, 6)
                    .padding(.bottom, 24)
                Button(loading ? "Starting..." : "Link Spotify") {
                    startAuth()
                }
                .buttonStyle(.web(.success, size: .lg))
                .disabled(loading)
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 32)
        }
    }

    private func startAuth() {
        loading = true
        errorMessage = nil
        Task {
            do {
                try await spotify.startDeviceAuthorization()
            } catch {
                errorMessage = error.localizedDescription
            }
            loading = false
        }
    }
}

private struct PulsingDot: View {
    @State private var pulsing = false

    var body: some View {
        Circle()
            .fill(Theme.accent)
            .frame(width: 6, height: 6)
            .opacity(pulsing ? 0.5 : 1)
            .animation(.easeInOut(duration: 1).repeatForever(autoreverses: true), value: pulsing)
            .onAppear { pulsing = true }
    }
}

private struct SpinningLoader: View {
    var size: CGFloat = 20
    @State private var spinning = false

    var body: some View {
        Lucide(name: "loader-circle", size: size, color: Theme.muted)
            .rotationEffect(.degrees(spinning ? 360 : 0))
            .animation(.linear(duration: 1).repeatForever(autoreverses: false), value: spinning)
            .onAppear { spinning = true }
    }
}
