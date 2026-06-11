import SwiftUI

struct RootView: View {
    @EnvironmentObject var auth: AuthService

    var body: some View {
        Group {
            if auth.status.isInitializing {
                loading
            } else if !auth.status.setupComplete {
                SetupWizardView()
            } else if auth.status.authenticated {
                MainLayout()
            } else {
                PairConnectorView()
            }
        }
        .preferredColorScheme(.dark)
        .background(Theme.bg)
        .coordinateSpace(.named(Theme.rootSpaceName))
    }

    private var loading: some View {
        ZStack {
            Theme.bg.ignoresSafeArea()
            VStack(spacing: 12) {
                WebSpinner(size: 32)
                Text("Loading...")
                    .font(Theme.font(14))
                    .foregroundStyle(Theme.secondary)
            }
        }
    }
}
