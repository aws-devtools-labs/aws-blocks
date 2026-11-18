//
// Copyright Amazon.com Inc. or its affiliates.
// All Rights Reserved.
//
// SPDX-License-Identifier: Apache-2.0
//

import XCTest
@testable import BlocksCodegen

/// A transferable (a realtime channel, a file handle, an OIDC client) only travels from the server to the client:
/// the server never re-hydrates one sent back. So generation fails for an operation parameter that is one, directly
/// or optional, nullable, in an array or a dictionary, or through a `$ref` to one. A model, an inline object or a
/// union that holds one still generates. Swift refuses exactly what the Kotlin generator refuses, with the same
/// message (see Kotlin's `TransferableParameterTest`).
final class TransferableParameterTests: XCTestCase {

    private func generate(schemas: String = "{}", methods: [String]) throws -> GeneratedSources {
        let json = """
        {
            "openrpc": "1.3.2",
            "info": { "title": "test", "version": "1.0.0" },
            "methods": [\(methods.joined(separator: ","))],
            "components": { "schemas": \(schemas) }
        }
        """
        let rpcModel = try OpenRPCParser().parse(data: Data(json.utf8))
        return try SwiftCodeGenerator().generate(from: CodegenModelBuilder().build(from: rpcModel))
    }

    /// `api.relay` taking `params` and returning a string.
    private func relay(_ params: String...) -> String {
        #"{ "name": "api.relay", "params": [\#(params.joined(separator: ","))], "result": { "name": "R", "schema": { "type": "string" } } }"#
    }

    private func param(_ name: String, _ schema: String, required: Bool = true) -> String {
        #"{ "name": "\#(name)", "required": \#(required), "schema": \#(schema) }"#
    }

    private func ref(_ name: String) -> String { ##"{ "$ref": "#/components/schemas/\##(name)" }"## }
    private func array(_ items: String) -> String { #"{ "type": "array", "items": \#(items) }"# }
    private func map(_ values: String) -> String { #"{ "type": "object", "additionalProperties": \#(values) }"# }
    private func nullable(_ inner: String) -> String { #"{ "oneOf": [\#(inner), { "type": "null" }] }"# }
    private func holder(_ field: String, _ schema: String) -> String {
        #"{ "type": "object", "properties": { "\#(field)": \#(schema) }, "required": ["\#(field)"] }"#
    }

    private let channel = #"{ "x-blocks-transferable": "realtime/channel", "x-blocks-type-args": [{ "type": "string" }] }"#
    private let download = #"{ "x-blocks-transferable": "file-bucket/download" }"#
    private let upload = #"{ "x-blocks-transferable": "file-bucket/upload" }"#
    private let oidc = #"{ "x-blocks-transferable": "oidc/client" }"#
    private let unbound = #"{ "x-blocks-transferable": "acme/widget" }"#

    private func assertRefused(
        _ tag: String, schemas: String = "{}", _ method: String, file: StaticString = #filePath, line: UInt = #line
    ) {
        XCTAssertThrowsError(try generate(schemas: schemas, methods: [method]), file: file, line: line) { error in
            XCTAssertEqual(
                "\(error)", "Transferable types (\(tag)) cannot be serialized — they are read-only",
                file: file, line: line
            )
        }
    }

    private func assertGenerates(
        schemas: String = "{}", _ method: String, file: StaticString = #filePath, line: UInt = #line
    ) {
        XCTAssertNoThrow(try generate(schemas: schemas, methods: [method]), file: file, line: line)
    }

    // MARK: - Refused, as in Kotlin

    func testChannelParameterIsRefusedRequiredOptionalOrNullable() {
        assertRefused("realtime/channel", relay(param("feed", channel)))
        assertRefused("realtime/channel", relay(param("feed", channel, required: false)))
        assertRefused("realtime/channel", relay(param("feed", nullable(channel))))
    }

    func testArraysAndDictionariesOfChannelsAreRefused() {
        assertRefused("realtime/channel", relay(param("feeds", array(channel))))
        assertRefused("realtime/channel", relay(param("byRoom", map(channel))))
        assertRefused("realtime/channel", relay(param("maybe", array(nullable(channel)))))
    }

    func testFileHandlesOIDCClientsAndUnboundTagsAreRefused() {
        assertRefused("file-bucket/download", relay(param("download", download)))
        assertRefused("file-bucket/upload", relay(param("upload", upload)))
        assertRefused("oidc/client", relay(param("login", oidc)))
        assertRefused("acme/widget", relay(param("widget", unbound)))
    }

    func testRefToATransferableSchemaIsRefused() {
        assertRefused("realtime/channel", schemas: #"{ "Feed": \#(channel) }"#, relay(param("feed", ref("Feed"))))
    }

    func testTheFirstOffendingParameterIsReported() {
        assertRefused("file-bucket/download", relay(param("files", array(download)), param("byRoom", map(channel))))
    }

    /// `name` taking `params` and returning a string.
    private func method(_ name: String, _ params: String...) -> String {
        #"{ "name": "\#(name)", "params": [\#(params.joined(separator: ","))], "result": { "name": "R", "schema": { "type": "string" } } }"#
    }

    private func assertRefused(_ tag: String, methods: [String], file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertThrowsError(try generate(methods: methods), file: file, line: line) { error in
            XCTAssertEqual("\(error)", "Transferable types (\(tag)) cannot be serialized — they are read-only", file: file, line: line)
        }
    }

    /// Kotlin generates namespaces in the order the spec first names them and stops at the first transferable
    /// parameter, so Swift walks them in that order, not by name, and names the same tag (checked against Kotlin's
    /// generator on both specs).
    func testNamespacesAreWalkedInSpecOrderAsInKotlin() {
        assertRefused("file-bucket/download", methods: [
            method("zeta.upload", param("file", download)), method("alpha.relay", param("feed", channel))
        ])
        // A namespace's operations stay together where the spec first names it, as Kotlin groups them.
        assertRefused("realtime/channel", methods: [
            method("alpha.ping"), method("zeta.upload", param("file", download)), method("alpha.relay", param("feed", channel))
        ])
    }

    // MARK: - Generated, as in Kotlin

    func testModelHoldingATransferableGenerates() {
        assertGenerates(schemas: #"{ "Bundle": \#(holder("feed", channel)) }"#, relay(param("bundle", ref("Bundle"))))
        assertGenerates(
            schemas: #"{ "Outer": \#(holder("inner", ref("Inner"))), "Inner": \#(holder("feed", channel)) }"#,
            relay(param("outer", ref("Outer")))
        )
        assertGenerates(relay(param("bundle", holder("feed", channel))))
    }

    func testUnionHoldingATransferableGenerates() {
        let event = #"""
        { "Event": { "oneOf": [
            { "type": "object", "properties": {
                "kind": { "type": "string", "enum": ["text"] }, "body": { "type": "string" }
            }, "required": ["kind", "body"] },
            { "type": "object", "properties": { "kind": { "type": "string", "enum": ["feed"] }, "feed": \#(channel) }, "required": ["kind", "feed"] }
        ], "discriminator": { "propertyName": "kind" } } }
        """#
        assertGenerates(schemas: event, relay(param("event", ref("Event"))))
        assertGenerates(relay(param("source", #"{ "oneOf": [{ "type": "string" }, \#(array(download))] }"#)))
        assertGenerates(relay(param("source", #"{ "oneOf": [{ "type": "string" }, \#(channel)] }"#)))
    }

    func testRecursiveModelGenerates() throws {
        let schemas = #"""
        { "Node": { "type": "object", "properties": {
            "name": { "type": "string" }, "children": { "type": "array", "items": { "$ref": "#/components/schemas/Node" } }
        }, "required": ["name", "children"] } }
        """#
        let output = try generate(schemas: schemas, methods: [relay(param("tree", ref("Node")))])
        XCTAssertTrue(output.api.contains("public func relay(tree: Node) async throws -> String {"), output.api)

        // An alias of itself (an array of itself) has no transferable to find, and the search ends.
        let loop = ##"{ "Loop": { "type": "array", "items": { "$ref": "#/components/schemas/Loop" } } }"##
        XCTAssertNoThrow(try generate(schemas: loop, methods: [relay(param("loop", ref("Loop")))]))
    }

    func testTransferableResultsGenerate() throws {
        let schemas = #"{ "Bundle": \#(holder("feed", channel)) }"#
        let getBundle = #"{ "name": "api.getBundle", "params": [], "result": { "name": "R", "schema": \#(ref("Bundle")) } }"#
        let getFeed = #"{ "name": "api.getFeed", "params": [], "result": { "name": "R", "schema": \#(channel) } }"#
        let output = try generate(schemas: schemas, methods: [getBundle, getFeed])
        XCTAssertTrue(output.models.contains("public let feed: RealtimeChannel<String>"), output.models)
        XCTAssertTrue(output.api.contains("public func getBundle() async throws -> Bundle {"), output.api)
        XCTAssertTrue(output.api.contains("public func getFeed() async throws -> RealtimeChannel<String> {"), output.api)
    }
}
