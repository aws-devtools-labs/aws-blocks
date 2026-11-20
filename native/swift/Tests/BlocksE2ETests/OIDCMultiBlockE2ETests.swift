//
// Copyright Amazon.com Inc. or its affiliates.
// All Rights Reserved.
//
// SPDX-License-Identifier: Apache-2.0
//

import XCTest
import Foundation
@testable import BlocksRuntime

/// An `HttpRelayLauncher` that also records the authorize URL each sign-in opens.
final class RecordingRelayLauncher: BrowserLauncher, @unchecked Sendable {
    private let inner = HttpRelayLauncher()
    private(set) var authorizeURLs: [URL] = []

    func launch(authorizeURL: URL, callbackScheme: String) async throws -> URL {
        authorizeURLs.append(authorizeURL)
        return try await inner.launch(authorizeURL: authorizeURL, callbackScheme: callbackScheme)
    }
}

/// Two federated `Auth` blocks, each signed in through the client its `getClient()` returns:
/// `auth-oidc` on the default routes, signing in with its second provider (`github2`), and
/// `auth-sso`, whose routes live under `/cdk-blocks/auth/sso/` with the callback named `return`.
/// For each: sign in, an authenticated RPC, the state machine, `restore()` on a fresh `Blocks`,
/// the client's own `signOut()` returning the stub IdP's logout URL, and `restore()` returning nil
/// afterwards. Then, on one cookie store: a block refuses another block's session, and signing out
/// of either block leaves the other signed in.
///
/// Same headless-IdP rule as `OIDCE2ETests`: the local dev server, or a deployed backend with
/// `RUN_OIDC=1`.
final class OIDCMultiBlockE2ETests: BlocksE2ETestCase {

    private let relayTo = "nativebindings://auth"

    private func skipWithoutHeadlessIdp() throws {
        try XCTSkipUnless(
            Self.isLocalEndpoint || ProcessInfo.processInfo.environment["RUN_OIDC"] == "1",
            "Auth's stub IdP runs only locally and on sandbox deployments. Against a deployed backend "
                + "these tests need RUN_OIDC=1 (see OIDCE2ETests)."
        )
    }

    func testSecondProviderSignInRestoreAndSignOut() async throws {
        try skipWithoutHeadlessIdp()
        let oidc = try await blocks.oidcAuthApi.getClient()
        let user = try await oidc.signIn(provider: .github2, relayTo: relayTo, launcher: HttpRelayLauncher())
        XCTAssertEqual(user.signInProvider, "github2")
        let me = try await api.oidcRequireAuth()
        XCTAssertEqual(me.userId, user.userId)
        XCTAssertEqual(me.provider, "github2")
        let signedIn = try await blocks.oidcAuthStateApi.getAuthState()
        XCTAssertEqual(signedIn.state, .signedIn)

        let relaunched = Blocks(server: Self.server)
        defer { relaunched.close() }
        try await assertRestoreThenSignOut(userId: user.userId, provider: "github2", client: relaunched.oidcAuthApi.getClient())
        let signedOut = try await blocks.oidcAuthStateApi.getAuthState()
        XCTAssertEqual(signedOut.state, .signedOut)
    }

    func testBlockOnItsOwnRoutesSignInRestoreAndSignOut() async throws {
        try skipWithoutHeadlessIdp()
        let sso = try await blocks.ssoOidcApi.getClient()
        let launcher = RecordingRelayLauncher()
        let user = try await sso.signIn(provider: .corp, relayTo: relayTo, launcher: launcher)

        // The IdP was sent the block's own callback, from the descriptor, not the default name.
        let authorizeURL = try XCTUnwrap(launcher.authorizeURLs.first)
        let redirectURI = try XCTUnwrap(
            URLComponents(url: authorizeURL, resolvingAgainstBaseURL: false)?
                .queryItems?.first { $0.name == "redirect_uri" }?.value
        )
        // A deployed gateway puts its stage in front of /cdk-blocks, so check the suffix.
        let redirectPath = try XCTUnwrap(URL(string: redirectURI)?.path)
        XCTAssertTrue(redirectPath.hasSuffix("/cdk-blocks/auth/sso/return"), redirectPath)
        XCTAssertEqual(user.signInProvider, "corp")
        let me = try await api.ssoRequireAuth()
        XCTAssertEqual(me.userId, user.userId)
        XCTAssertEqual(me.provider, "corp")
        let signedIn = try await blocks.ssoAuthStateApi.getAuthState()
        XCTAssertEqual(signedIn.state, .signedIn)

        let relaunched = Blocks(server: Self.server)
        defer { relaunched.close() }
        try await assertRestoreThenSignOut(userId: user.userId, provider: "corp", client: relaunched.ssoOidcApi.getClient())
        let afterSignOut = try await api.ssoGetCurrentUser()
        XCTAssertNil(afterSignOut)
        let signedOut = try await blocks.ssoAuthStateApi.getAuthState()
        XCTAssertEqual(signedOut.state, .signedOut)
    }

    /// On `blocks`' one cookie store: `auth-sso` refuses an `auth-oidc` session, and signing out of
    /// either block leaves the other signed in.
    func testBlocksKeepSeparateSessions() async throws {
        try skipWithoutHeadlessIdp()
        // Start from no session in the shared Keychain cookie store, whatever ran before, so a
        // leftover auth-sso session can't make the refusal check below pass or fail by accident.
        BlocksClient.clearCookies()
        let oidc = try await blocks.oidcAuthApi.getClient()
        let sso = try await blocks.ssoOidcApi.getClient()

        _ = try await oidc.signIn(provider: .github2, relayTo: relayTo, launcher: HttpRelayLauncher())
        let oidcSignedIn = try await api.oidcRequireAuth()
        XCTAssertEqual(oidcSignedIn.provider, "github2")
        await assertThrowsBlocksError(AuthErrorNames.notAuthenticated) {
            _ = try await self.api.ssoRequireAuth()
        }
        let ssoUser = try await api.ssoGetCurrentUser()
        XCTAssertNil(ssoUser)
        let ssoState = try await blocks.ssoAuthStateApi.getAuthState()
        XCTAssertEqual(ssoState.state, .signedOut)

        _ = try await sso.signIn(provider: .corp, relayTo: relayTo, launcher: HttpRelayLauncher())
        _ = try await sso.signOut()
        let ssoAfter = try await sso.restore()
        XCTAssertNil(ssoAfter)
        let oidcAfter = try await api.oidcRequireAuth()
        XCTAssertEqual(oidcAfter.provider, "github2", "auth-oidc is still signed in")
        let oidcClientState = await oidc.authState
        if case .signedIn = oidcClientState {} else { XCTFail("auth-oidc's client still reports signed in (got \(oidcClientState))") }

        // The other direction: signing out of auth-oidc leaves auth-sso signed in.
        _ = try await sso.signIn(provider: .corp, relayTo: relayTo, launcher: HttpRelayLauncher())
        _ = try await oidc.signOut()
        let oidcRestored = try await oidc.restore()
        XCTAssertNil(oidcRestored)
        let ssoStill = try await api.ssoRequireAuth()
        XCTAssertEqual(ssoStill.provider, "corp", "auth-sso is still signed in")
        let ssoClientState = await sso.authState
        if case .signedIn = ssoClientState {} else { XCTFail("auth-sso's client still reports signed in (got \(ssoClientState))") }
        _ = try await sso.signOut()
    }

    /// A relaunch: a fresh `Blocks` shares the Keychain cookie store, so `restore()` finds the
    /// session; the client's own `signOut()` (not an RPC) returns the stub IdP's logout URL and
    /// ends it.
    private func assertRestoreThenSignOut<P>(userId: String, provider: String, client: OIDCClient<P>) async throws {
        let restored = try await client.restore()
        XCTAssertEqual(restored?.userId, userId)

        let logoutURL = try await client.signOut()
        let logoutPath = try XCTUnwrap(logoutURL?.path)
        XCTAssertTrue(logoutPath.hasSuffix("/cdk-blocks/auth/idp/\(provider)/logout"), logoutPath)
        let state = await client.authState
        XCTAssertEqual(state, .signedOut)

        let afterSignOut = try await client.restore()
        XCTAssertNil(afterSignOut)
    }
}
