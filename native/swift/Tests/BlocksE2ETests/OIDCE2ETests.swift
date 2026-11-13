//
// Copyright Amazon.com Inc. or its affiliates.
// All Rights Reserved.
//
// SPDX-License-Identifier: Apache-2.0
//

import XCTest
import Foundation
@testable import BlocksRuntime

/// HTTP-driven browser launcher that follows the redirect chain produced by
/// the stub IdP (which auto-approves). Returns the first redirect whose
/// scheme matches the expected callback scheme (e.g. `nativebindings`).
final class HttpRelayLauncher: BrowserLauncher, @unchecked Sendable {
    private let session: URLSession
    private let redirectBlocker = RedirectBlocker()

    init() {
        let config = URLSessionConfiguration.ephemeral
        config.httpShouldSetCookies = false
        config.httpCookieAcceptPolicy = .never
        config.httpCookieStorage = nil
        self.session = URLSession(configuration: config, delegate: redirectBlocker, delegateQueue: nil)
    }

    func launch(authorizeURL: URL, callbackScheme: String) async throws -> URL {
        var current = authorizeURL
        for _ in 0 ..< 10 {
            var request = URLRequest(url: current)
            request.httpShouldHandleCookies = false

            let (_, response) = try await session.data(for: request)
            guard let httpResponse = response as? HTTPURLResponse else {
                throw OIDCError.invalidResponse
            }

            if (300 ..< 400).contains(httpResponse.statusCode) {
                guard let location = httpResponse.value(forHTTPHeaderField: "Location"),
                      let next = URL(string: location, relativeTo: current) else {
                    throw OIDCError.callbackError("Redirect without Location at \(current)")
                }
                let resolved = next.absoluteURL
                if resolved.scheme == callbackScheme {
                    return resolved
                }
                current = resolved
                continue
            }

            throw OIDCError.callbackError(
                "Expected redirect chain to reach \(callbackScheme):// but got HTTP \(httpResponse.statusCode) at \(current)"
            )
        }
        throw OIDCError.callbackError("Too many redirects without reaching \(callbackScheme)://")
    }
}

private final class RedirectBlocker: NSObject, URLSessionTaskDelegate {
    func urlSession(
        _ session: URLSession,
        task: URLSessionTask,
        willPerformHTTPRedirection response: HTTPURLResponse,
        newRequest request: URLRequest,
        completionHandler: @escaping (URLRequest?) -> Void
    ) {
        completionHandler(nil)
    }
}

/// OIDC server-relay E2E tests against the `auth-oidc` block: authorize-params, the IdP redirect
/// chain, the relay to `nativebindings://auth`, the code exchange (which sets the session cookie),
/// an authenticated RPC, session restore and sign-out. The client is `OIDCClient.forAuth` on the
/// generated `Blocks`' own client, as an app builds it.
///
/// Locally the IdP is `Auth`'s stub, which auto-approves. A deployed backend serves the stub only
/// on a sandbox deployment (the native-bindings test app always deploys as one), so
/// there the tests run only with `RUN_OIDC=1`, which says the backend serves a headless IdP: that
/// deployed stub, or a real, auto-approving IdP (`NATIVE_E2E_OIDC_ISSUER`; see
/// `.github/workflows/native-sdk-e2e.yml`). Otherwise they are reported as skipped.
final class OIDCE2ETests: BlocksE2ETestCase {

    private let provider = "google"
    private let relayTo = "nativebindings://auth"

    /// Whether the backend under test serves an IdP these tests can drive headlessly.
    private static var hasHeadlessIdp: Bool {
        isLocalEndpoint || ProcessInfo.processInfo.environment["RUN_OIDC"] == "1"
    }

    private func skipWithoutHeadlessIdp() throws {
        try XCTSkipUnless(
            Self.hasHeadlessIdp,
            "Auth's stub IdP runs only locally and on sandbox deployments. Against a deployed backend "
                + "these tests need RUN_OIDC=1 and a headless IdP: that deployed stub, or a real, auto-approving one "
                + "(NATIVE_E2E_OIDC_ISSUER; see .github/workflows/native-sdk-e2e.yml)"
        )
    }

    /// The `auth-oidc` block's client, on `blocks`' own client (its default routes).
    private func oidcClient(on blocks: Blocks) -> OIDCClient<String> {
        OIDCClient.forAuth(client: blocks.client, providers: [provider], relayTo: relayTo)
    }

    func testSignInRelayAndAuthenticatedRPC() async throws {
        try skipWithoutHeadlessIdp()
        let oidc = oidcClient(on: blocks)

        let user = try await oidc.signIn(provider: provider, launcher: HttpRelayLauncher())
        XCTAssertFalse(user.userId.isEmpty, "signIn returned a user")
        XCTAssertEqual(user.signInProvider, provider)

        let currentUser = try await api.oidcRequireAuth()
        XCTAssertFalse(currentUser.userId.isEmpty)
        XCTAssertEqual(currentUser.userId, user.userId)
        XCTAssertEqual(currentUser.provider, provider)
    }

    func testSignOut() async throws {
        try skipWithoutHeadlessIdp()
        let oidc = oidcClient(on: blocks)

        _ = try await oidc.signIn(provider: provider, launcher: HttpRelayLauncher())

        let logoutURL = try await oidc.signOut()
        XCTAssertNotNil(logoutURL, "the stub IdP has a logout URL")

        let authed = try await api.oidcCheckAuth()
        XCTAssertFalse(authed)
    }

    /// The native flow over the `Auth` sign-in state machine: render `getAuthState()`'s actions,
    /// sign in with a `signIn:<id>` action through the OIDC client, then read the state again.
    func testFederatedSignInThroughTheAuthStateMachine() async throws {
        try skipWithoutHeadlessIdp()
        let signedOut = try await blocks.oidcAuthApi.getAuthState()
        XCTAssertEqual(signedOut.state, .signedOut)
        let action = try XCTUnwrap(signedOut.actions.first { $0.name == "signIn:\(provider)" })
        let providerId = try XCTUnwrap(OIDCClient.providerIdOf(action.name))
        XCTAssertEqual(providerId, provider)

        let oidc = oidcClient(on: blocks)
        let user = try await oidc.signIn(provider: providerId, launcher: HttpRelayLauncher())

        let signedIn = try await blocks.oidcAuthApi.getAuthState()
        XCTAssertEqual(signedIn.state, .signedIn)
        XCTAssertEqual(signedIn.user?.userId, user.userId)

        // A relaunch: a fresh `Blocks` shares the Keychain cookie store and restores the session.
        let relaunched = Blocks(server: Self.server)
        defer { relaunched.close() }
        let restoredClient = oidcClient(on: relaunched)
        let restored = try await restoredClient.restore()
        XCTAssertEqual(restored?.userId, user.userId)

        let logoutURL = try await restoredClient.signOut()
        XCTAssertNotNil(logoutURL, "the stub IdP has a logout URL")

        let afterSignOut = try await restoredClient.restore()
        XCTAssertNil(afterSignOut)
        let finalState = try await blocks.oidcAuthApi.getAuthState()
        XCTAssertEqual(finalState.state, .signedOut)
    }
}
