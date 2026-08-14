//
// Copyright Amazon.com Inc. or its affiliates.
// All Rights Reserved.
//
// SPDX-License-Identifier: Apache-2.0
//

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
    let api = Api()
    let authApi = AuthApi()

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
