//
// Copyright Amazon.com Inc. or its affiliates.
// All Rights Reserved.
//
// SPDX-License-Identifier: Apache-2.0
//

import XCTest
@testable import BlocksCodegen

/// A model can hold a transferable (a realtime channel, a file handle, an OIDC client) at any depth. The
/// transferable types are `Codable` in BlocksRuntime, so the generated models need to import it, and an
/// operation whose result holds an OIDC client decodes with a decoder that carries the calling `BlocksClient`.
final class TransferableModelTests: XCTestCase {

    private func generate(schemas: String = "{}", methods: String) throws -> GeneratedSources {
        let json = """
        {
            "openrpc": "1.3.2",
            "info": { "title": "test", "version": "1.0.0" },
            "methods": \(methods),
            "components": { "schemas": \(schemas) }
        }
        """
        let rpcModel = try OpenRPCParser().parse(data: Data(json.utf8))
        return SwiftCodeGenerator().generate(from: CodegenModelBuilder().build(from: rpcModel))
    }

    private func method(_ name: String, returning ref: String) -> String {
        """
        { "name": "api.\(name)", "params": [],
          "result": { "name": "R", "schema": { "$ref": "#/components/schemas/\(ref)" } } }
        """
    }

    private func assertContains(_ haystack: String, _ needle: String, file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertTrue(haystack.contains(needle), "Expected generated code to contain:\n\(needle)\n--- got ---\n\(haystack)", file: file, line: line)
    }

    private func assertNotContains(_ haystack: String, _ needle: String, file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertFalse(haystack.contains(needle), "Expected generated code not to contain:\n\(needle)\n--- got ---\n\(haystack)", file: file, line: line)
    }

    private let note = """
    "Note": { "type": "object", "properties": { "id": { "type": "string" } }, "required": ["id"] }
    """

    // MARK: - Models.swift imports BlocksRuntime

    func testModelsImportBlocksRuntimeForAChannelField() throws {
        let output = try generate(schemas: """
        { \(note), "Holder": { "type": "object", "properties": {
            "feed": { "x-blocks-transferable": "realtime/channel", "x-blocks-type-args": [{ "$ref": "#/components/schemas/Note" }] }
        }, "required": ["feed"] } }
        """, methods: "[\(method("get", returning: "Holder"))]")

        XCTAssertTrue(output.models.hasPrefix("import Foundation\nimport BlocksRuntime\n"), output.models)
        assertContains(output.models, "public let feed: RealtimeChannel<Note>")
    }

    func testModelsImportBlocksRuntimeForTransferablesInContainers() throws {
        for (property, swiftType) in [
            (#"{ "type": "array", "items": { "x-blocks-transferable": "file-bucket/download" } }"#, "[FileDownloadHandle]"),
            (#"{ "type": "object", "additionalProperties": { "x-blocks-transferable": "file-bucket/upload" } }"#, "[String: FileUploadHandle]"),
            (#"{ "oneOf": [{ "x-blocks-transferable": "oidc/client" }, { "type": "null" }] }"#, "OIDCClient?")
        ] {
            let output = try generate(schemas: """
            { "Holder": { "type": "object", "properties": { "value": \(property) }, "required": ["value"] } }
            """, methods: "[\(method("get", returning: "Holder"))]")

            XCTAssertTrue(output.models.hasPrefix("import Foundation\nimport BlocksRuntime\n"), output.models)
            assertContains(output.models, "public let value: \(swiftType)")
        }
    }

    func testModelsWithoutTransferablesDoNotImportBlocksRuntime() throws {
        let output = try generate(schemas: "{ \(note) }", methods: "[\(method("get", returning: "Note"))]")
        assertNotContains(output.models, "import BlocksRuntime")
    }

    // MARK: - OIDC client decoding

    func testResultHoldingAnOIDCClientDecodesWithTheClient() throws {
        let output = try generate(schemas: """
        { "Option": { "type": "object", "properties": {
            "client": { "x-blocks-transferable": "oidc/client" }
        }, "required": ["client"] } }
        """, methods: "[\(method("get", returning: "Option"))]")

        assertContains(output.api, "return try client.makeDecoder().decode(Option.self, from: result)")
    }

    func testOIDCClientAtAnyDepthDecodesWithTheClient() throws {
        let schemas = """
        {
            "Option": { "type": "object", "properties": {
                "client": { "x-blocks-transferable": "oidc/client" }
            }, "required": ["client"] },
            "Menu": { "type": "object", "properties": {
                "options": { "type": "array", "items": { "$ref": "#/components/schemas/Option" } }
            }, "required": ["options"] },
            "Wrapper": { "type": "object", "properties": {
                "menus": { "type": "object", "additionalProperties": { "$ref": "#/components/schemas/Menu" } }
            } },
            "Choice": { "oneOf": [
                { "type": "object", "properties": { "kind": { "const": "a" }, "option": { "$ref": "#/components/schemas/Option" } },
                  "required": ["kind", "option"] },
                { "type": "object", "properties": { "kind": { "const": "b" } }, "required": ["kind"] }
            ], "discriminator": { "propertyName": "kind" } },
            "Tree": { "type": "object", "properties": {
                "children": { "type": "array", "items": { "$ref": "#/components/schemas/Tree" } },
                "leaf": { "$ref": "#/components/schemas/Option" }
            } }
        }
        """
        let output = try generate(schemas: schemas, methods: """
        [\(method("getMenu", returning: "Menu")), \(method("getWrapper", returning: "Wrapper")),
         \(method("getChoice", returning: "Choice")), \(method("getTree", returning: "Tree")),
         { "name": "api.listOptions", "params": [], "result": { "name": "R", "schema": {
             "type": "array", "items": { "$ref": "#/components/schemas/Option" } } } },
         { "name": "api.maybeClient", "params": [], "result": { "name": "R", "schema": {
             "oneOf": [{ "x-blocks-transferable": "oidc/client" }, { "type": "null" }] } } },
         { "name": "api.getInline", "params": [], "result": { "name": "R", "schema": {
             "type": "object", "properties": { "inner": { "type": "object", "properties": {
                 "client": { "x-blocks-transferable": "oidc/client" } }, "required": ["client"] } },
             "required": ["inner"] } } }]
        """)

        assertContains(output.api, "return try client.makeDecoder().decode(Menu.self, from: result)")
        assertContains(output.api, "return try client.makeDecoder().decode(Wrapper.self, from: result)")
        assertContains(output.api, "return try client.makeDecoder().decode(Choice.self, from: result)")
        assertContains(output.api, "return try client.makeDecoder().decode(Tree.self, from: result)")
        assertContains(output.api, "return try client.makeDecoder().decode([Option].self, from: result)")
        // A nullable OIDC client result hydrates from its descriptor with the calling client, as a direct one
        // does (#656).
        assertContains(output.api, "return try OIDCClient.fromJSON(descriptor, baseUrl: self.client.baseUrl, client: self.client)")
        assertContains(output.api, "return try client.makeDecoder().decode(GetInline.Result.self, from: result)")
    }

    func testOIDCClientInASchemasNestedInlineTypeDecodesWithTheClient() throws {
        // Two schemas each nest a `Meta` type (R49); only `WithClient.Meta` holds an OIDC client.
        let output = try generate(schemas: """
        {
            "WithClient": { "type": "object", "properties": {
                "meta": { "type": "object", "properties": {
                    "deep": { "type": "object", "properties": {
                        "client": { "x-blocks-transferable": "oidc/client" } }, "required": ["client"] }
                }, "required": ["deep"] }
            }, "required": ["meta"] },
            "WithoutClient": { "type": "object", "properties": {
                "meta": { "type": "object", "properties": {
                    "deep": { "type": "object", "properties": { "value": { "type": "string" } }, "required": ["value"] }
                }, "required": ["deep"] }
            }, "required": ["meta"] }
        }
        """, methods: "[\(method("getWith", returning: "WithClient")), \(method("getWithout", returning: "WithoutClient"))]")

        assertContains(output.models, "public let client: OIDCClient")
        assertContains(output.api, "return try client.makeDecoder().decode(WithClient.self, from: result)")
        assertContains(output.api, "return try JSONDecoder().decode(WithoutClient.self, from: result)")
    }

    func testResultsWithoutAnOIDCClientKeepAPlainDecoder() throws {
        let output = try generate(schemas: """
        { \(note), "Board": { "type": "object", "properties": {
            "feeds": { "type": "array", "items": {
                "x-blocks-transferable": "realtime/channel", "x-blocks-type-args": [{ "$ref": "#/components/schemas/Note" }] } },
            "files": { "type": "array", "items": { "x-blocks-transferable": "file-bucket/download" } }
        }, "required": ["feeds", "files"] } }
        """, methods: "[\(method("getBoard", returning: "Board")), \(method("getNote", returning: "Note"))]")

        assertContains(output.api, "return try JSONDecoder().decode(Board.self, from: result)")
        assertContains(output.api, "return try JSONDecoder().decode(Note.self, from: result)")
        assertNotContains(output.api, "makeDecoder")
    }

    func testDirectTransferableResultsAreUnchanged() throws {
        let output = try generate(methods: """
        [{ "name": "api.getClient", "params": [], "result": { "name": "R", "schema": { "x-blocks-transferable": "oidc/client" } } }]
        """)
        assertContains(output.api, "return try OIDCClient.fromJSON(descriptor, baseUrl: self.client.baseUrl, client: self.client)")
        assertNotContains(output.api, "makeDecoder")
    }
}
