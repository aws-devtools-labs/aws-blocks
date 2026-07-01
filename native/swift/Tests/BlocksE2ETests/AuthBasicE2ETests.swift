//
// Copyright Amazon.com Inc. or its affiliates.
// All Rights Reserved.
//
// SPDX-License-Identifier: Apache-2.0
//

import XCTest
@testable import BlocksRuntime

final class AuthBasicE2ETests: BlocksE2ETestCase {

    private let password = "pass1234"

    private func uniqueUsername(_ label: String) -> String {
        "basic\(label)_swift_\(Int(Date().timeIntervalSince1970))_\(Int.random(in: 1_000 ... 9_999))"
    }

    func testSignUpAndSignIn() async throws {
        let username = uniqueUsername("user")

        let signUpResult = try await api.basicSignUp(username: username, password: password)
        XCTAssertTrue(signUpResult.success)

        let user = try await api.basicSignIn(username: username, password: password)
        XCTAssertEqual(user.username, username)
        XCTAssertFalse(user.userId.isEmpty)
    }

    func testCheckAuthWhenSignedIn() async throws {

        let username = uniqueUsername("check")

        _ = try await api.basicSignUp(username: username, password: password)
        _ = try await api.basicSignIn(username: username, password: password)

        let authed = try await api.basicCheckAuth()
        XCTAssertTrue(authed)
    }

    func testRequireAuthWhenSignedIn() async throws {

        let username = uniqueUsername("req")

        _ = try await api.basicSignUp(username: username, password: password)
        _ = try await api.basicSignIn(username: username, password: password)

        let user = try await api.basicRequireAuth()
        XCTAssertEqual(user.username, username)
    }

    func testSignOut() async throws {

        let username = uniqueUsername("out")

        _ = try await api.basicSignUp(username: username, password: password)
        _ = try await api.basicSignIn(username: username, password: password)
        _ = try await api.basicSignOut()

        let authed = try await api.basicCheckAuth()
        XCTAssertFalse(authed)
    }

    func testRequireAuthWhenSignedOutThrows() async throws {
        let freshApi = Api(server: Self.server)
        do {
            _ = try await freshApi.basicRequireAuth()
            XCTFail("Expected error for unauthenticated request")
        } catch {
            // Expected
        }
    }

    func testWrongPasswordThrows() async throws {
        let username = uniqueUsername("wrong")
        _ = try await api.basicSignUp(username: username, password: password)
        do {
            _ = try await api.basicSignIn(username: username, password: "wrongpass")
            XCTFail("Expected error for wrong password")
        } catch {
            // Expected
        }
    }
}
