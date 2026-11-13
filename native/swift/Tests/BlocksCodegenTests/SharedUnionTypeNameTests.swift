//
// Copyright Amazon.com Inc. or its affiliates.
// All Rights Reserved.
//
// SPDX-License-Identifier: Apache-2.0
//

import XCTest
@testable import BlocksCodegen

/// A union parameter the spec names (`x-blocks-type-name`, the Auth block's `AuthActionInput`) is declared once at
/// the top level of Models.swift, with its variants nested inside it, and every namespace that takes it shares it.
/// Before, each namespace declared its own identical `SetAuthState.Input`, so one sign-in screen couldn't serve two
/// Auth blocks. Each operation's enum keeps the old names as deprecated typealiases.
final class SharedUnionTypeNameTests: XCTestCase {

    private func generate(
        _ methods: [String], schemas: String = "{}"
    ) throws -> GeneratedSources {
        let json = """
        {
            "openrpc": "1.3.2",
            "info": { "title": "test", "version": "1.0.0" },
            "methods": [\(methods.joined(separator: ", "))],
            "components": { "schemas": \(schemas) }
        }
        """
        return try generate(spec: Data(json.utf8))
    }

    private func generate(spec: Data) throws -> GeneratedSources {
        let rpcModel = try OpenRPCParser().parse(data: spec)
        return try SwiftCodeGenerator().generate(from: CodegenModelBuilder().build(from: rpcModel))
    }

    private func arm(_ action: String, _ fields: [String] = []) -> String {
        let props = ([#""action": { "type": "string", "enum": ["\#(action)"] }"#]
            + fields.map { #""\#($0)": { "type": "string" }"# }).joined(separator: ", ")
        let required = (["action"] + fields).map { "\"\($0)\"" }.joined(separator: ", ")
        return #"{ "type": "object", "properties": { \#(props) }, "required": [\#(required)] }"#
    }

    private func setAuthState(_ namespace: String, typeName: String? = "AuthActionInput", arms: [String]? = nil) -> String {
        let hint = typeName.map { #", "x-blocks-type-name": "\#($0)""# } ?? ""
        let oneOf = (arms ?? [arm("signIn", ["username", "password"]), arm("signOut")]).joined(separator: ", ")
        return """
        { "name": "\(namespace).setAuthState",
          "params": [{ "name": "input", "required": true, "schema": { "oneOf": [\(oneOf)]\(hint) } }],
          "result": { "name": "R", "schema": { "type": "string" } } }
        """
    }

    private func assertContains(_ haystack: String, _ needle: String, file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertTrue(haystack.contains(needle), "Expected generated code to contain:\n\(needle)\n--- got ---\n\(haystack)", file: file, line: line)
    }

    private func assertNotContains(_ haystack: String, _ needle: String, file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertFalse(haystack.contains(needle), "Expected generated code not to contain:\n\(needle)", file: file, line: line)
    }

    private func count(_ needle: String, in haystack: String) -> Int {
        haystack.components(separatedBy: needle).count - 1
    }

    func testTwoNamespacesShareOneTopLevelType() throws {
        let output = try generate([setAuthState("alphaAuth"), setAuthState("zetaAuth")])

        XCTAssertEqual(count("public nonisolated enum AuthActionInput: Codable, Sendable {", in: output.models), 1)
        assertContains(output.models, "    public struct SignIn: Codable, Sendable {\n")
        XCTAssertEqual(count("public func setAuthState(input: AuthActionInput) async throws -> String {", in: output.api), 2)
        assertNotContains(output.api, "public enum Input")
        assertNotContains(output.api, "public struct SignIn")
    }

    func testEachOperationKeepsItsOldNamesAsDeprecatedAliases() throws {
        let output = try generate([setAuthState("alphaAuth"), setAuthState("zetaAuth")])

        XCTAssertEqual(count("""
            public enum SetAuthState {

                @available(*, deprecated, renamed: "AuthActionInput")
                public typealias Input = AuthActionInput

                @available(*, deprecated, renamed: "AuthActionInput.SignIn")
                public typealias SignIn = AuthActionInput.SignIn
            }
        """, in: output.api), 2)
    }

    func testAnUnhintedUnionKeepsItsNestedInput() throws {
        let output = try generate([setAuthState("alphaAuth", typeName: nil)])

        assertContains(output.api, "public func setAuthState(input: SetAuthState.Input) async throws -> String {")
        assertContains(output.api, "        public enum Input: Codable, Sendable {")
        assertNotContains(output.models + output.api, "AuthActionInput")
    }

    func testANameAComponentSchemaHasKeepsTheNestedInput() throws {
        let getter = ##"""
        { "name": "alphaAuth.get", "params": [],
          "result": { "name": "R", "schema": { "$ref": "#/components/schemas/AuthActionInput" } } }
        """##
        let output = try generate(
            [setAuthState("alphaAuth"), getter],
            schemas: #"{ "AuthActionInput": { "type": "object", "properties": { "x": { "type": "string" } }, "required": ["x"] } }"#
        )

        assertContains(output.api, "public func setAuthState(input: SetAuthState.Input) async throws -> String {")
        assertContains(output.models, "public nonisolated struct AuthActionInput: Codable, Sendable {")
    }

    func testADifferentShapeUnderTheSameNameKeepsItsNestedInput() throws {
        let other = [arm("signIn", ["username"])]
        let output = try generate([setAuthState("alphaAuth"), setAuthState("zetaAuth", arms: other)])

        XCTAssertEqual(count("public func setAuthState(input: AuthActionInput) async throws -> String {", in: output.api), 1)
        XCTAssertEqual(count("public func setAuthState(input: SetAuthState.Input) async throws -> String {", in: output.api), 1)
    }

    func testAReservedNameKeepsTheNestedInput() throws {
        let output = try generate([setAuthState("alphaAuth", typeName: "Result")])

        assertContains(output.api, "public func setAuthState(input: SetAuthState.Input) async throws -> String {")
    }

    // MARK: - Compiling against the generated module

    /// App code written against the names swift 0.1.1 and the per-namespace `Input` generated: each namespace's
    /// nested names still compile, and one value serves both Auth blocks.
    func testOldNestedNamesStillCompileAndOneValueServesBothBlocks() throws {
        #if os(macOS)
        let arms = [arm("signIn", ["username", "password"]), arm("confirmSignIn", ["challengeResponse"]), arm("signOut")]
        let output = try generate([setAuthState("alphaAuthApi", arms: arms), setAuthState("zetaAuthApi", arms: arms)])
        try typecheckConsumer(models: output.models, api: output.api, consumer: """
        import Generated

        let old: AlphaAuthApi.SetAuthState.Input = .signIn(AlphaAuthApi.SetAuthState.SignIn(password: "p", username: "u"))
        let otherOld: ZetaAuthApi.SetAuthState.Input = old
        let shared: AuthActionInput = otherOld
        let challenge: ZetaAuthApi.SetAuthState.ConfirmSignIn? = nil

        func submit(_ input: AuthActionInput, alpha: AlphaAuthApi, zeta: ZetaAuthApi) async throws {
            _ = try await alpha.setAuthState(input: input)
            _ = try await zeta.setAuthState(input: input)
        }
        """)
        #else
        throw XCTSkip("Compiling the generated module needs the host toolchain (macOS only).")
        #endif
    }
}
