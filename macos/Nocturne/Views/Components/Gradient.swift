import SwiftUI

struct GradientBackdrop: View {
    var colors: [Color] = [Color(hex: 0x1a132e), Color(hex: 0x0c0c0c), Color(hex: 0x0a0a0a)]

    var body: some View {
        GeometryReader { geo in
            let angle = Angle(degrees: 115 - 90)
            let dx = CGFloat(cos(angle.radians))
            let dy = CGFloat(sin(angle.radians))
            let w = geo.size.width
            let h = geo.size.height
            let halfLen = (abs(dx) * w + abs(dy) * h) / 2
            let center = CGPoint(x: w / 2, y: h / 2)
            let start = UnitPoint(
                x: (center.x - dx * halfLen) / max(w, 1),
                y: (center.y - dy * halfLen) / max(h, 1)
            )
            let end = UnitPoint(
                x: (center.x + dx * halfLen) / max(w, 1),
                y: (center.y + dy * halfLen) / max(h, 1)
            )
            LinearGradient(
                stops: [
                    .init(color: colors[0], location: 0.28),
                    .init(color: colors[1], location: 0.70),
                    .init(color: colors[2], location: 1.0),
                ],
                startPoint: start,
                endPoint: end
            )
        }
        .ignoresSafeArea()
    }
}
