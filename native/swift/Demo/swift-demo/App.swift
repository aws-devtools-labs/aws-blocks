//
// Copyright Amazon.com Inc. or its affiliates.
// All Rights Reserved.
//
// SPDX-License-Identifier: Apache-2.0
//

import BlocksRuntime
import SwiftUI

// MARK: - Configuration

// MARK: - App Entry Point

@main
struct BlocksDemoApp: App {
    @StateObject private var appState = AppState()

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environmentObject(appState)
        }
    }
}

// MARK: - Shared App State

@MainActor
final class AppState: ObservableObject {
    // One client for the app's lifetime, so it is never closed.
    let blocks = Blocks()
    var api: Api { blocks.api }
    var authApi: AuthApi { blocks.authApi }

    @Published var authState: AuthState?
    /// The providers the OIDC client signs in with: one sign-in button each.
    @Published var federatedProviders: [String] = []
    @Published var error: String?

    var isSignedIn: Bool {
        authState?.state == .signedIn
    }

    var currentUser: AuthUser? {
        authState?.user
    }

    func refreshAuth() async {
        do {
            authState = try await authApi.getAuthState()
            federatedProviders = try await oidc().providers
            error = nil
        } catch {
            self.error = error.localizedDescription
        }
    }

    /// Where the backend relays a federated sign-in back to. The backend lists it in
    /// `redirects.allowedRelayOrigins`.
    static let relayTo = "blocksdemo://auth"

    /// The `Auth` block's OIDC client from `oidcAuthApi.getClient()`, fetched on first use and kept
    /// for the app's lifetime. It carries the block's routes and provider ids.
    private var oidcClient: OIDCClient<String>?

    private func oidc() async throws -> OIDCClient<String> {
        if let oidcClient {
            return oidcClient
        }
        let client = try await blocks.oidcAuthApi.getClient()
        oidcClient = client
        return client
    }

    /// A provider's sign-in button: sign in through the backend's relay, then read the new state.
    func federatedSignIn(provider: String) async {
        do {
            // Opens the system sign-in sheet (`WebAuthenticationSessionLauncher` at its defaults).
            _ = try await oidc().signIn(provider: provider, relayTo: Self.relayTo)
            await refreshAuth()
        } catch OIDCError.cancelled {
            // The user closed the sign-in sheet: nothing to report.
        } catch {
            self.error = error.localizedDescription
        }
    }

    /// A federated user's `signOut` action: sign out, open the provider's logout page, then read the new state.
    func federatedSignOut() async {
        do {
            if let logoutURL = try await oidc().signOut() {
                await UIApplication.shared.open(logoutURL)
            }
            await refreshAuth()
        } catch {
            self.error = error.localizedDescription
        }
    }

    func performAuthAction(_ input: AuthApi.SetAuthState.Input) async {
        do {
            authState = try await authApi.setAuthState(input: input)
            error = authState?.error
        } catch {
            self.error = error.localizedDescription
        }
    }
}

// MARK: - Root Content View

struct ContentView: View {
    @EnvironmentObject var appState: AppState

    var body: some View {
        TabView {
            NavigationStack {
                TodoSectionView()
                    .navigationTitle("Todos")
            }
            .tabItem {
                Label("Todos", systemImage: "checklist")
            }

            NavigationStack {
                AuthSectionView()
                    .navigationTitle("Account")
            }
            .tabItem {
                Label("Account", systemImage: "person.circle")
            }

            NavigationStack {
                List { CookieTestView() }
                    .navigationTitle("Cookies")
            }
            .tabItem {
                Label("Cookies", systemImage: "cup.and.saucer")
            }

            NavigationStack {
                List { KVStoreTestView() }
                    .navigationTitle("KV Store")
            }
            .tabItem {
                Label("KV Store", systemImage: "externaldrive")
            }

            NavigationStack {
                List { RunAllTestsView() }
                    .navigationTitle("Tests")
            }
            .tabItem {
                Label("Tests", systemImage: "checkmark.seal")
            }

            NavigationStack {
                CursorTrackingView()
                    .navigationTitle("Cursors")
            }
            .tabItem {
                Label("Cursors", systemImage: "hand.draw")
            }

            NavigationStack {
                FileTransferView()
                    .navigationTitle("Files")
            }
            .tabItem {
                Label("Files", systemImage: "doc.fill")
            }
        }
        .task {
            await appState.refreshAuth()
        }
    }
}
