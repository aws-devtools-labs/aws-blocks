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
                throw TransportError(message: "Non-HTTP response following authorize redirect")
            }

            if (300 ..< 400).contains(httpResponse.statusCode) {
                guard let location = httpResponse.value(forHTTPHeaderField: "Location"),
                      let next = URL(string: location, relativeTo: current) else {
                    throw OIDCError.callbackError("Redirect without Location at \(current)", nil)
                }
                let resolved = next.absoluteURL
                if resolved.scheme == callbackScheme {
                    return resolved
                }
                current = resolved
                continue
            }

            throw OIDCError.callbackError(
                "Expected redirect chain to reach \(callbackScheme):// but got HTTP \(httpResponse.statusCode) at \(current)",
                nil
            )
        }
        throw OIDCError.callbackError("Too many redirects without reaching \(callbackScheme)://", nil)
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
/// an authenticated RPC, session restore and sign-out. The client comes from the backend's
/// `oidcAuthApi.getClient()` (`Auth.createOidcApi()`), typed by the block's provider ids.
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

    private func getOidcClient() async throws -> OIDCClient<OidcAuthApi.GetClient.Provider> {
        try XCTSkipUnless(
            Self.hasHeadlessIdp,
            "Auth's stub IdP runs only locally and on sandbox deployments. Against a deployed backend "
                + "these tests need RUN_OIDC=1 and a headless IdP: that deployed stub, or a real, auto-approving one "
                + "(NATIVE_E2E_OIDC_ISSUER; see .github/workflows/native-sdk-e2e.yml)"
        )
        return try await blocks.oidcAuthApi.getClient()
    }

    func testSignInRelayAndAuthenticatedRPC() async throws {
        let oidc = try await getOidcClient()
        let launcher = HttpRelayLauncher()

        let user = try await oidc.signIn(provider: .google, relayTo: relayTo, launcher: launcher)
        XCTAssertFalse(user.userId.isEmpty, "signInRelay returned a user")
        XCTAssertEqual(user.signInProvider, provider)

        let currentUser = try await api.oidcRequireAuth()
        XCTAssertFalse(currentUser.userId.isEmpty)
        XCTAssertEqual(currentUser.userId, user.userId)
        XCTAssertEqual(currentUser.provider, provider)
    }

    func testSignOut() async throws {
        let oidc = try await getOidcClient()
        let launcher = HttpRelayLauncher()

        _ = try await oidc.signIn(provider: .google, relayTo: relayTo, launcher: launcher)

        let logoutURL = try await oidc.signOut()
        XCTAssertNotNil(logoutURL, "the stub IdP has a logout URL")

        let authed = try await api.oidcCheckAuth()
        XCTAssertFalse(authed)
    }

    /// The native flow: the sign-in button comes from the OIDC client's typed `providers`, and the
    /// `Auth` sign-in state machine says whether the user is signed in, before and after.
    func testFederatedSignInThroughTheAuthStateMachine() async throws {
        let oidc = try await getOidcClient()
        let signedOut = try await blocks.oidcAuthStateApi.getAuthState()
        XCTAssertEqual(signedOut.state, .signedOut)
        // The backend can serve more providers than google, so check for google rather than an exact list.
        let buttons = oidc.providers.compactMap(OidcAuthApi.GetClient.Provider.init(rawValue:))
        XCTAssertTrue(buttons.contains(.google), "a button per provider includes google: \(buttons)")

        let user = try await oidc.signIn(provider: .google, relayTo: relayTo, launcher: HttpRelayLauncher())

        let signedIn = try await blocks.oidcAuthStateApi.getAuthState()
        XCTAssertEqual(signedIn.state, .signedIn)
        XCTAssertEqual(signedIn.user?.userId, user.userId)

        // A relaunch: a fresh `Blocks` shares the Keychain cookie store and restores the session.
        let relaunched = Blocks(server: Self.server)
        defer { relaunched.close() }
        let restoredClient = try await relaunched.oidcAuthApi.getClient()
        let restored = try await restoredClient.restore()
        XCTAssertEqual(restored?.userId, user.userId)
        let restoredState = await restoredClient.authState
        XCTAssertEqual(restoredState, restored.map(OIDCAuthState.signedIn))

        let logoutURL = try await restoredClient.signOut()
        XCTAssertNotNil(logoutURL, "the stub IdP has a logout URL")

        let afterSignOut = try await restoredClient.restore()
        XCTAssertNil(afterSignOut)
        let finalState = try await blocks.oidcAuthStateApi.getAuthState()
        XCTAssertEqual(finalState.state, .signedOut)
    }

    /// Signs in through a real `ASWebAuthenticationSession` sheet. A private session has no consent prompt, so the IdP's
    /// redirects finish it with no one tapping.
    func testSignInThroughTheSystemSheet() async throws {
        let oidc = try await getOidcClient()
        let launcher = WebAuthenticationSessionLauncher(prefersEphemeralWebBrowserSession: true)
        let relayTo = relayTo

        let user = try await withSheetTimeout {
            try await oidc.signIn(provider: .google, relayTo: relayTo, launcher: launcher)
        }
        XCTAssertFalse(user.userId.isEmpty)

        let currentUser = try await api.oidcRequireAuth()
        XCTAssertEqual(currentUser.userId, user.userId)
        XCTAssertEqual(currentUser.provider, provider)
    }

    /// Runs `signIn`, and cancels it (which dismisses the sheet) if it hasn't finished in `seconds`, so a sheet left
    /// waiting for a tap fails the test instead of hanging the job.
    private func withSheetTimeout(
        seconds: UInt64 = 90,
        _ signIn: @escaping @Sendable () async throws -> OIDCUser
    ) async throws -> OIDCUser {
        try await withThrowingTaskGroup(of: OIDCUser?.self) { group in
            group.addTask { try await signIn() }
            group.addTask {
                try await Task.sleep(nanoseconds: seconds * 1_000_000_000)
                return nil
            }
            defer { group.cancelAll() }
            guard let user = try await group.next() ?? nil else {
                throw OIDCError.callbackError("The sign-in sheet didn't finish within \(seconds)s; it may be waiting for a tap", nil)
            }
            return user
        }
    }
}
