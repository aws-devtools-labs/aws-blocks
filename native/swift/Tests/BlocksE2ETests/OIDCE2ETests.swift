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

/// OIDC server-relay E2E tests. Only runs against a deployed sandbox (HTTPS)
/// because the stub IdP rejects http:// redirect URIs.
///
/// Gated by the RUN_OIDC=1 environment variable — skipped otherwise.
final class OIDCE2ETests: BlocksE2ETestCase {

    private let provider = "google"
    private let relayTo = "nativebindings://auth"

    override func invokeTest() {
        guard ProcessInfo.processInfo.environment["RUN_OIDC"] == "1" else {
            return
        }
        super.invokeTest()
    }

    private func getOidcClient() async throws -> OIDCClient {
        let oidcAuthApi = OidcAuthApi(server: Self.server)
        return try await oidcAuthApi.getClient()
    }

    func testSignInRelayAndAuthenticatedRPC() async throws {
        let oidc = try await getOidcClient()
        let launcher = HttpRelayLauncher()

        let user = try await oidc.signIn(provider: provider, relayTo: relayTo, launcher: launcher)
        XCTAssertFalse(user.userId.isEmpty, "signInRelay returned a user")

        let me = try await api.oidcRequireAuth()
        XCTAssertFalse(me.userId.isEmpty)
        XCTAssertEqual(me.userId, user.userId)
    }

    func testSignOut() async throws {
        let oidc = try await getOidcClient()
        let launcher = HttpRelayLauncher()

        _ = try await oidc.signIn(provider: provider, relayTo: relayTo, launcher: launcher)

        let result = try await api.oidcSignOut()
        XCTAssertTrue(result.success)

        let authed = try await api.oidcCheckAuth()
        XCTAssertFalse(authed)
    }
}
