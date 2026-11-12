//
// Copyright Amazon.com Inc. or its affiliates.
// All Rights Reserved.
//
// SPDX-License-Identifier: Apache-2.0
//

import XCTest
import Foundation
@testable import BlocksRuntime

/// `OIDCClient.forAuth` against two federated `Auth` blocks: `auth-oidc` on the default routes,
/// signing in with its second provider (`github2`), and `auth-sso`, whose routes live under
/// `/aws-blocks/auth/sso/` (its own `callbackPath` and `signOutPath`), signing in with `corp`.
/// For each: sign in, an authenticated RPC, `restore()` on a fresh `Blocks`, `signOut()` returning
/// the stub IdP's logout URL, and `restore()` returning nil afterwards.
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

    private func oidcClient(on blocks: Blocks) -> OIDCClient<String> {
        OIDCClient.forAuth(client: blocks.client, providers: ["google", "github2"], relayTo: relayTo)
    }

    private func ssoClient(on blocks: Blocks) -> OIDCClient<String> {
        OIDCClient.forAuth(
            client: blocks.client,
            providers: ["corp"],
            relayTo: relayTo,
            callbackPath: "/aws-blocks/auth/sso/callback",
            signOutPath: "/aws-blocks/auth/sso/signout"
        )
    }

    func testSecondProviderSignInRestoreAndSignOut() async throws {
        try skipWithoutHeadlessIdp()
        let user = try await oidcClient(on: blocks).signIn(provider: "github2", launcher: HttpRelayLauncher())
        XCTAssertEqual(user.signInProvider, "github2")
        let me = try await api.oidcRequireAuth()
        XCTAssertEqual(me.userId, user.userId)
        XCTAssertEqual(me.provider, "github2")

        try await assertRestoreThenSignOut(userId: user.userId, provider: "github2", client: oidcClient)
    }

    func testBlockOnItsOwnRoutesSignInRestoreAndSignOut() async throws {
        try skipWithoutHeadlessIdp()
        let user = try await ssoClient(on: blocks).signIn(provider: "corp", launcher: HttpRelayLauncher())
        XCTAssertEqual(user.signInProvider, "corp")
        let me = try await api.ssoRequireAuth()
        XCTAssertEqual(me.userId, user.userId)
        XCTAssertEqual(me.provider, "corp")

        try await assertRestoreThenSignOut(userId: user.userId, provider: "corp", client: ssoClient)
    }

    /// On `blocks`' one cookie store: `auth-sso` refuses an `auth-oidc` session, and signing out of
    /// `auth-sso` leaves `auth-oidc` signed in.
    func testBlocksKeepSeparateSessions() async throws {
        try skipWithoutHeadlessIdp()
        let oidc = oidcClient(on: blocks)
        let sso = ssoClient(on: blocks)

        _ = try await oidc.signIn(provider: "github2", launcher: HttpRelayLauncher())
        await assertThrowsBlocksError(AuthErrorNames.notAuthenticated) {
            _ = try await self.api.ssoRequireAuth()
        }
        let ssoUser = try await api.ssoGetCurrentUser()
        XCTAssertNil(ssoUser)

        _ = try await sso.signIn(provider: "corp", launcher: HttpRelayLauncher())
        _ = try await sso.signOut()
        let ssoAfter = try await sso.restore()
        XCTAssertNil(ssoAfter)
        let oidcAfter = try await api.oidcRequireAuth()
        XCTAssertEqual(oidcAfter.provider, "github2", "auth-oidc is still signed in")
        _ = try await oidc.signOut()
    }

    /// A relaunch: a fresh `Blocks` shares the Keychain cookie store, so `restore()` finds the
    /// session; signing out returns the stub IdP's logout URL and ends it.
    private func assertRestoreThenSignOut(
        userId: String,
        provider: String,
        client: (Blocks) -> OIDCClient<String>
    ) async throws {
        let relaunched = Blocks(server: Self.server)
        defer { relaunched.close() }
        let restoredClient = client(relaunched)

        let restored = try await restoredClient.restore()
        XCTAssertEqual(restored?.userId, userId)

        let logoutURL = try await restoredClient.signOut()
        XCTAssertEqual(logoutURL?.path, "/aws-blocks/auth/idp/\(provider)/logout")

        let afterSignOut = try await restoredClient.restore()
        XCTAssertNil(afterSignOut)
    }
}
