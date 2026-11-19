//
// Copyright Amazon.com Inc. or its affiliates.
// All Rights Reserved.
//
// SPDX-License-Identifier: Apache-2.0
//

import XCTest
@testable import BlocksCodegen

/// Generated value types are `Sendable` when everything they store is, so a Swift 6 actor can keep or return an
/// `AuthState`. A type that stores a `RealtimeChannel` (a class with mutable state) isn't, directly or through
/// another generated type.
final class SendableModelTests: XCTestCase {

    private var fixturesURL: URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("codegen-fixtures")
    }

    private func generate(fixture: String) throws -> GeneratedSources {
        let spec = try Data(contentsOf: fixturesURL.appendingPathComponent("\(fixture)/spec.json"))
        let rpcModel = try OpenRPCParser().parse(data: spec)
        return try SwiftCodeGenerator().generate(from: CodegenModelBuilder().build(from: rpcModel))
    }

    private func generate(methods: [String], schemas: String = "{}") throws -> GeneratedSources {
        let json = """
        { "openrpc": "1.3.2", "info": { "title": "t", "version": "1.0.0" },
          "methods": [\(methods.joined(separator: ", "))], "components": { "schemas": \(schemas) } }
        """
        let rpcModel = try OpenRPCParser().parse(data: Data(json.utf8))
        return try SwiftCodeGenerator().generate(from: CodegenModelBuilder().build(from: rpcModel))
    }

    private func assertContains(_ haystack: String, _ needle: String, file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertTrue(haystack.contains(needle), "Expected generated code to contain:\n\(needle)\n--- got ---\n\(haystack)", file: file, line: line)
    }

    func testAuthModelsAndTheInputAreSendable() throws {
        let output = try generate(fixture: "18-hybrid-arm")

        assertContains(output.models, "public nonisolated struct AuthState: Codable, Sendable {")
        assertContains(output.models, "public nonisolated enum AuthStateState: RawRepresentable, Codable, Hashable, Sendable {")
        assertContains(output.models, "public nonisolated enum AuthActionInput: Codable, Sendable {")
        assertContains(output.models, "    public struct SignIn: Codable, Sendable {")
    }

    func testATypeThatStoresAChannelIsNotSendableNorIsWhatStoresIt() throws {
        let channel = #"{ "x-blocks-transferable": "realtime/channel", "x-blocks-type-args": [{ "type": "string" }] }"#
        let schemas = """
        { "Room": { "type": "object", "properties": { "feed": \(channel) }, "required": ["feed"] },
          "Lobby": { "type": "object", "properties": { "room": { "$ref": "#/components/schemas/Room" } }, "required": ["room"] },
          "Note": { "type": "object", "properties": { "text": { "type": "string" } }, "required": ["text"] } }
        """
        let methods = ["Room", "Lobby", "Note"].map { name -> String in
            ##"{ "name": "api.get\##(name)", "params": [], "result": { "name": "R", "schema": { "$ref": "#/components/schemas/\##(name)" } } }"##
        }
        let output = try generate(methods: methods, schemas: schemas)

        assertContains(output.models, "public nonisolated struct Room: Codable {")
        assertContains(output.models, "public nonisolated struct Lobby: Codable {")
        assertContains(output.models, "public nonisolated struct Note: Codable, Sendable {")
    }

    /// A declared native binding below an operation's direct result is stored as a `JSONValue`, so it doesn't
    /// drop the conformance.
    func testATypeThatStoresADeclaredBindingIsSendable() throws {
        let spec = """
        { "openrpc": "1.3.2", "info": { "title": "t", "version": "1.0.0" },
          "methods": [{ "name": "api.getRig", "params": [], "result": { "name": "R", "schema": { "$ref": "#/components/schemas/Rig" } } }],
          "components": { "schemas": { "Rig": { "type": "object", "required": ["handle", "name"], "properties": {
            "handle": { "x-blocks-transferable": "example-iot/device-handle" }, "name": { "type": "string" } } } } },
          "x-blocks-native-packages": { "schemaVersion": 1, "packages": { "example-iot-native": { "platforms": { "swift":
            { "package": { "identity": "example-iot-native", "product": "ExampleIotNative", "module": "ExampleIotNative" } } } } } },
          "x-blocks-native-bindings": { "schemaVersion": 1, "bindings": [{ "id": "example-device-handle", "kind": "transferable",
            "tag": "example-iot/device-handle", "package": "example-iot-native", "export": "deviceHandle",
            "abi": "blocks-transferable-v1", "genericArity": 0 }] } }
        """
        let rpcModel = try OpenRPCParser().parse(data: Data(spec.utf8))
        let output = try SwiftCodeGenerator().generate(from: CodegenModelBuilder().build(from: rpcModel))

        assertContains(output.models, "public let handle: JSONValue\n")
        assertContains(output.models, "public nonisolated struct Rig: Codable, Sendable {")
    }

    /// A Swift 6 actor that keeps or returns an `AuthState`, and sends an
    /// `setAuthState` input across actors, compiles without "sending ... risks causing data races".
    func testASwift6ActorKeepsAndReturnsAuthState() throws {
        #if os(macOS)
        let output = try generate(fixture: "18-hybrid-arm")
        try typecheckConsumer(
            models: output.models, api: output.api,
            consumer: """
            import Generated

            actor SessionStore {
                private var state: AuthState?
                private var pending: AuthActionInput?

                func keep(_ state: AuthState) { self.state = state }
                func current() -> AuthState? { state }
                func queue(_ input: AuthActionInput) { pending = input }
            }

            @MainActor
            func show(_ store: SessionStore, input: AuthActionInput) async {
                await store.queue(input)
                if let state = await store.current() { await store.keep(state) }
            }
            """,
            moduleFlags: ["-swift-version", "6", "-warnings-as-errors"],
            consumerFlags: ["-emit-sil", "-o", "/dev/null", "-swift-version", "6", "-warnings-as-errors"]
        )
        #else
        throw XCTSkip("Compiling the generated module needs the host toolchain (macOS only).")
        #endif
    }

    // MARK: - Scopes

    private let channel = #"{ "x-blocks-transferable": "realtime/channel", "x-blocks-type-args": [{ "type": "string" }] }"#

    /// Two operations' `Result`s each get their own answer: a channel in one doesn't drop `Sendable` from the other,
    /// and the other being `Sendable` doesn't make the one that stores a channel claim it.
    private var sameNamedResults: [String] {
        func arm(_ status: String, _ field: String, _ schema: String = #"{ "type": "string" }"#) -> String {
            let props = #""status": { "type": "string", "enum": ["\#(status)"] }, "\#(field)": \#(schema)"#
            return #"{ "type": "object", "properties": { \#(props) }, "required": ["status", "\#(field)"] }"#
        }
        let (signedIn, pending) = (arm("signedIn", "user"), arm("pending", "code"))
        let (joined, full) = (arm("joined", "channel", channel), arm("full", "reason"))
        return [
            #"{ "name": "auth.signIn", "params": [], "result": { "name": "R", "schema": { "oneOf": [\#(signedIn), \#(pending)] } } }"#,
            #"{ "name": "chat.join", "params": [], "result": { "name": "R", "schema": { "oneOf": [\#(joined), \#(full)] } } }"#
        ]
    }

    func testSameNamedTypesInTwoOperationsGetTheirOwnAnswer() throws {
        let output = try generate(methods: sameNamedResults)
        let auth = try XCTUnwrap(output.api.components(separatedBy: "public enum SignIn {").last)
        let chat = try XCTUnwrap(output.api.components(separatedBy: "public enum Join {").last)

        assertContains(auth, "public enum Result: Codable, Sendable {")
        assertContains(chat, "public enum Result: Codable {")
        assertContains(chat, "public struct Joined: Codable {")
        assertContains(chat, "public struct Full: Codable, Sendable {")
    }

    /// The same spec compiles in Swift 6 language mode with warnings as errors, so no type claims a `Sendable` it
    /// isn't.
    func testSameNamedTypesInTwoOperationsCompileInSwift6() throws {
        #if os(macOS)
        let output = try generate(methods: sameNamedResults)
        try typecheckConsumer(
            models: output.models, api: output.api, consumer: "import Generated\n",
            moduleFlags: ["-swift-version", "6", "-warnings-as-errors"]
        )
        #else
        throw XCTSkip("Compiling the generated module needs the host toolchain (macOS only).")
        #endif
    }

    /// A union whose arms are component schemas (`$ref Joined | $ref Full`) stores those schemas, so it takes their
    /// top-level answer: an operation's enum declares nothing named `Joined` for the arm.
    private var refArmResult: (schemas: String, method: String) {
        func arm(_ status: String, _ field: String, _ schema: String) -> String {
            let props = #""status": { "type": "string", "enum": ["\#(status)"] }, "\#(field)": \#(schema)"#
            return #"{ "type": "object", "properties": { \#(props) }, "required": ["status", "\#(field)"] }"#
        }
        let schemas = """
        { "Joined": \(arm("joined", "channel", channel)), "Full": \(arm("full", "reason", #"{ "type": "string" }"#)) }
        """
        let ref = { (name: String) in ##"{ "$ref": "#/components/schemas/\##(name)" }"## }
        let method = #"{ "name": "chat.join", "params": [], "result": { "name": "R", "schema": { "oneOf": [\#(ref("Joined")), \#(ref("Full"))] } } }"#
        return (schemas, method)
    }

    func testAUnionOfComponentArmsTakesTheirAnswer() throws {
        let output = try generate(methods: [refArmResult.method], schemas: refArmResult.schemas)

        assertContains(output.models, "public nonisolated struct Joined: Codable {")
        assertContains(output.api, "public enum Result: Codable {")
        #if os(macOS)
        try typecheckConsumer(
            models: output.models, api: output.api, consumer: "import Generated\n",
            moduleFlags: ["-swift-version", "6", "-warnings-as-errors"]
        )
        #endif
    }

    /// A generated type named `Sendable` hides the protocol in its scope, so the conformance is spelled `Swift.Sendable`.
    func testATypeNamedSendableQualifiesTheConformance() throws {
        let inner = #"{ "type": "object", "properties": { "x": { "type": "string" } }, "required": ["x"] }"#
        let schemas = #"{ "Holder": { "type": "object", "properties": { "sendable": \#(inner) }, "required": ["sendable"] } }"#
        let method = ##"{ "name": "api.get", "params": [], "result": { "name": "R", "schema": { "$ref": "#/components/schemas/Holder" } } }"##
        let output = try generate(methods: [method], schemas: schemas)

        assertContains(output.models, "public nonisolated struct Holder: Codable, Swift.Sendable {")
        assertContains(output.models, "public nonisolated struct Sendable: Codable, Swift.Sendable {")
        #if os(macOS)
        try typecheckConsumer(models: output.models, api: output.api, consumer: "import Generated\n", moduleFlags: ["-warnings-as-errors"])
        #endif
    }
}
