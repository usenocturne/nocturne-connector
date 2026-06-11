import SwiftUI

struct AnalyticsConsentView: View {
    @EnvironmentObject var analytics: AnalyticsService

    var body: some View {
        Card {
            VStack(spacing: 0) {
                Text("Analytics Notice")
                    .font(Theme.font(30, .medium))
                    .tracking(-0.6)
                    .foregroundStyle(Theme.fg)
                    .multilineTextAlignment(.center)
                    .padding(.bottom, 12)
                Text("Nocturne collects anonymous usage data to help improve Nocturne Connector.")
                    .font(Theme.font(16))
                    .foregroundStyle(Theme.secondary)
                    .multilineTextAlignment(.center)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.bottom, 12)
                Text("You can disable analytics at any time in Settings.")
                    .font(Theme.font(16))
                    .foregroundStyle(Theme.secondary)
                    .multilineTextAlignment(.center)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .frame(maxWidth: .infinity)
        }
        .frame(maxWidth: 672)
        .frame(maxWidth: .infinity)
    }
}
