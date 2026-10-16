//
// Copyright Amazon.com Inc. or its affiliates.
// All Rights Reserved.
//
// SPDX-License-Identifier: Apache-2.0
//

import XCTest
import Foundation
@testable import BlocksRuntime

/// Canonical `Auth` error names (the `name` the server puts on a JSON-RPC error), from the
/// mapping table in `packages/auth-common/src/errors.ts` (`AuthErrors`).
enum AuthErrorNames {
    static let notAuthenticated = "NotAuthenticatedException"
    static let notAuthorized = "NotAuthorizedException"
    static let userAlreadyExists = "UsernameExistsException"
    static let userNotConfirmed = "UserNotConfirmedException"
    static let invalidPassword = "InvalidPasswordException"
    static let codeMismatch = "CodeMismatchException"
}

/// Base class for E2E tests against test-apps/native-bindings.
/// Reads BLOCKS_URL from the environment (defaults to localhost dev server).
/// Uses the generated typed `Api` client.
class BlocksE2ETestCase: XCTestCase {
    static let blocksUrl: String = ProcessInfo.processInfo.environment["BLOCKS_URL"]
        .flatMap { $0.isEmpty ? nil : $0 }
        ?? "http://localhost:3001/aws-blocks/api"

    static let server: BlocksServer = .init(name: "e2e", url: blocksUrl)

    /// A password that satisfies `Auth`'s default policy (≥ 8, upper, lower, digit, symbol).
    static let password = "Passw0rd!"

    /// Why a test that needs an emailed verification code does not run against a deployed backend.
    static let needsLocalCode =
        "needs the emailed verification code, which only the local dev server hands back (Cognito emails it)"

    /// True when the suite targets the local native-bindings dev server rather than a deployed
    /// backend. Locally, `Auth` hands every verification code to the backend
    /// (`basicGetLastCode`); deployed, Cognito emails it, so flows that need it run only locally.
    static var isLocalEndpoint: Bool {
        let host = URL(string: blocksUrl)?.host ?? ""
        return ["localhost", "127.0.0.1", "0.0.0.0", "::1"].contains(host)
    }

    var api: Api!

    override func setUp() {
        super.setUp()
        BlocksClient.clearCookies()
        api = Api(server: Self.server)
    }

    /// A username no other test (or earlier run) has used.
    func uniqueUsername(_ label: String) -> String {
        "\(label)_swift_\(Int(Date().timeIntervalSince1970))_\(Int.random(in: 1_000 ... 9_999))"
    }

    /// The pre-provisioned, confirmed user a deployed backend signs in instead of signing up
    /// (seeded by `test-apps/native-bindings/aws-blocks/scripts/seed-cognito-user.ts`).
    func returningUser() -> (username: String, password: String) {
        let env = ProcessInfo.processInfo.environment
        let username = env["COGNITO_TEST_USERNAME"].flatMap { $0.isEmpty ? nil : $0 } ?? "e2e-returning-user"
        let password = env["COGNITO_TEST_PASSWORD"].flatMap { $0.isEmpty ? nil : $0 } ?? "Returning1Pass!"
        return (username, password)
    }

    /// Sign up `username` on the email + password block, read the emailed code back from the
    /// local dev server and confirm it. Auto sign-in leaves the user signed in.
    @discardableResult
    func signUpAndConfirm(_ username: String) async throws -> NativeSignInResult {
        _ = try await api.basicSignUp(username: username, password: Self.password, email: "\(username)@example.com")
        let code = try await api.basicGetLastCode(username: username)
        let delivered = try XCTUnwrap(code, "No verification code was delivered to \(username)")
        return try await api.basicConfirmSignUp(username: username, code: delivered.code)
    }

    /// Leave a user signed in on the email + password block: a fresh, confirmed user on the
    /// local dev server, the pre-provisioned `returningUser()` on a deployed backend.
    @discardableResult
    func signInTestUser(_ label: String) async throws -> (username: String, password: String) {
        if Self.isLocalEndpoint {
            let username = uniqueUsername(label)
            let result = try await signUpAndConfirm(username)
            XCTAssertEqual(result.status, .signedIn, "auto sign-in after confirmSignUp")
            return (username, Self.password)
        }
        let user = returningUser()
        let result = try await api.basicSignIn(username: user.username, password: user.password)
        XCTAssertEqual(result.status, .signedIn)
        return user
    }

    /// Assert that `body` throws an `RPCError` whose server error name is `name`.
    func assertThrowsBlocksError(
        _ name: String,
        file: StaticString = #filePath,
        line: UInt = #line,
        _ body: () async throws -> Void
    ) async {
        do {
            try await body()
            XCTFail("Expected \(name), but no error was thrown", file: file, line: line)
        } catch let error as RPCError {
            XCTAssertEqual(error.name, name, "error: \(error.message)", file: file, line: line)
        } catch {
            XCTFail("Expected RPCError \(name), got \(error)", file: file, line: line)
        }
    }
}
