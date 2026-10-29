//
// Copyright Amazon.com Inc. or its affiliates.
// All Rights Reserved.
//
// SPDX-License-Identifier: Apache-2.0
//

import XCTest
@testable import BlocksRuntime

/// Sign-up attributes through the `Auth` block's state machine (`createApi()`), as the
/// Authenticator sends them. The `signUp` action is an open record: `username` and `password`
/// are its properties, and every other key is a user attribute, flat beside them on the wire
/// (`{"action":"signUp","username":…,"password":…,"email":…,"name":…}`). The server reads them
/// with a rest spread, so an attribute only reaches the user when it is sent flat.
final class AuthSignUpAttributesE2ETests: BlocksE2ETestCase {

    func testSignUpAttributesReachTheUser() async throws {
        try XCTSkipUnless(Self.isLocalEndpoint, Self.needsLocalCode)
        let authApi = AuthCognitoApi(server: Self.server)
        let username = uniqueUsername("attrs")
        let email = "\(username)@example.com"

        let state = try await authApi.setAuthState(input: .signUp(AuthCognitoApi.SetAuthState.SignUp(
            password: Self.password, username: username,
            attributes: ["email": email, "name": "Ada Lovelace"]
        )))
        XCTAssertEqual(state.state, .confirmingSignUp)

        let code = try await api.cognitoGetLastCode(username: username)
        let delivered = try XCTUnwrap(code, "No verification code was delivered to \(username)")
        let confirmed = try await api.cognitoConfirmSignUp(username: username, code: delivered.code)
        XCTAssertTrue(confirmed.success)
        _ = try await api.cognitoSignIn(username: username, password: Self.password)

        let attributes = try await api.cognitoGetUserAttributes()
        XCTAssertEqual(attributes["email"], email)
        XCTAssertEqual(attributes["name"], "Ada Lovelace")
        XCTAssertNil(attributes["attributes"], "the attributes were sent nested under an `attributes` key")
        _ = try await api.cognitoSignOut(options: nil)
    }

    func testSignUpAttributesRoundTripFlat() throws {
        let signUp = AuthCognitoApi.SetAuthState.Input.signUp(AuthCognitoApi.SetAuthState.SignUp(
            password: Self.password, username: "ada",
            attributes: ["email": "ada@example.com", "custom:team": "engines"]
        ))
        let wire = try JSONSerialization.jsonObject(with: JSONEncoder().encode(signUp)) as? NSDictionary
        let expected: NSDictionary = [
            "action": "signUp", "username": "ada", "password": Self.password,
            "email": "ada@example.com", "custom:team": "engines"
        ]
        XCTAssertEqual(wire, expected)

        let decoded = try JSONDecoder().decode(
            AuthCognitoApi.SetAuthState.Input.self, from: JSONSerialization.data(withJSONObject: expected)
        )
        guard case .signUp(let value) = decoded else {
            return XCTFail("Expected the signUp action, got \(decoded)")
        }
        XCTAssertEqual(value.username, "ada")
        XCTAssertEqual(value.password, Self.password)
        XCTAssertEqual(value.attributes, ["email": "ada@example.com", "custom:team": "engines"])
    }
}
