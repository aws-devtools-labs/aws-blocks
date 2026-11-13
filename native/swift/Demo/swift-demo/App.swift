//
// Copyright Amazon.com Inc. or its affiliates.
// All Rights Reserved.
//
// SPDX-License-Identifier: Apache-2.0
//

import AuthenticationServices
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
            error = nil
        } catch {
            self.error = error.localizedDescription
        }
    }

    /// Where the backend relays a federated sign-in back to. The backend lists it in
    /// `redirects.allowedRelayOrigins`.
    static let relayTo = "blocksdemo://auth"

    private var oidcClient: OIDCClient<String>?

    /// The `Auth` block's OIDC client, on the app's own client. It is built for the providers the
    /// state's `signIn:<id>` actions name, and rebuilt only when a state names one it lacks.
    private func oidc() -> OIDCClient<String> {
        let offered = Set(authState?.actions.compactMap { OIDCClient.providerIdOf($0.name) } ?? [])
        if let client = oidcClient, offered.isSubset(of: client.providers) {
            return client
        }
        let providers = offered.union(oidcClient?.providers ?? []).sorted()
        let client = OIDCClient.forAuth(client: blocks.client, providers: providers, relayTo: Self.relayTo)
        oidcClient = client
        return client
    }

    /// A `signIn:<id>` action: sign in through the backend's relay, then read the new state.
    func federatedSignIn(provider: String) async {
        do {
            _ = try await oidc().signIn(provider: provider, launcher: WebAuthenticationLauncher())
            await refreshAuth()
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

// MARK: - Browser launcher

/// Opens the identity provider in `ASWebAuthenticationSession` and returns the relayed callback URL.
final class WebAuthenticationLauncher: NSObject, BrowserLauncher, ASWebAuthenticationPresentationContextProviding,
    @unchecked Sendable {
    /// Held while the sheet is open.
    private var session: ASWebAuthenticationSession?

    func launch(authorizeURL: URL, callbackScheme: String) async throws -> URL {
        try await present(authorizeURL, callbackScheme: callbackScheme)
    }

    @MainActor
    private func present(_ authorizeURL: URL, callbackScheme: String) async throws -> URL {
        defer { session = nil }
        return try await withCheckedThrowingContinuation { continuation in
            let session = ASWebAuthenticationSession(url: authorizeURL, callbackURLScheme: callbackScheme) { url, error in
                if let url {
                    continuation.resume(returning: url)
                } else {
                    continuation.resume(throwing: error ?? URLError(.cancelled))
                }
            }
            session.presentationContextProvider = self
            self.session = session
            session.start()
        }
    }

    @MainActor
    func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
        let scene = scenes.first { $0.activationState == .foregroundActive } ?? scenes.first
        return scene?.windows.first { $0.isKeyWindow } ?? scene?.windows.first ?? ASPresentationAnchor()
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
