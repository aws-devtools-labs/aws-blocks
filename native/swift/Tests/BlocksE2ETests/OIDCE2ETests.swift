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
/// chain, the relay to `nativebindings://auth`, the code exchange (which sets the session cookie)
/// and an authenticated RPC. The client is built from the block's fixed routes, with no
/// server-supplied descriptor.
///
/// Locally the IdP is `Auth`'s stub, which auto-approves. A deployed backend serves the stub only
/// when the provider opts in with `unsafeAllowDeployed` (the native-bindings test app does), so
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

    private func getOidcClient() throws -> OIDCClient {
        try XCTSkipUnless(
            Self.hasHeadlessIdp,
            "Auth's stub IdP is local-only unless deployed with unsafeAllowDeployed. Against a deployed backend "
                + "these tests need RUN_OIDC=1 and a headless IdP: that deployed stub, or a real, auto-approving one "
                + "(NATIVE_E2E_OIDC_ISSUER; see .github/workflows/native-sdk-e2e.yml)"
        )
        let client = BlocksClient(server: Self.server)
        // `Auth`'s fixed routes (packages/bb-auth DESIGN.md → Routes). `OIDCClient` derives the
        // authorize-params and callback paths from `exchangePath`.
        return OIDCClient(
            exchangePath: "/aws-blocks/auth/exchange",
            refreshPath: "/aws-blocks/auth/exchange/refresh",
            signOutPath: "/aws-blocks/auth/signout",
            providers: [provider],
            providerConfigs: [:],
            baseUrl: client.baseUrl,
            client: client
        )
    }

    func testSignInRelayAndAuthenticatedRPC() async throws {
        let oidc = try getOidcClient()
        let launcher = HttpRelayLauncher()

        let user = try await oidc.signIn(provider: provider, relayTo: relayTo, launcher: launcher)
        XCTAssertFalse(user.userId.isEmpty, "signInRelay returned a user")

        let currentUser = try await api.oidcRequireAuth()
        XCTAssertFalse(currentUser.userId.isEmpty)
        XCTAssertEqual(currentUser.userId, user.userId)
        XCTAssertEqual(currentUser.provider, provider)
    }

    func testSignOut() async throws {
        let oidc = try getOidcClient()
        let launcher = HttpRelayLauncher()

        _ = try await oidc.signIn(provider: provider, relayTo: relayTo, launcher: launcher)

        let result = try await api.oidcSignOut()
        XCTAssertTrue(result.success)

        let authed = try await api.oidcCheckAuth()
        XCTAssertFalse(authed)
    }
}
