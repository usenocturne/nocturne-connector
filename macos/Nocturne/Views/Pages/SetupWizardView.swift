import SwiftUI

struct SetupWizardView: View {
    @EnvironmentObject var auth: AuthService
    @EnvironmentObject var spotify: SpotifyService

    @State private var step: Int = 0
    @State private var finishing: Bool = false
    @State private var finishError: String? = nil

    private let steps = ["Welcome", "Account", "Spotify", "Bluetooth", "Analytics", "Done"]

    var body: some View {
        VStack(spacing: 0) {
            NocturneLogo(height: 36)
                .padding(.vertical, 32)

            progressBar
                .frame(maxWidth: 1024)
                .padding(.horizontal, 24)

            GeometryReader { geo in
                ScrollView {
                    VStack(spacing: 0) {
                        stepIndicators
                            .padding(.bottom, 32)

                        stepContent

                        if step > 0 && step < 5 {
                            navigationBar
                                .padding(.top, 24)
                        }
                    }
                    .frame(maxWidth: 1024)
                    .padding(24)
                    .frame(maxWidth: .infinity)
                    .frame(minHeight: geo.size.height)
                }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Theme.bg)
        .onChange(of: auth.status.authenticated) { _, newValue in
            if step == 1 && newValue { advance() }
        }
    }

    private var progress: Double {
        Double(step) / Double(steps.count - 1)
    }

    private var progressBar: some View {
        GeometryReader { geo in
            ZStack(alignment: .leading) {
                Capsule().fill(Theme.line)
                Capsule()
                    .fill(Theme.accent)
                    .frame(width: geo.size.width * progress)
            }
        }
        .frame(height: 6)
        .animation(.easeOut(duration: 0.3), value: step)
    }

    @ViewBuilder
    private var stepContent: some View {
        switch step {
        case 0: welcomeStep
        case 1: NocturneAuthView()
        case 2: SpotifyAuthView(onLinked: { advance() })
        case 3: BluetoothPairingView()
        case 4: AnalyticsConsentView()
        case 5: doneStep
        default: EmptyView()
        }
    }

    private var stepIndicators: some View {
        HStack(spacing: 16) {
            ForEach(steps.indices, id: \.self) { i in
                HStack(spacing: 16) {
                    HStack(spacing: 8) {
                        Text("\(i + 1)")
                            .font(Theme.font(12, .medium))
                            .foregroundStyle(circleForeground(i))
                            .frame(width: 24, height: 24)
                            .background(Circle().fill(circleBackground(i)))
                            .overlay {
                                if step != i {
                                    Circle().stroke(Theme.line, lineWidth: 1)
                                }
                            }
                        Text(steps[i])
                            .font(Theme.font(14))
                            .foregroundStyle(labelColor(i))
                    }
                    if i < steps.count - 1 {
                        Rectangle()
                            .fill(Theme.line)
                            .frame(width: 32, height: 1)
                    }
                }
            }
        }
    }

    private func circleBackground(_ i: Int) -> Color {
        if step == i { return Theme.accent }
        return step > i ? Theme.raised : Theme.inset
    }

    private func circleForeground(_ i: Int) -> Color {
        if step == i { return .white }
        return step > i ? Theme.fg : Theme.muted
    }

    private func labelColor(_ i: Int) -> Color {
        if step == i { return Theme.fg }
        return step > i ? Theme.secondary : Theme.muted
    }

    private var welcomeStep: some View {
        Card {
            VStack(spacing: 0) {
                Text("Welcome to Nocturne")
                    .font(Theme.font(36, .medium))
                    .tracking(-0.75)
                    .foregroundStyle(Theme.fg)
                    .multilineTextAlignment(.center)
                    .padding(.bottom, 12)
                Text("Let's set up your Mac to connect with your Nocturne device.")
                    .font(Theme.font(16))
                    .foregroundStyle(Theme.secondary)
                    .multilineTextAlignment(.center)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.bottom, 32)
                Button("Get Started") { advance() }
                    .buttonStyle(.web(.primary, size: .lg))
            }
            .frame(maxWidth: .infinity)
        }
        .frame(maxWidth: 672)
        .frame(maxWidth: .infinity)
    }

    private var doneStep: some View {
        Card {
            VStack(spacing: 0) {
                Text("All Set!")
                    .font(Theme.font(30, .medium))
                    .tracking(-0.6)
                    .foregroundStyle(Theme.fg)
                    .multilineTextAlignment(.center)
                    .padding(.bottom, 16)
                Text("Your Nocturne connector is ready. Head to the dashboard to manage your devices.")
                    .font(Theme.font(16))
                    .foregroundStyle(Theme.secondary)
                    .multilineTextAlignment(.center)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.bottom, 32)
                Button(finishing ? "Saving..." : "Go to Dashboard") {
                    finish()
                }
                .buttonStyle(.web(.primary, size: .lg))
                .disabled(finishing)
                if let finishError {
                    DestructiveAlert(text: finishError)
                        .padding(.top, 16)
                }
            }
            .frame(maxWidth: .infinity)
        }
        .frame(maxWidth: 672)
        .frame(maxWidth: .infinity)
    }

    private var navigationBar: some View {
        HStack {
            Button("Back") { goBack() }
                .buttonStyle(.web(.outline))
            Spacer()
            Button(step == 4 ? "Finish" : "Next") { advance() }
                .buttonStyle(.web(.primary))
                .disabled(nextDisabled)
        }
        .frame(maxWidth: 672)
        .frame(maxWidth: .infinity)
    }

    private var nextDisabled: Bool {
        if step == 1 && !auth.status.authenticated { return true }
        if step == 2 {
            switch spotify.authState {
            case .linked, .skipped: return false
            default: return true
            }
        }
        return false
    }

    private func advance() {
        guard step < steps.count - 1 else { return }
        step += 1
    }

    private func goBack() {
        guard step > 0 else { return }
        step -= 1
    }

    private func finish() {
        finishing = true
        auth.markSetupComplete()
        finishing = false
    }
}
