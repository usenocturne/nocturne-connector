import SwiftUI

struct NocturneLogo: View {
    var height: CGFloat = 36
    var color: Color = Theme.fg

    var body: some View {
        Image("NocturneWordmark")
            .renderingMode(.template)
            .resizable()
            .aspectRatio(165.0 / 24.0, contentMode: .fit)
            .frame(height: height)
            .foregroundStyle(color)
    }
}
