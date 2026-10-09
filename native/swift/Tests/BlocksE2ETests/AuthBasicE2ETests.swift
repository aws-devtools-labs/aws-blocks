//
// Copyright Amazon.com Inc. or its affiliates.
// All Rights Reserved.
//
// SPDX-License-Identifier: Apache-2.0
//

import XCTest
@testable import BlocksRuntime

/// The email + password `Auth` block (`auth-basic`): sign-up confirms the email address with a
/// code, then auto sign-in signs the user in. Errors are asserted by their canonical `name`.
final class AuthBasicE2ETests: BlocksE2ETestCase {

    func testSignUpSendsCodeAndConfirmSignsIn() async throws {
        try XCTSkipUnless(Self.isLocalEndpoint, Self.needsLocalCode)
        let username = uniqueUsername("basic")

        let signUp = try await api.basicSignUp(username: username, password: Self.password, email: "\(username)@example.com")
        XCTAssertFalse(signUp.isSignUpComplete)

        let code = try await api.basicGetLastCode(username: username)
        let delivered = try XCTUnwrap(code)
        XCTAssertEqual(delivered.purpose, .signUp)

        let confirmed = try await api.basicConfirmSignUp(username: username, code: delivered.code)
        XCTAssertEqual(confirmed.status, .signedIn)
        XCTAssertEqual(confirmed.user?.username, username)
        let authed = try await api.basicCheckAuth()
        XCTAssertTrue(authed)
    }

    func testSignUpAndSignIn() async throws {
        let user = try await signInTestUser("user")
        _ = try await api.basicSignOut()

        let result = try await api.basicSignIn(username: user.username, password: user.password)
        XCTAssertEqual(result.status, .signedIn)
        let signedIn = try XCTUnwrap(result.user)
        XCTAssertEqual(signedIn.username, user.username)
        XCTAssertFalse(signedIn.userId.isEmpty)
        XCTAssertFalse(signedIn.userSub.isEmpty)
    }

    func testCheckAuthWhenSignedIn() async throws {
        try await signInTestUser("check")

        let authed = try await api.basicCheckAuth()
        XCTAssertTrue(authed)
    }

    func testRequireAuthWhenSignedIn() async throws {
        let user = try await signInTestUser("req")

        let current = try await api.basicRequireAuth()
        XCTAssertEqual(current.username, user.username)
    }

    func testGetCurrentUserWhenSignedIn() async throws {
        let user = try await signInTestUser("current")

        let current = try await api.basicGetCurrentUser()
        XCTAssertEqual(current?.username, user.username)
    }

    func testSignOut() async throws {
        try await signInTestUser("out")
        let result = try await api.basicSignOut()
        XCTAssertTrue(result.success)

        let authed = try await api.basicCheckAuth()
        XCTAssertFalse(authed)
        let current = try await api.basicGetCurrentUser()
        XCTAssertNil(current)
    }

    func testRequireAuthWhenSignedOutThrowsNotAuthenticated() async throws {
        let freshApi = Api(server: Self.server)
        await assertThrowsBlocksError(AuthErrorNames.notAuthenticated) {
            _ = try await freshApi.basicRequireAuth()
        }
    }

    func testWrongPasswordThrowsNotAuthorized() async throws {
        let user = try await signInTestUser("wrong")
        await assertThrowsBlocksError(AuthErrorNames.notAuthorized) {
            _ = try await self.api.basicSignIn(username: user.username, password: "Wrong5678!")
        }
    }

    func testWeakPasswordThrowsInvalidPassword() async throws {
        let username = uniqueUsername("weak")
        await assertThrowsBlocksError(AuthErrorNames.invalidPassword) {
            _ = try await self.api.basicSignUp(username: username, password: "pass1234", email: "\(username)@example.com")
        }
    }

    func testDuplicateSignUpThrowsUsernameExists() async throws {
        let user = try await signInTestUser("dup")
        await assertThrowsBlocksError(AuthErrorNames.userAlreadyExists) {
            _ = try await self.api.basicSignUp(
                username: user.username,
                password: Self.password,
                email: "\(user.username)@example.com"
            )
        }
    }

    func testSignInBeforeConfirmingThrowsUserNotConfirmed() async throws {
        try XCTSkipUnless(
            Self.isLocalEndpoint,
            "leaves an unconfirmed user in the deployed pool, which Cognito emails a code for"
        )
        let username = uniqueUsername("unconfirmed")
        _ = try await api.basicSignUp(username: username, password: Self.password, email: "\(username)@example.com")

        await assertThrowsBlocksError(AuthErrorNames.userNotConfirmed) {
            _ = try await self.api.basicSignIn(username: username, password: Self.password)
        }
    }

    func testWrongCodeThrowsCodeMismatch() async throws {
        try XCTSkipUnless(Self.isLocalEndpoint, Self.needsLocalCode)
        let username = uniqueUsername("badcode")
        _ = try await api.basicSignUp(username: username, password: Self.password, email: "\(username)@example.com")
        let delivered = try await api.basicGetLastCode(username: username)
        let code = try XCTUnwrap(delivered).code
        let wrong = code == "000000" ? "111111" : "000000"

        await assertThrowsBlocksError(AuthErrorNames.codeMismatch) {
            _ = try await self.api.basicConfirmSignUp(username: username, code: wrong)
        }
    }
}

/// The Cognito-style `Auth` block's `updateUserAttributes` result is keyed by attribute, each value
/// discriminated by the boolean `isUpdated`. The server sends JSON `true` / `false`; the generated client
/// decoded the discriminator as a string, so every call threw (FX35).
final class AuthCognitoAttributesE2ETests: BlocksE2ETestCase {

    func testUpdateUserAttributesDecodesTheBooleanDiscriminator() async throws {
        try XCTSkipUnless(Self.isLocalEndpoint, Self.needsLocalCode)
        let username = uniqueUsername("attrs")
        _ = try await api.cognitoSignUp(username: username, password: Self.password, email: "\(username)@example.com")
        let delivered = try await api.cognitoGetLastCode(username: username)
        _ = try await api.cognitoConfirmSignUp(username: username, code: try XCTUnwrap(delivered).code)
        let signIn = try await api.cognitoSignIn(username: username, password: Self.password)
        guard case .signedIn = signIn else { return XCTFail("Expected signedIn, got \(signIn)") }

        let result = try await api.cognitoUpdateUserAttributes(
            attributes: ["given_name": "Ada", "email": "\(username)+new@example.com"]
        )

        guard case .isUpdatedTrue?? = result["given_name"] else {
            return XCTFail("Expected given_name to be updated, got \(String(describing: result["given_name"]))")
        }
        guard case .isUpdatedFalse(let pending)?? = result["email"] else {
            return XCTFail("Expected email to wait for a code, got \(String(describing: result["email"]))")
        }
        XCTAssertEqual(pending.nextStep.name, .confirmAttributeWithCode)
    }
}
