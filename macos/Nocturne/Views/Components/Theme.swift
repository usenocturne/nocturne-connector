import SwiftUI

extension Color {
    init(hex: UInt32) {
        self.init(
            .sRGB,
            red: Double((hex >> 16) & 0xff) / 255,
            green: Double((hex >> 8) & 0xff) / 255,
            blue: Double(hex & 0xff) / 255
        )
    }
}

enum Theme {
    static let rootSpaceName = "nocturne-window-root"

    static let bg = Color(hex: 0x0c0c0c)
    static let raised = Color(hex: 0x141414)
    static let hover = Color(hex: 0x1c1c1c)
    static let inset = Color(hex: 0x0a0a0a)

    static let fg = Color(hex: 0xf0f0f0)
    static let secondary = Color(hex: 0x888888)
    static let muted = Color(hex: 0x505050)

    static let line = Color(hex: 0x1e1e1e)
    static let lineHover = Color(hex: 0x363636)

    static let accent = Color(hex: 0x7456c1)
    static let accentHover = Color(hex: 0x8668d0)
    static let destructive = Color(hex: 0xef4444)
    static let destructiveHover = Color(hex: 0xdc2626)
    static let success = Color(hex: 0x22c55e)

    static let red400 = Color(hex: 0xf87171)
    static let green400 = Color(hex: 0x4ade80)

    enum Radius {
        static let sm: CGFloat = 8
        static let md: CGFloat = 10
        static let lg: CGFloat = 12
        static let xl: CGFloat = 16
        static let xxl: CGFloat = 20
    }

    static func font(_ size: CGFloat, _ weight: Font.Weight = .regular) -> Font {
        let name: String
        switch weight {
        case .medium: name = "Switzer-Medium"
        case .semibold: name = "Switzer-Semibold"
        case .bold: name = "Switzer-Bold"
        default: name = "Switzer-Regular"
        }
        guard NSFont(name: name, size: size) != nil else {
            return .system(size: size, weight: weight)
        }
        return .custom(name, fixedSize: size)
    }
}

struct Lucide: View {
    let name: String
    var size: CGFloat = 16
    var color: Color = Theme.fg

    var body: some View {
        Image("lucide-\(name)")
            .renderingMode(.template)
            .resizable()
            .scaledToFit()
            .frame(width: size, height: size)
            .foregroundStyle(color)
    }
}

struct Card<Content: View>: View {
    var padding: CGFloat = 24
    var spacing: CGFloat = 16
    let content: () -> Content

    init(padding: CGFloat = 24, spacing: CGFloat = 16, @ViewBuilder content: @escaping () -> Content) {
        self.padding = padding
        self.spacing = spacing
        self.content = content
    }

    var body: some View {
        VStack(alignment: .leading, spacing: spacing) {
            content()
        }
        .padding(padding)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            RoundedRectangle(cornerRadius: Theme.Radius.xxl, style: .continuous)
                .fill(Theme.raised)
        )
        .overlay(
            RoundedRectangle(cornerRadius: Theme.Radius.xxl, style: .continuous)
                .stroke(Theme.line, lineWidth: 1)
        )
    }
}

enum WebButtonVariant {
    case primary
    case outline
    case secondary
    case ghost
    case destructive
    case success
}

enum WebButtonSize {
    case xs, sm, base, lg

    var height: CGFloat {
        switch self {
        case .xs: return 28
        case .sm: return 32
        case .base: return 36
        case .lg: return 44
        }
    }

    var paddingX: CGFloat {
        switch self {
        case .xs: return 10
        case .sm: return 12
        case .base: return 16
        case .lg: return 32
        }
    }

    var fontSize: CGFloat {
        switch self {
        case .xs, .sm: return 12
        case .base, .lg: return 14
        }
    }

    var radius: CGFloat {
        switch self {
        case .xs, .sm: return Theme.Radius.md
        case .base, .lg: return Theme.Radius.lg
        }
    }

    var gap: CGFloat {
        switch self {
        case .xs: return 4
        case .sm: return 6
        case .base, .lg: return 8
        }
    }
}

struct WebButtonStyle: ButtonStyle {
    var variant: WebButtonVariant = .primary
    var size: WebButtonSize = .base

    @Environment(\.isEnabled) private var isEnabled
    @State private var hovering = false

    func makeBody(configuration: Configuration) -> some View {
        let active = configuration.isPressed || hovering
        configuration.label
            .font(Theme.font(size.fontSize, .medium))
            .lineLimit(1)
            .foregroundStyle(foreground(active: active))
            .padding(.horizontal, size.paddingX)
            .frame(height: size.height)
            .background(
                RoundedRectangle(cornerRadius: size.radius, style: .continuous)
                    .fill(background(active: active))
            )
            .overlay(
                RoundedRectangle(cornerRadius: size.radius, style: .continuous)
                    .stroke(border(active: active), lineWidth: 1)
            )
            .opacity(isEnabled ? 1 : 0.4)
            .animation(.easeOut(duration: 0.2), value: hovering)
            .onHover { hovering = $0 }
            .contentShape(RoundedRectangle(cornerRadius: size.radius, style: .continuous))
    }

    private func foreground(active: Bool) -> Color {
        switch variant {
        case .primary, .success: return Theme.bg
        case .outline, .secondary: return Theme.fg
        case .ghost: return active ? Theme.fg : Theme.secondary
        case .destructive: return .white
        }
    }

    private func background(active: Bool) -> Color {
        switch variant {
        case .primary: return active ? Theme.fg.opacity(0.9) : Theme.fg
        case .outline: return active ? Theme.hover : .clear
        case .secondary: return active ? Theme.hover : Theme.raised
        case .ghost: return active ? Theme.hover : .clear
        case .destructive: return active ? Theme.destructiveHover : Theme.destructive
        case .success: return active ? Theme.success.opacity(0.9) : Theme.success
        }
    }

    private func border(active: Bool) -> Color {
        switch variant {
        case .outline, .secondary: return active ? Theme.lineHover : Theme.line
        default: return .clear
        }
    }
}

extension ButtonStyle where Self == WebButtonStyle {
    static func web(_ variant: WebButtonVariant = .primary, size: WebButtonSize = .base) -> WebButtonStyle {
        WebButtonStyle(variant: variant, size: size)
    }
}

enum BadgeVariant {
    case accent, secondary, destructive, outline, success
}

struct WebBadge: View {
    let text: String
    var variant: BadgeVariant = .accent

    var body: some View {
        Text(text)
            .font(Theme.font(12, .medium))
            .foregroundStyle(foreground)
            .padding(.horizontal, 10)
            .padding(.vertical, 2)
            .background(Capsule().fill(background))
            .overlay(Capsule().stroke(border, lineWidth: 1))
    }

    private var foreground: Color {
        switch variant {
        case .accent: return Theme.accent
        case .secondary, .outline: return Theme.secondary
        case .destructive: return Theme.red400
        case .success: return Theme.green400
        }
    }

    private var background: Color {
        switch variant {
        case .accent: return Theme.accent.opacity(0.15)
        case .secondary: return Theme.raised
        case .destructive: return Theme.destructive.opacity(0.15)
        case .outline: return .clear
        case .success: return Theme.success.opacity(0.15)
        }
    }

    private var border: Color {
        switch variant {
        case .secondary, .outline: return Theme.line
        default: return .clear
        }
    }
}

struct SectionLabel: View {
    let text: String
    var color: Color = Theme.muted

    var body: some View {
        Text(text.uppercased())
            .font(Theme.font(12, .medium))
            .tracking(1.2)
            .foregroundStyle(color)
    }
}

struct InfoRow: View {
    let label: String
    let value: String
    var mono = false

    var body: some View {
        HStack {
            Text(label)
                .font(Theme.font(14))
                .foregroundStyle(Theme.secondary)
            Spacer(minLength: 16)
            Text(value)
                .font(mono ? .system(size: 12, design: .monospaced) : Theme.font(14, .medium))
                .foregroundStyle(Theme.fg)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
        .background(
            RoundedRectangle(cornerRadius: Theme.Radius.lg, style: .continuous)
                .fill(Theme.bg)
        )
    }
}

struct WebSpinner: View {
    var size: CGFloat = 32
    @State private var spinning = false

    var body: some View {
        Circle()
            .stroke(Theme.line, lineWidth: 2)
            .overlay(
                Circle()
                    .trim(from: 0, to: 0.25)
                    .stroke(Theme.accent, style: StrokeStyle(lineWidth: 2, lineCap: .round))
                    .rotationEffect(.degrees(spinning ? 360 : 0))
                    .animation(.linear(duration: 1).repeatForever(autoreverses: false), value: spinning)
            )
            .frame(width: size, height: size)
            .onAppear { spinning = true }
    }
}

struct WebDialog<DialogContent: View>: ViewModifier {
    @Binding var isPresented: Bool
    var maxWidth: CGFloat = 512
    var dismissOnBackdropTap = true
    @ViewBuilder let dialog: () -> DialogContent

    func body(content: Content) -> some View {
        content.overlay {
            if isPresented {
                GeometryReader { geo in
                    let win = geo.bounds(of: .named(Theme.rootSpaceName))
                        ?? CGRect(origin: .zero, size: geo.size)
                    ZStack {
                        Color.black.opacity(0.6)
                            .background(.ultraThinMaterial.opacity(0.5))
                            .onTapGesture {
                                if dismissOnBackdropTap { isPresented = false }
                            }

                        VStack(alignment: .leading, spacing: 16) {
                            dialog()
                        }
                        .padding(24)
                        .frame(maxWidth: maxWidth, alignment: .leading)
                        .background(
                            RoundedRectangle(cornerRadius: Theme.Radius.xxl, style: .continuous)
                                .fill(Theme.raised)
                        )
                        .overlay(
                            RoundedRectangle(cornerRadius: Theme.Radius.xxl, style: .continuous)
                                .stroke(Theme.line, lineWidth: 1)
                        )
                        .shadow(color: .black.opacity(0.5), radius: 50, y: 25)
                        .padding(16)
                        .transition(.opacity.combined(with: .scale(scale: 0.95)))
                    }
                    .frame(width: win.width, height: win.height)
                    .position(x: win.midX, y: win.midY)
                }
                .ignoresSafeArea()
                .transition(.opacity)
            }
        }
        .animation(.easeOut(duration: 0.2), value: isPresented)
    }
}

extension View {
    func webDialog<DialogContent: View>(
        isPresented: Binding<Bool>,
        maxWidth: CGFloat = 512,
        dismissOnBackdropTap: Bool = true,
        @ViewBuilder dialog: @escaping () -> DialogContent
    ) -> some View {
        modifier(WebDialog(
            isPresented: isPresented,
            maxWidth: maxWidth,
            dismissOnBackdropTap: dismissOnBackdropTap,
            dialog: dialog
        ))
    }
}

struct DialogTitle: View {
    let text: String
    var body: some View {
        Text(text)
            .font(Theme.font(18, .medium))
            .foregroundStyle(Theme.fg)
    }
}

struct DialogDescription: View {
    let text: String
    var body: some View {
        Text(text)
            .font(Theme.font(14))
            .foregroundStyle(Theme.secondary)
            .fixedSize(horizontal: false, vertical: true)
    }
}

struct PrimaryButtonStyle: ButtonStyle {
    var prominent: Bool = true

    func makeBody(configuration: Configuration) -> some View {
        WebButtonStyle(variant: prominent ? .primary : .outline).makeBody(configuration: configuration)
    }
}

struct DestructiveButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        WebButtonStyle(variant: .destructive).makeBody(configuration: configuration)
    }
}

struct PillBadge: View {
    let text: String
    var tint: Color = Theme.success

    var body: some View {
        WebBadge(text: text, variant: tint == Theme.success ? .success : .secondary)
    }
}
