//
// Copyright Amazon.com Inc. or its affiliates.
// All Rights Reserved.
//
// SPDX-License-Identifier: Apache-2.0
//

import XCTest
@testable import BlocksCodegen

final class SwiftCodeGeneratorTests: XCTestCase {
    let parser = OpenRPCParser()
    let builder = CodegenModelBuilder()
    let generator = SwiftCodeGenerator()

    private func generate(from json: String) throws -> (models: String, api: String) {
        let rpcModel = try parser.parse(data: json.data(using: .utf8)!)
        let codegenModel = builder.build(from: rpcModel)
        return generator.generate(from: codegenModel)
    }

    // MARK: - Basic Generation

    func testGeneratesStructForObject() throws {
        let output = try generate(from: """
        {
            "openrpc": "1.3.2",
            "info": { "title": "test", "version": "1.0.0" },
            "methods": [{
                "name": "api.get",
                "params": [],
                "result": { "name": "Todo", "schema": { "type": "object", "properties": { "title": { "type": "string" }, "done": { "type": "boolean" } }, "required": ["title", "done"] } }
            }]
        }
        """)

        let all = output.models + "\n" + output.api
        XCTAssertTrue(all.contains("struct Result: Codable"))
        XCTAssertTrue(all.contains("let done: Bool"))
        XCTAssertTrue(all.contains("let title: String"))
    }

    func testGeneratesEnumForStringEnum() throws {
        let output = try generate(from: """
        {
            "openrpc": "1.3.2",
            "info": { "title": "test", "version": "1.0.0" },
            "methods": [{
                "name": "api.list",
                "params": [{ "name": "sortBy", "required": false, "schema": { "type": "string", "enum": ["title", "date", "priority"] } }],
                "result": { "name": "R", "schema": { "type": "string" } }
            }]
        }
        """)

        let all = output.models + "\n" + output.api
        XCTAssertTrue(all.contains("enum"))
        XCTAssertTrue(all.contains("case title"))
        XCTAssertTrue(all.contains("case date"))
        XCTAssertTrue(all.contains("case priority"))
    }

    // MARK: - Format Types

    func testGeneratesUUIDType() throws {
        let output = try generate(from: """
        {
            "openrpc": "1.3.2",
            "info": { "title": "test", "version": "1.0.0" },
            "methods": [{
                "name": "api.get",
                "params": [{ "name": "id", "required": true, "schema": { "type": "string", "format": "uuid" } }],
                "result": { "name": "R", "schema": { "type": "string" } }
            }]
        }
        """)

        XCTAssertTrue(output.api.contains("id: UUID"))
    }

    func testGeneratesDateType() throws {
        let output = try generate(from: """
        {
            "openrpc": "1.3.2",
            "info": { "title": "test", "version": "1.0.0" },
            "methods": [{
                "name": "api.get",
                "params": [{ "name": "ts", "required": true, "schema": { "type": "string", "format": "date-time" } }],
                "result": { "name": "R", "schema": { "type": "string" } }
            }]
        }
        """)

        XCTAssertTrue(output.api.contains("ts: Date"))
    }

    func testGeneratesURLType() throws {
        let output = try generate(from: """
        {
            "openrpc": "1.3.2",
            "info": { "title": "test", "version": "1.0.0" },
            "methods": [{
                "name": "api.get",
                "params": [{ "name": "link", "required": true, "schema": { "type": "string", "format": "uri" } }],
                "result": { "name": "R", "schema": { "type": "string" } }
            }]
        }
        """)

        XCTAssertTrue(output.api.contains("link: URL"))
    }

    // MARK: - Map Type

    func testGeneratesDictionaryForRecord() throws {
        let output = try generate(from: """
        {
            "openrpc": "1.3.2",
            "info": { "title": "test", "version": "1.0.0" },
            "methods": [{
                "name": "api.getScores",
                "params": [],
                "result": { "name": "Scores", "schema": { "type": "object", "additionalProperties": { "type": "number" } } }
            }]
        }
        """)

        XCTAssertTrue(output.api.contains("[String: Double]"))
    }

    // MARK: - API Extension

    func testGeneratesBlocksClientExtension() throws {
        let output = try generate(from: """
        {
            "openrpc": "1.3.2",
            "info": { "title": "test", "version": "1.0.0" },
            "methods": [{
                "name": "api.greet",
                "params": [{ "name": "name", "required": true, "schema": { "type": "string" } }],
                "result": { "name": "R", "schema": { "type": "object", "properties": { "message": { "type": "string" } }, "required": ["message"] } }
            }]
        }
        """)

        XCTAssertTrue(output.api.contains("public class Api"))
        XCTAssertTrue(output.api.contains("func greet(name: String)"))
        XCTAssertTrue(output.api.contains("async throws"))
    }

    func testGeneratesOptionalParam() throws {
        let output = try generate(from: """
        {
            "openrpc": "1.3.2",
            "info": { "title": "test", "version": "1.0.0" },
            "methods": [{
                "name": "api.list",
                "params": [{ "name": "limit", "required": false, "schema": { "type": "number" } }],
                "result": { "name": "R", "schema": { "type": "string" } }
            }]
        }
        """)

        XCTAssertTrue(output.api.contains("limit: Double?"))
    }

    // MARK: - Transferable

    func testGeneratesRealtimeChannel() throws {
        let output = try generate(from: """
        {
            "openrpc": "1.3.2",
            "info": { "title": "test", "version": "1.0.0" },
            "methods": [{
                "name": "api.getChannel",
                "params": [],
                "result": { "name": "Ch", "schema": { "x-blocks-transferable": "realtime/channel", "x-blocks-type-args": [{ "type": "object", "properties": { "x": { "type": "number" } }, "required": ["x"] }] } }
            }]
        }
        """)

        XCTAssertTrue(output.api.contains("RealtimeChannel<"))
    }

    /// Ensures the realtime closure passes raw bytes to the decoder:
    /// the realtime closure should hand the raw payload bytes straight to
    /// the typed decoder. Eliminates the redundant String round-trip we
    /// previously emitted (`{ text in try JSONDecoder().decode(_, from: Data(text.utf8)) }`).
    func testRealtimeClosurePassesPayloadDataDirectlyToDecoder() throws {
        let output = try generate(from: """
        {
            "openrpc": "1.3.2",
            "info": { "title": "test", "version": "1.0.0" },
            "methods": [{
                "name": "api.getChannel",
                "params": [],
                "result": { "name": "Ch", "schema": { "x-blocks-transferable": "realtime/channel", "x-blocks-type-args": [{ "type": "object", "properties": { "x": { "type": "number" } }, "required": ["x"] }] } }
            }]
        }
        """)

        XCTAssertTrue(
            output.api.contains("{ data in"),
            "expected emitted closure to bind `data in`, got:\n\(output.api)"
        )
        XCTAssertTrue(
            output.api.contains("from: data)"),
            "expected emitted closure to decode straight from data, got:\n\(output.api)"
        )
        XCTAssertFalse(
            output.api.contains("Data(text.utf8)"),
            "expected the String→Data round-trip to be removed, got:\n\(output.api)"
        )
        XCTAssertFalse(
            output.api.contains("{ text in"),
            "expected the closure to no longer bind `text in`, got:\n\(output.api)"
        )
    }

    func testGeneratesFileDownloadHandle() throws {
        let output = try generate(from: """
        {
            "openrpc": "1.3.2",
            "info": { "title": "test", "version": "1.0.0" },
            "methods": [{
                "name": "api.getFile",
                "params": [{ "name": "path", "required": true, "schema": { "type": "string" } }],
                "result": { "name": "Handle", "schema": { "x-blocks-transferable": "file-bucket/download" } }
            }]
        }
        """)

        XCTAssertTrue(output.api.contains("FileDownloadHandle"))
    }

    func testGeneratesFileUploadHandle() throws {
        let output = try generate(from: """
        {
            "openrpc": "1.3.2",
            "info": { "title": "test", "version": "1.0.0" },
            "methods": [{
                "name": "api.getUpload",
                "params": [{ "name": "path", "required": true, "schema": { "type": "string" } }],
                "result": { "name": "Handle", "schema": { "x-blocks-transferable": "file-bucket/upload" } }
            }]
        }
        """)

        XCTAssertTrue(output.api.contains("FileUploadHandle"))
    }

    func testGeneratesOIDCClient() throws {
        let output = try generate(from: """
        {
            "openrpc": "1.3.2",
            "info": { "title": "test", "version": "1.0.0" },
            "methods": [{
                "name": "api.getOidcClient",
                "params": [],
                "result": { "name": "Handle", "schema": { "x-blocks-transferable": "oidc/client" } }
            }]
        }
        """)

        XCTAssertTrue(output.api.contains("-> OIDCClient"))
        XCTAssertTrue(output.api.contains("OIDCClient.fromJSON(descriptor, baseUrl: self.client.baseUrl, client: self.client)"))
    }

    // MARK: - Multiple Namespaces

    func testMultipleNamespacesPrefixMethodNames() throws {
        let output = try generate(from: """
        {
            "openrpc": "1.3.2",
            "info": { "title": "test", "version": "1.0.0" },
            "methods": [
                { "name": "posts.list", "params": [], "result": { "name": "PostsListResult", "schema": { "type": "array", "items": { "type": "string" } } } },
                { "name": "users.list", "params": [], "result": { "name": "UsersListResult", "schema": { "type": "array", "items": { "type": "string" } } } }
            ]
        }
        """)

        XCTAssertTrue(output.api.contains("public class Posts"), "Should emit Posts class")
        XCTAssertTrue(output.api.contains("public class Users"), "Should emit Users class")
        XCTAssertTrue(output.api.contains("func list()"), "Each class has its own list() — no prefix needed")
    }

    func testSingleNamespaceDoesNotPrefix() throws {
        let output = try generate(from: """
        {
            "openrpc": "1.3.2",
            "info": { "title": "test", "version": "1.0.0" },
            "methods": [
                { "name": "api.list", "params": [], "result": { "name": "ListResult", "schema": { "type": "array", "items": { "type": "string" } } } },
                { "name": "api.get", "params": [{ "name": "id", "required": true, "schema": { "type": "string" } }], "result": { "name": "GetResult", "schema": { "type": "string" } } }
            ]
        }
        """)

        XCTAssertTrue(output.api.contains("func list()"), "Single namespace should not prefix")
        XCTAssertTrue(output.api.contains("func get("), "Single namespace should not prefix")
    }

    // MARK: - No Force Unwraps

    func testNoForceUnwrapsInGeneratedCode() throws {
        let output = try generate(from: """
        {
            "openrpc": "1.3.2",
            "info": { "title": "test", "version": "1.0.0" },
            "methods": [
                { "name": "api.create", "params": [{ "name": "title", "required": true, "schema": { "type": "string" } }], "result": { "name": "Todo", "schema": { "type": "object", "properties": { "id": { "type": "string" } }, "required": ["id"] } } },
                { "name": "api.get", "params": [{ "name": "key", "required": true, "schema": { "type": "string" } }], "result": { "name": "R", "schema": { "oneOf": [{ "type": "string" }, { "type": "null" }] } } }
            ]
        }
        """)

        XCTAssertFalse(output.api.contains("!"), "Generated API should not contain force unwraps")
    }

    // MARK: - Nullable Discriminated Unions

    func testNullableDiscriminatedUnionGeneratesOptionalReturnType() throws {
        let output = try generate(from: """
        {
            "openrpc": "1.3.2",
            "info": { "title": "test", "version": "1.0.0" },
            "methods": [{
                "name": "api.getNotification",
                "params": [{ "name": "id", "required": true, "schema": { "type": "string" } }],
                "result": { "name": "GetNotificationResult", "schema": {
                    "oneOf": [
                        { "type": "object", "properties": { "type": { "type": "string", "enum": ["email"] }, "subject": { "type": "string" }, "body": { "type": "string" } }, "required": ["type", "subject", "body"] },
                        { "type": "object", "properties": { "type": { "type": "string", "enum": ["sms"] }, "message": { "type": "string" } }, "required": ["type", "message"] },
                        { "type": "null" }
                    ]
                }}
            }]
        }
        """)

        XCTAssertTrue(output.api.contains("-> GetNotification.Result?"), "Return type should be optional")
        XCTAssertTrue(output.api.contains("guard let result else { return nil }"), "Should return nil for null result")
        XCTAssertTrue(output.api.contains("case email(Email)"), "Should have email variant")
        XCTAssertTrue(output.api.contains("case sms(Sms)"), "Should have sms variant")
    }

    func testNullableDiscriminatedUnionInMapValue() throws {
        let output = try generate(from: """
        {
            "openrpc": "1.3.2",
            "info": { "title": "test", "version": "1.0.0" },
            "methods": [{
                "name": "api.updateAttributes",
                "params": [{ "name": "attributes", "required": true, "schema": { "type": "object", "additionalProperties": { "type": "string" } } }],
                "result": { "name": "UpdateAttributesResult", "schema": {
                    "type": "object",
                    "additionalProperties": {
                        "oneOf": [
                            { "type": "object", "properties": { "isUpdated": { "type": "boolean", "enum": [true] } }, "required": ["isUpdated"] },
                            { "type": "object", "properties": { "isUpdated": { "type": "boolean", "enum": [false] }, "nextStep": { "type": "object", "properties": { "name": { "type": "string" }, "destination": { "type": "string" } }, "required": ["name", "destination"] } }, "required": ["isUpdated", "nextStep"] },
                            { "type": "null" }
                        ]
                    }
                }}
            }]
        }
        """)

        XCTAssertTrue(output.api.contains("[String: UpdateAttributes.ResultValue?]"), "Map value type should be optional")
    }
}
