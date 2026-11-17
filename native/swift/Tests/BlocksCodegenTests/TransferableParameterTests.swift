//
// Copyright Amazon.com Inc. or its affiliates.
// All Rights Reserved.
//
// SPDX-License-Identifier: Apache-2.0
//

import XCTest
@testable import BlocksCodegen

/// A transferable (a realtime channel, a file handle, an OIDC client) only travels from the server to the client:
/// the server never re-hydrates one sent back. So generation fails for an operation parameter that holds one,
/// directly or through a model, naming the method, the parameter and the field path. A model that holds one and
/// only appears in a result still generates.
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

    /// `api.relay` taking `params` (a JSON array) and returning a string.
    private func relay(_ params: String) -> String {
        #"{ "name": "api.relay", "params": \#(params), "result": { "name": "R", "schema": { "type": "string" } } }"#
    }

    private func param(_ name: String, _ schema: String, required: Bool = true) -> String {
        #"{ "name": "\#(name)", "required": \#(required), "schema": \#(schema) }"#
    }

    private func ref(_ name: String) -> String { ##"{ "$ref": "#/components/schemas/\##(name)" }"## }

    private let channel = #"{ "x-blocks-transferable": "realtime/channel", "x-blocks-type-args": [{ "type": "string" }] }"#
    private let download = #"{ "x-blocks-transferable": "file-bucket/download" }"#

    private func assertRefused(
        schemas: String = "{}", _ methods: [String], _ expected: String, file: StaticString = #filePath, line: UInt = #line
    ) {
        XCTAssertThrowsError(try generate(schemas: schemas, methods: methods), file: file, line: line) { error in
            XCTAssertEqual("\(error)", expected, file: file, line: line)
        }
    }

    private func message(_ tag: String, parameter: String, field: String? = nil) -> String {
        "Transferable types (\(tag)) cannot be serialized: they are read-only. Method 'api.relay', "
            + "parameter '\(parameter)'\(field.map { " (field \($0))" } ?? "")."
    }

    // MARK: - Direct parameters

    func testDirectParameterIsRefused() {
        assertRefused([relay("[\(param("feed", channel))]")], message("realtime/channel", parameter: "feed"))
    }

    func testOptionalParameterIsRefused() {
        assertRefused(
            [relay("[\(param("feed", channel, required: false))]")], message("realtime/channel", parameter: "feed")
        )
    }

    func testNullableParameterIsRefused() {
        let nullable = #"{ "oneOf": [\#(channel), { "type": "null" }] }"#
        assertRefused([relay("[\(param("feed", nullable))]")], message("realtime/channel", parameter: "feed"))
    }

    func testListAndMapParametersAreRefused() {
        let list = #"{ "type": "array", "items": \#(download) }"#
        let map = #"{ "type": "object", "additionalProperties": \#(channel) }"#
        assertRefused(
            [relay("[\(param("files", list)), \(param("byRoom", map))]")],
            message("file-bucket/download", parameter: "files") + "\n" + message("realtime/channel", parameter: "byRoom")
        )
    }

    // MARK: - Through a model

    func testModelFieldListAndMapAreRefusedWithTheFieldPath() {
        let schemas = #"""
        {
            "ByField": { "type": "object", "properties": { "feed": \#(channel) }, "required": ["feed"] },
            "ByList": { "type": "object", "properties": { "files": { "type": "array", "items": \#(download) } }, "required": ["files"] },
            "ByMap": { "type": "object", "properties": { "rooms": { "type": "object", "additionalProperties": \#(channel) } }, "required": ["rooms"] }
        }
        """#
        assertRefused(
            schemas: schemas,
            [relay("[\(param("a", ref("ByField"))), \(param("b", ref("ByList"))), \(param("c", ref("ByMap")))]")],
            [
                message("realtime/channel", parameter: "a", field: "ByField.feed"),
                message("file-bucket/download", parameter: "b", field: "ByList.files"),
                message("realtime/channel", parameter: "c", field: "ByMap.rooms")
            ].joined(separator: "\n")
        )
    }

    func testNestedModelIsRefusedWithTheWholePath() {
        let schemas = #"""
        {
            "Outer": { "type": "object", "properties": { "inner": \#(ref("Inner")) }, "required": ["inner"] },
            "Inner": { "type": "object", "properties": { "feed": \#(channel) }, "required": ["feed"] }
        }
        """#
        assertRefused(
            schemas: schemas, [relay("[\(param("outer", ref("Outer")))]")],
            message("realtime/channel", parameter: "outer", field: "Outer.inner.feed")
        )
    }

    func testInlineObjectParameterIsRefused() {
        let inline = #"{ "type": "object", "properties": { "feed": \#(channel) }, "required": ["feed"] }"#
        XCTAssertThrowsError(try generate(methods: [relay("[\(param("bundle", inline))]")])) { error in
            XCTAssertTrue(
                "\(error)".hasPrefix("Transferable types (realtime/channel) cannot be serialized: they are read-only. "
                    + "Method 'api.relay', parameter 'bundle' (field "),
                "\(error)"
            )
            XCTAssertTrue("\(error)".hasSuffix(".feed)."), "\(error)")
        }
    }

    func testUnionArmIsRefused() {
        let schemas = #"""
        {
            "Event": { "oneOf": [
                { "type": "object", "properties": {
                    "kind": { "type": "string", "enum": ["text"] }, "body": { "type": "string" }
                }, "required": ["kind", "body"] },
                { "type": "object", "properties": { "kind": { "type": "string", "enum": ["feed"] }, "feed": \#(channel) }, "required": ["kind", "feed"] }
            ], "discriminator": { "propertyName": "kind" } }
        }
        """#
        assertRefused(
            schemas: schemas, [relay("[\(param("event", ref("Event")))]")],
            message("realtime/channel", parameter: "event", field: "Event.feed")
        )
    }

    func testUnionValueArmIsRefused() {
        let either = #"{ "oneOf": [{ "type": "string" }, { "type": "array", "items": \#(download) }] }"#
        assertRefused([relay("[\(param("source", either))]")], message("file-bucket/download", parameter: "source"))
    }

    func testRecursiveModelWithoutATransferableGenerates() throws {
        let schemas = #"""
        { "Node": { "type": "object", "properties": {
            "name": { "type": "string" }, "children": { "type": "array", "items": { "$ref": "#/components/schemas/Node" } }
        }, "required": ["name", "children"] } }
        """#
        let output = try generate(schemas: schemas, methods: [relay("[\(param("tree", ref("Node")))]")])
        XCTAssertTrue(output.api.contains("public func relay(tree: Node) async throws -> String {"), output.api)
    }

    // MARK: - Results still generate

    func testModelHoldingATransferableStillGeneratesAsAResult() throws {
        let schemas = #"{ "Bundle": { "type": "object", "properties": { "feed": \#(channel) }, "required": ["feed"] } }"#
        let getBundle = #"{ "name": "api.getBundle", "params": [], "result": { "name": "R", "schema": \#(ref("Bundle")) } }"#
        let getFeed = #"{ "name": "api.getFeed", "params": [], "result": { "name": "R", "schema": \#(channel) } }"#
        let output = try generate(schemas: schemas, methods: [getBundle, getFeed])
        XCTAssertTrue(output.models.contains("public let feed: RealtimeChannel<String>"), output.models)
        XCTAssertTrue(output.api.contains("public func getBundle() async throws -> Bundle {"), output.api)
        XCTAssertTrue(output.api.contains("public func getFeed() async throws -> RealtimeChannel<String> {"), output.api)
    }
}
