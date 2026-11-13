//
// Copyright Amazon.com Inc. or its affiliates.
// All Rights Reserved.
//
// SPDX-License-Identifier: Apache-2.0
//

import XCTest
@testable import BlocksCodegen

/// Generated value types are `Sendable` when everything they store is, so a Swift 6 actor can keep or return an
/// `AuthState`. A type that stores a `RealtimeChannel` (a class with mutable state) or a declared native binding
/// isn't, directly or through another generated type.
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
        assertContains(output.models, "public nonisolated enum AuthStateState: String, Codable, Sendable {")
        assertContains(output.api, "        public enum Input: Codable, Sendable {")
        assertContains(output.api, "        public struct SignIn: Codable, Sendable {")
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

    /// A Swift 6 actor that keeps or returns an `AuthState`, and sends an
    /// `setAuthState` input across actors, compiles without "sending ... risks causing data races".
    func testASwift6ActorKeepsAndReturnsAuthState() throws {
        #if os(macOS)
        let output = try generate(fixture: "18-hybrid-arm")
        try typecheckConsumer(
            models: output.models, api: output.api,
            consumer: """
            import Generated

            typealias AuthActionInput = AuthApi.SetAuthState.Input

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
}
