import SwiftUI

struct PairConnectorView: View {
    var body: some View {
        ZStack {
            GradientBackdrop()
            VStack(spacing: 0) {
                NocturneLogo(height: 36)
                    .padding(.bottom, 32)
                Card {
                    PairCodeForm(autoFocus: true)
                }
            }
            .frame(maxWidth: 384)
            .padding(24)
        }
        .background(Theme.bg)
    }
}

struct PairCodeForm: View {
    var title = "Pair Nocturne Connector"
    var subtitlePrefix = "Sign in at "
    var subtitleSuffix = " to generate a pairing code."
    var autoFocus = false

    @EnvironmentObject var auth: AuthService

    @State private var rawCode: String = ""
    @State private var submitting: Bool = false
    @State private var errorMessage: String? = nil
    @FocusState private var codeFocused: Bool

    private var formattedCode: String {
        Self.format(rawCode)
    }

    private var canSubmit: Bool {
        rawCode.count == 8 && !submitting
    }

    var body: some View {
        VStack(spacing: 24) {
            VStack(spacing: 8) {
                Text(title)
                    .font(Theme.font(24, .medium))
                    .tracking(-0.5)
                    .foregroundStyle(Theme.fg)
                    .multilineTextAlignment(.center)
                subtitle
            }
            .frame(maxWidth: .infinity)

            VStack(spacing: 16) {
                VStack(alignment: .leading, spacing: 8) {
                    Text("Pairing Code")
                        .font(Theme.font(14, .medium))
                        .foregroundStyle(Theme.fg)
                    codeField
                }
                Button(action: submit) {
                    Text(submitting ? "Pairing..." : "Pair Connector")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.web(.primary, size: .lg))
                .disabled(!canSubmit)
            }

            if let errorMessage {
                DestructiveAlert(text: errorMessage)
            }
        }
        .onAppear {
            if autoFocus { codeFocused = true }
        }
    }

    private var subtitle: some View {
        var prefix = AttributedString(subtitlePrefix)
        prefix.foregroundColor = Theme.secondary
        var link = AttributedString("usenocturne.com/login")
        link.foregroundColor = Theme.accent
        link.link = URL(string: "https://usenocturne.com/login")
        var suffix = AttributedString(subtitleSuffix)
        suffix.foregroundColor = Theme.secondary

        return Text(prefix + link + suffix)
            .font(Theme.font(14))
            .tint(Theme.accent)
            .multilineTextAlignment(.center)
            .fixedSize(horizontal: false, vertical: true)
    }

    private var codeField: some View {
        TextField("", text: Binding(
            get: { formattedCode },
            set: { newValue in
                rawCode = Self.strip(newValue)
            }
        ), prompt: Text("XXXX-XXXX").foregroundStyle(Theme.muted))
        .textFieldStyle(.plain)
        .focused($codeFocused)
        .font(.system(size: 18, design: .monospaced))
        .tracking(4.5)
        .multilineTextAlignment(.center)
        .foregroundStyle(Theme.fg)
        .frame(height: 48)
        .padding(.horizontal, 12)
        .background(
            RoundedRectangle(cornerRadius: Theme.Radius.lg, style: .continuous)
                .fill(Theme.raised)
        )
        .overlay(
            RoundedRectangle(cornerRadius: Theme.Radius.lg, style: .continuous)
                .stroke(codeFocused ? Theme.lineHover : Theme.line, lineWidth: 1)
        )
        .overlay {
            if codeFocused {
                RoundedRectangle(cornerRadius: Theme.Radius.lg, style: .continuous)
                    .inset(by: -2)
                    .stroke(Theme.accent.opacity(0.2), lineWidth: 2)
            }
        }
        .disabled(submitting)
        .onSubmit(submit)
    }

    private func submit() {
        guard canSubmit else { return }
        submitting = true
        errorMessage = nil
        Task {
            do {
                _ = try await auth.pair(code: formattedCode)
            } catch {
                errorMessage = error.localizedDescription
            }
            submitting = false
        }
    }

    static func strip(_ s: String) -> String {
        let allowed = s.uppercased().unicodeScalars.filter {
            CharacterSet.alphanumerics.contains($0)
        }
        return String(String.UnicodeScalarView(allowed)).prefix(8).description
    }

    static func format(_ raw: String) -> String {
        if raw.count <= 4 { return raw }
        let idx = raw.index(raw.startIndex, offsetBy: 4)
        return raw[..<idx] + "-" + raw[idx...]
    }
}

struct DestructiveAlert: View {
    let text: String

    var body: some View {
        Text(text)
            .font(Theme.font(14))
            .foregroundStyle(Theme.red400)
            .fixedSize(horizontal: false, vertical: true)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 16)
            .padding(.vertical, 12)
            .background(
                RoundedRectangle(cornerRadius: Theme.Radius.lg, style: .continuous)
                    .fill(Theme.destructive.opacity(0.1))
            )
            .overlay(
                RoundedRectangle(cornerRadius: Theme.Radius.lg, style: .continuous)
                    .stroke(Theme.destructive.opacity(0.3), lineWidth: 1)
            )
    }
}
