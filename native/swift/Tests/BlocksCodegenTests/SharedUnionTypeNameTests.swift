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

                @available(*, deprecated, message: "Use AuthActionInput")
                public typealias Input = AuthActionInput

                @available(*, deprecated, message: "Use AuthActionInput.SignIn")
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
        XCTAssertEqual(output.warnings, [
            "swift: parameter 'input' of alphaAuth.setAuthState keeps its own nested type, not AuthActionInput: another type has that name."
        ])
    }

    func testADifferentShapeUnderTheSameNameKeepsItsNestedInput() throws {
        let other = [arm("signIn", ["username"])]
        let output = try generate([setAuthState("alphaAuth"), setAuthState("zetaAuth", arms: other)])

        XCTAssertEqual(count("public func setAuthState(input: AuthActionInput) async throws -> String {", in: output.api), 1)
        XCTAssertEqual(count("public func setAuthState(input: SetAuthState.Input) async throws -> String {", in: output.api), 1)
        // The smallest `<method>#param:<name>` key keeps the name, so the other is reported.
        XCTAssertEqual(output.warnings, [
            "swift: parameter 'input' of zetaAuth.setAuthState keeps its own nested type, not AuthActionInput:"
                + " a parameter of another shape has that name."
        ])
    }

    func testTheOwnerOfAContestedNameDoesNotDependOnSpecOrder() throws {
        let other = [arm("signIn", ["username"])]
        for methods in [
            [setAuthState("alphaAuth"), setAuthState("zetaAuth", arms: other)],
            [setAuthState("zetaAuth", arms: other), setAuthState("alphaAuth")],
        ] {
            let output = try generate(methods)

            // alphaAuth's shape keeps the name, wherever it is in the spec.
            assertContains(
                output.models,
                "    public struct SignIn: Codable, Sendable {\n"
                    + "        public let password: String\n        public let username: String\n"
            )
            XCTAssertEqual(count("public func setAuthState(input: AuthActionInput) async throws -> String {", in: output.api), 1)
            XCTAssertEqual(output.warnings, [
                "swift: parameter 'input' of zetaAuth.setAuthState keeps its own nested type, not AuthActionInput:"
                    + " a parameter of another shape has that name."
            ])
        }
    }

    func testAReservedNameKeepsTheNestedInput() throws {
        let output = try generate([setAuthState("alphaAuth", typeName: "Result")])

        assertContains(output.api, "public func setAuthState(input: SetAuthState.Input) async throws -> String {")
    }

    // MARK: - Parameters and results around the shared type

    private func figureArm(_ kind: String, _ field: String) -> String {
        let props = #""kind": { "type": "string", "enum": ["\#(kind)"] }, "\#(field)": { "type": "number" }"#
        return #"{ "type": "object", "properties": { \#(props) }, "required": ["kind", "\#(field)"] }"#
    }

    private var figureArms: [String] { [figureArm("circle", "r"), figureArm("square", "side")] }

    /// A parameter of the figure union: its name, the type name the spec gives it and whether it's required.
    private struct FigureParam {
        let name: String
        let hint: String?
        let required: Bool

        init(_ name: String, _ hint: String?, _ required: Bool) {
            self.name = name
            self.hint = hint
            self.required = required
        }
    }

    /// A method taking `params` of the figure union, returning `result`.
    private func figureMethod(_ name: String, params: [FigureParam], result: String = #"{ "type": "string" }"#) -> String {
        let union = #"{ "oneOf": [\#(figureArms.joined(separator: ", "))]"#
        let list = params.map { param in
            let hint = param.hint.map { #", "x-blocks-type-name": "\#($0)""# } ?? ""
            return #"{ "name": "\#(param.name)", "required": \#(param.required), "schema": \#(union)\#(hint) } }"#
        }.joined(separator: ", ")
        return #"{ "name": "\#(name)", "params": [\#(list)], "result": { "name": "R", "schema": \#(result) } }"#
    }

    /// A result holding a nested `figure` object.
    private let deepFigureResult = """
    { "type": "object", "properties": { "figure": { "type": "object", "properties": { "x": { "type": "number" } },
      "required": ["x"] } }, "required": ["figure"] }
    """

    private var figureResult: String { #"{ "oneOf": [\#(figureArms.joined(separator: ", "))] }"# }

    /// A hint that is the parameter's own name (`command: Command`) would alias itself, so the parameter keeps its
    /// nested type.
    func testAHintThatIsTheParametersNameKeepsTheNestedType() throws {
        let output = try generate([figureMethod("api.send", params: [FigureParam("command", "Command", true)])])

        assertNotContains(output.api, "typealias Command = Command")
        assertNotContains(output.models, "enum Command")
        assertContains(output.api, "public func send(command: Send.Command) async throws -> String {")
    }

    /// Two parameters of the shared shape take the shared type, and the operation's enum aliases each old name once.
    func testTwoParametersOfTheSharedShapeAliasEachOldNameOnce() throws {
        let output = try generate([figureMethod("api.compare", params: [FigureParam("left", "Figure", true), FigureParam("right", "Figure", true)])])

        assertContains(output.api, "public func compare(left: Figure, right: Figure) async throws -> String {")
        XCTAssertEqual(count("public typealias Circle = Figure.Circle", in: output.api), 1)
        assertNotContains(output.api, "public struct Circle")
    }

    /// A result of the shared shape names the shared type rather than declaring the variants again.
    func testAResultOfTheSharedShapeNamesTheSharedType() throws {
        let output = try generate([figureMethod("api.normalize", params: [FigureParam("input", "Figure", true)], result: figureResult)])

        assertContains(output.api, "public func normalize(input: Figure) async throws -> Figure {")
        assertNotContains(output.api, "public struct Circle")
        XCTAssertEqual(count("public typealias Circle = Figure.Circle", in: output.api), 1)
    }

    func testAnOptionalParameterTakesTheSharedType() throws {
        let output = try generate([figureMethod("api.draw", params: [FigureParam("input", "Figure", false)])])

        assertContains(output.api, "public func draw(input: Figure? = nil) async throws -> String {")
    }

    /// A deeper nested type of the shared type's name (`Place.Result.Figure`) doesn't take the parameter's type.
    func testASharedTypeBesideADeeperNestedTypeOfItsName() throws {
        let output = try generate([figureMethod("api.place", params: [FigureParam("input", "Figure", true)], result: deepFigureResult)])

        assertContains(output.api, "public func place(input: Figure) async throws -> Place.Result {")
    }

    /// A sibling parameter named after the hint (`figure: { label }`) declares `Place.Figure`, which would hide the
    /// shared `Figure` from the operation's aliases, so the hinted parameter keeps its nested type.
    private var siblingNamedAfterTheHint: String {
        let union = #"{ "oneOf": [\#(figureArms.joined(separator: ", "))], "x-blocks-type-name": "Figure" }"#
        let label = #"{ "type": "object", "properties": { "label": { "type": "string" } }, "required": ["label"] }"#
        let params = #"[{ "name": "input", "required": true, "schema": \#(union) }, { "name": "figure", "required": true, "schema": \#(label) }]"#
        return #"{ "name": "api.place", "params": \#(params), "result": { "name": "R", "schema": { "type": "string" } } }"#
    }

    func testASiblingParameterNamedAfterTheHintKeepsTheNestedType() throws {
        let output = try generate([siblingNamedAfterTheHint])

        assertContains(output.api, "public func place(input: Place.Input, figure: Place.Figure) async throws -> String {")
        assertNotContains(output.models, "enum Figure")
        #if os(macOS)
        try typecheckConsumer(
            models: output.models, api: output.api,
            consumer: """
            import Generated

            func call(_ api: Api) async throws {
                _ = try await api.place(input: .circle(Api.Place.Circle(r: 1)), figure: Api.Place.Figure(label: "a"))
            }
            """,
            moduleFlags: ["-swift-version", "6", "-warnings-as-errors"]
        )
        #endif
    }

    /// A result field that deduplicates against the result's own `Input` (`{ input: Message, output: Message }`)
    /// keeps naming it: only a reference to the hinted parameter's old type names the shared one.
    func testAResultFieldNamedLikeTheOldInputKeepsItsOwnType() throws {
        #if os(macOS)
        func roleArm(_ role: String) -> String {
            let props = #""role": { "type": "string", "enum": ["\#(role)"] }, "content": { "type": "string" }"#
            return #"{ "type": "object", "properties": { \#(props) }, "required": ["role", "content"] }"#
        }
        let message = #"{ "oneOf": [\#(roleArm("user")), \#(roleArm("assistant"))] }"#
        let prompt = #"{ "oneOf": [\#(figureArms.joined(separator: ", "))], "x-blocks-type-name": "Prompt" }"#
        let result = #"{ "type": "object", "properties": { "input": \#(message), "output": \#(message) }, "required": ["input", "output"] }"#
        let params = #"[{ "name": "input", "required": true, "schema": \#(prompt) }]"#
        let output = try generate([#"{ "name": "ai.generate", "params": \#(params), "result": { "name": "R", "schema": \#(result) } }"#])

        assertContains(output.api, "public func generate(input: Prompt) async throws -> Generate.Result {")
        assertNotContains(output.api, "public let output: Prompt")
        let main = """
        import Foundation
        import Generated

        let json = #"{ "input": { "role": "user", "content": "hi" }, "output": { "role": "assistant", "content": "hello" } }"#
        do {
            let decoded = try JSONDecoder().decode(Ai.Generate.Result.self, from: Data(json.utf8))
            print("output:", decoded.output)
        } catch {
            print("error:", error)
        }
        """
        guard let run = try runConsumer(models: output.models, api: output.api, main: main) else { return }
        XCTAssertTrue(run.output.hasPrefix("output: assistant(") && run.output.contains("hello"), run.output)
        #else
        throw XCTSkip("Compiling the generated module needs the host toolchain (macOS only).")
        #endif
    }

    /// A discriminated union with a value arm (`{ action: "user" } | { action: "group" } | string`) names that arm's
    /// case after the union (`to_Variant2`), so sharing it would rename the case under the old names; it keeps its
    /// nested type.
    func testADiscriminatedUnionWithAValueArmIsNotShared() throws {
        let union = #"{ "oneOf": [\#(arm("user", ["id"])), \#(arm("group", ["id"])), { "type": "string" }], "x-blocks-type-name": "Recipient" }"#
        let params = #"[{ "name": "to", "required": true, "schema": \#(union) }]"#
        let method = #"{ "name": "api.send", "params": \#(params), "result": { "name": "R", "schema": { "type": "string" } } }"#
        let output = try generate([method])

        assertNotContains(output.models, "Recipient")
        assertContains(output.api, "public func send(to: Send.To) async throws -> String {")
        #if os(macOS)
        try typecheckConsumer(
            models: output.models, api: output.api,
            consumer: """
            import Generated

            let old: Api.Send.To = .to_Variant2("everyone")
            func call(_ api: Api) async throws { _ = try await api.send(to: old) }
            """,
            moduleFlags: ["-swift-version", "6", "-warnings-as-errors"]
        )
        #endif
    }

    /// A union without a discriminator names its cases after the union (`input_Variant0`), so sharing it would rename
    /// them under the old names; it keeps its nested type.
    func testAUnionWithoutADiscriminatorIsNotShared() throws {
        let object = #"{ "type": "object", "properties": { "to": { "type": "string" } }, "required": ["to"] }"#
        let union = #"{ "oneOf": [{ "type": "string" }, \#(object)], "x-blocks-type-name": "Recipient" }"#
        let params = #"[{ "name": "input", "required": true, "schema": \#(union) }]"#
        let method = #"{ "name": "api.send", "params": \#(params), "result": { "name": "R", "schema": { "type": "string" } } }"#
        let output = try generate([method])

        assertNotContains(output.models, "Recipient")
        assertContains(output.api, "public func send(input: Send.Input) async throws -> String {")
    }

    /// A hint naming a type the generated files use unqualified (`TransportError`, `BlocksClient`) keeps the nested type.
    func testAHintThatIsARuntimeNameKeepsTheNestedType() throws {
        for name in ["TransportError", "ApiError", "BlocksClient", "JSONDecoder", "BlocksRuntime"] {
            let output = try generate([setAuthState("alphaAuth", typeName: name)])
            assertContains(output.api, "public func setAuthState(input: SetAuthState.Input) async throws -> String {")
        }
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

    /// Every shape above compiles as its own module with warnings as errors, and the old names still compile.
    func testParametersAndResultsAroundTheSharedTypeCompile() throws {
        #if os(macOS)
        let output = try generate([
            figureMethod("api.send", params: [FigureParam("command", "Command", true)]),
            figureMethod("api.compare", params: [FigureParam("left", "Figure", true), FigureParam("right", "Figure", true)]),
            figureMethod("api.normalize", params: [FigureParam("input", "Figure", true)], result: figureResult),
            figureMethod("api.draw", params: [FigureParam("input", "Figure", false)]),
            figureMethod("api.place", params: [FigureParam("input", "Figure", true)], result: deepFigureResult)
        ])
        try typecheckConsumer(
            models: output.models, api: output.api,
            consumer: """
            import Generated

            let figure: Figure = .circle(Figure.Circle(r: 1))
            let old: Api.Compare.Left = figure
            let oldVariant: Api.Normalize.Circle = Figure.Circle(r: 2)
            let command: Api.Send.Command = .square(Api.Send.Square(side: 1))

            func call(_ api: Api) async throws {
                _ = try await api.compare(left: figure, right: old)
                let normalized: Figure = try await api.normalize(input: .circle(oldVariant))
                _ = try await api.draw()
                _ = try await api.place(input: normalized).figure.x
                _ = try await api.send(command: command)
            }
            """,
            moduleFlags: ["-warnings-as-errors"]
        )
        #else
        throw XCTSkip("Compiling the generated module needs the host toolchain (macOS only).")
        #endif
    }
}
