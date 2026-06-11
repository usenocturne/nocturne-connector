import SwiftUI

struct NocturneAuthView: View {
    @EnvironmentObject var auth: AuthService

    var body: some View {
        if auth.status.authenticated {
            signedIn
        } else {
            signIn
        }
    }

    private var signIn: some View {
        VStack(alignment: .leading, spacing: 0) {
            heading
                .padding(.bottom, 16)
            Card {
                PairCodeForm(
                    title: "Sign in to continue",
                    subtitlePrefix: "Visit ",
                    subtitleSuffix: " on your phone or computer, then enter the code below."
                )
            }
            .frame(maxWidth: 512)
            .frame(maxWidth: .infinity)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var signedIn: some View {
        VStack(alignment: .leading, spacing: 0) {
            heading
                .padding(.bottom, 16)
            Card {
                Text("Signed in as")
                    .font(Theme.font(16, .medium))
                    .foregroundStyle(Theme.fg)
                VStack(alignment: .leading, spacing: 0) {
                    Text(auth.status.user?.email ?? "—")
                        .font(Theme.font(18, .medium))
                        .foregroundStyle(Theme.fg)
                        .padding(.bottom, 24)
                    Button {
                        Task { await auth.signOut() }
                    } label: {
                        Text("Sign Out")
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.web(.secondary))
                }
                .frame(maxWidth: .infinity)
            }
            .frame(maxWidth: 512)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var heading: some View {
        Text("Account")
            .font(Theme.font(24, .medium))
            .foregroundStyle(Theme.fg)
    }
}
