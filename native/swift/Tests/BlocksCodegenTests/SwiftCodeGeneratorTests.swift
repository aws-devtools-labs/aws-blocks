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

    private func generate(from json: String, optOut: Set<String> = []) throws -> GeneratedSources {
        let rpcModel = try OpenRPCParser(optOutNativePackages: optOut).parse(data: Data(json.utf8))
        let codegenModel = builder.build(from: rpcModel)
        return try generator.generate(from: codegenModel)
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
                "result": { "name": "Todo", "schema": {
                    "type": "object",
                    "properties": { "title": { "type": "string" }, "done": { "type": "boolean" } },
                    "required": ["title", "done"]
                }}
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

        XCTAssertTrue(output.api.contains("public final nonisolated class Api: Sendable {"))
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
                "result": { "name": "Ch", "schema": {
                    "x-blocks-transferable": "realtime/channel",
                    "x-blocks-type-args": [{ "type": "object",
                        "properties": { "x": { "type": "number" } },
                        "required": ["x"] }]
                }}
            }]
        }
        """)

        XCTAssertTrue(output.api.contains("RealtimeChannel<"))
    }

    /// A realtime result decodes through `RealtimeChannel`'s `Decodable`, so BlocksRuntime forms the message
    /// decoder: one formed here inherits MainActor default isolation and traps when the socket task calls it.
    func testRealtimeResultDecodesThroughTheRuntime() throws {
        let output = try generate(from: """
        {
            "openrpc": "1.3.2",
            "info": { "title": "test", "version": "1.0.0" },
            "methods": [{
                "name": "api.getChannel",
                "params": [],
                "result": { "name": "Ch", "schema": {
                    "x-blocks-transferable": "realtime/channel",
                    "x-blocks-type-args": [{ "type": "object",
                        "properties": { "x": { "type": "number" } },
                        "required": ["x"] }]
                }}
            }]
        }
        """)

        XCTAssertTrue(
            output.api.contains("return try JSONDecoder().decode(RealtimeChannel<GetChannel.ResultMessage>.self, from: result)"),
            "expected the channel to decode through Decodable, got:\n\(output.api)"
        )
        XCTAssertFalse(output.api.contains("{ data in"), "expected no message decoder in generated code, got:\n\(output.api)")
        XCTAssertFalse(output.api.contains("Invalid channel descriptor"), "expected Decodable to own descriptor errors, got:\n\(output.api)")
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
                { "name": "posts.list", "params": [],
                  "result": { "name": "PostsListResult",
                    "schema": { "type": "array", "items": { "type": "string" } } } },
                { "name": "users.list", "params": [],
                  "result": { "name": "UsersListResult",
                    "schema": { "type": "array", "items": { "type": "string" } } } }
            ]
        }
        """)

        XCTAssertTrue(output.api.contains("public final nonisolated class Posts: Sendable {"), "Should emit Posts class")
        XCTAssertTrue(output.api.contains("public final nonisolated class Users: Sendable {"), "Should emit Users class")
        XCTAssertTrue(output.api.contains("func list()"), "Each class has its own list() — no prefix needed")
    }

    func testSingleNamespaceDoesNotPrefix() throws {
        let output = try generate(from: """
        {
            "openrpc": "1.3.2",
            "info": { "title": "test", "version": "1.0.0" },
            "methods": [
                { "name": "api.list", "params": [],
                  "result": { "name": "ListResult",
                    "schema": { "type": "array", "items": { "type": "string" } } } },
                { "name": "api.get",
                  "params": [{ "name": "id", "required": true, "schema": { "type": "string" } }],
                  "result": { "name": "GetResult", "schema": { "type": "string" } } }
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
                { "name": "api.create",
                  "params": [{ "name": "title", "required": true, "schema": { "type": "string" } }],
                  "result": { "name": "Todo", "schema": { "type": "object",
                    "properties": { "id": { "type": "string" } }, "required": ["id"] } } },
                { "name": "api.get",
                  "params": [{ "name": "key", "required": true, "schema": { "type": "string" } }],
                  "result": { "name": "R",
                    "schema": { "oneOf": [{ "type": "string" }, { "type": "null" }] } } }
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
                        { "type": "object", "properties": {
                            "type": { "type": "string", "enum": ["email"] },
                            "subject": { "type": "string" },
                            "body": { "type": "string" }
                          }, "required": ["type", "subject", "body"] },
                        { "type": "object", "properties": {
                            "type": { "type": "string", "enum": ["sms"] },
                            "message": { "type": "string" }
                          }, "required": ["type", "message"] },
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
                            { "type": "object", "properties": {
                                "isUpdated": { "type": "boolean", "enum": [true] }
                              }, "required": ["isUpdated"] },
                            { "type": "object", "properties": {
                                "isUpdated": { "type": "boolean", "enum": [false] },
                                "nextStep": { "type": "object", "properties": {
                                    "name": { "type": "string" },
                                    "destination": { "type": "string" }
                                  }, "required": ["name", "destination"] }
                              }, "required": ["isUpdated", "nextStep"] },
                            { "type": "null" }
                        ]
                    }
                }}
            }]
        }
        """)

        XCTAssertTrue(output.api.contains("[String: UpdateAttributes.ResultValue?]"), "Map value type should be optional")
    }

    // MARK: - Unknown Transferable

    private func build(from json: String) throws -> CodegenModel {
        let rpcModel = try parser.parse(data: Data(json.utf8))
        return builder.build(from: rpcModel)
    }

    private let unboundSpec = """
    {
        "openrpc": "1.3.2",
        "info": { "title": "iot", "version": "1.0.0" },
        "methods": [{
            "name": "api.connectDevice",
            "params": [{ "name": "deviceId", "required": true, "schema": { "type": "string" } }],
            "result": { "name": "Link", "schema": {
                "x-blocks-transferable": "example-iot/device-link",
                "x-blocks-type-args": [{ "type": "object",
                    "properties": { "temperature": { "type": "number" } },
                    "required": ["temperature"] }]
            }}
        }]
    }
    """

    func testUnboundTransferableGeneratesFallback() throws {
        let output = try generate(from: unboundSpec)
        XCTAssertTrue(output.api.contains("-> BlocksRuntime.UnknownTransferable"), "unbound tag should return UnknownTransferable, got:\n\(output.api)")
        XCTAssertTrue(
            output.api.contains("BlocksRuntime.UnknownTransferable.fromJSON(descriptor, expectedTag: \"example-iot/device-link\")"),
            "unbound tag should hydrate via fromJSON with the declared tag, got:\n\(output.api)"
        )
        XCTAssertTrue(
            output.api.contains("guard let result else { throw RPCError(message: \"Unexpected null result for api.connectDevice\") }"),
            "a required (non-optional) result must throw on a null body, got:\n\(output.api)"
        )
        // The emitted code must declare the type the diagnostic names (Api.ConnectDevice.ResultMessage),
        // or that name would not resolve in the generated client.
        XCTAssertTrue(output.api.contains("public final nonisolated class Api: Sendable {"), "namespace class Api not emitted, got:\n\(output.api)")
        guard let opEnum = output.api.range(of: "public enum ConnectDevice {") else {
            return XCTFail("operation enum ConnectDevice not emitted, got:\n\(output.api)")
        }
        let body = output.api[opEnum.upperBound...]
        XCTAssertTrue(body.contains("public struct ResultMessage"), "type-arg model should be emitted under ConnectDevice")
    }

    func testUnboundTransferableEmitsDiagnostic() throws {
        let output = try generate(from: unboundSpec)
        let diagnostic = output.warnings.first { $0.contains("AWSBLOCKS-NATIVE-001") }
        XCTAssertEqual(
            diagnostic,
            "AWSBLOCKS-NATIVE-001: api.connectDevice returns unbound transferable "
                + "'example-iot/device-link' on swift; generated UnknownTransferable with type argument Api.ConnectDevice.ResultMessage."
        )
    }

    func testKnownTransferableTagsMapToConcreteTypesWithoutFallback() throws {
        let cases: [(tag: String, type: String)] = [
            ("realtime/channel", "RealtimeChannel<"),
            ("file-bucket/download", "FileDownloadHandle"),
            ("file-bucket/upload", "FileUploadHandle"),
            ("oidc/client", "OIDCClient")
        ]
        for testCase in cases {
            let json = """
            {
                "openrpc": "1.3.2",
                "info": { "title": "test", "version": "1.0.0" },
                "methods": [{
                    "name": "api.get",
                    "params": [],
                    "result": { "name": "R", "schema": { "x-blocks-transferable": "\(testCase.tag)" } }
                }]
            }
            """
            let model = try build(from: json)
            let output = try generator.generate(from: model)
            XCTAssertTrue(output.api.contains(testCase.type), "\(testCase.tag) should map to \(testCase.type), got:\n\(output.api)")
            XCTAssertFalse(output.api.contains("UnknownTransferable"), "\(testCase.tag) is bound and must not use the fallback")
            XCTAssertTrue(output.warnings.isEmpty, "\(testCase.tag) is bound and must not emit a diagnostic, got: \(output.warnings)")
        }
    }

    func testTransferableNestedInListStaysUntypedWithNoFallback() throws {
        let json = """
        {
            "openrpc": "1.3.2",
            "info": { "title": "test", "version": "1.0.0" },
            "methods": [{
                "name": "api.listDevices",
                "params": [],
                "result": { "name": "R", "schema": { "type": "array", "items": { "x-blocks-transferable": "example-iot/device-link" } } }
            }]
        }
        """
        let model = try build(from: json)
        let output = try generator.generate(from: model)
        XCTAssertFalse(output.api.contains("UnknownTransferable"), "a transferable nested in a list is out of scope, got:\n\(output.api)")
        XCTAssertTrue(output.api.contains("[JSONValue]"), "a nested unbound transferable keeps its prior JSONValue type, got:\n\(output.api)")
        XCTAssertTrue(output.warnings.isEmpty, "a nested transferable must not emit a diagnostic, got: \(output.warnings)")
    }

    func testTransferableParameterStaysUntypedWithNoFallback() throws {
        let json = """
        {
            "openrpc": "1.3.2",
            "info": { "title": "test", "version": "1.0.0" },
            "methods": [{
                "name": "api.attach",
                "params": [{ "name": "link", "required": true, "schema": { "x-blocks-transferable": "example-iot/device-link" } }],
                "result": { "name": "R", "schema": { "type": "string" } }
            }]
        }
        """
        let model = try build(from: json)
        let output = try generator.generate(from: model)
        XCTAssertTrue(output.api.contains("link: JSONValue"), "an unbound transferable parameter keeps its prior JSONValue type, got:\n\(output.api)")
        XCTAssertFalse(output.api.contains("UnknownTransferable"), "a transferable parameter is out of scope, got:\n\(output.api)")
        XCTAssertTrue(output.warnings.isEmpty, "a transferable parameter must not emit a diagnostic, got: \(output.warnings)")
    }

    func testTransferableInRecordFieldStaysUntypedWithNoFallback() throws {
        let json = """
        {
            "openrpc": "1.3.2",
            "info": { "title": "test", "version": "1.0.0" },
            "methods": [{
                "name": "api.getWrapper",
                "params": [],
                "result": { "name": "R", "schema": {
                    "type": "object",
                    "properties": { "link": { "x-blocks-transferable": "example-iot/device-link" } },
                    "required": ["link"]
                }}
            }]
        }
        """
        let model = try build(from: json)
        let output = try generator.generate(from: model)
        let all = output.api + "\n" + output.models
        XCTAssertTrue(all.contains("let link: JSONValue"), "an unbound transferable record field keeps its prior JSONValue type, got:\n\(all)")
        XCTAssertFalse(all.contains("UnknownTransferable"), "a transferable nested in a record is out of scope, got:\n\(all)")
        XCTAssertTrue(output.warnings.isEmpty, "a nested transferable must not emit a diagnostic, got: \(output.warnings)")
    }

    func testNullableTransferableResultStaysUntypedWithNoFallback() throws {
        let json = """
        {
            "openrpc": "1.3.2",
            "info": { "title": "test", "version": "1.0.0" },
            "methods": [{
                "name": "api.maybeLink",
                "params": [],
                "result": { "name": "R", "schema": { "oneOf": [
                    { "x-blocks-transferable": "example-iot/device-link" },
                    { "type": "null" }
                ] } }
            }]
        }
        """
        let model = try build(from: json)
        let output = try generator.generate(from: model)
        XCTAssertTrue(output.api.contains("-> JSONValue?"), "a nullable unbound transferable keeps its prior optional JSONValue type, got:\n\(output.api)")
        XCTAssertFalse(output.api.contains("UnknownTransferable"), "a transferable in a nullable container is out of scope, got:\n\(output.api)")
        XCTAssertTrue(output.warnings.isEmpty, "a nullable transferable must not emit a diagnostic, got: \(output.warnings)")
    }

    func testNullableBoundTransferableHydratesToOptionalConcreteType() throws {
        let json = """
        {
            "openrpc": "1.3.2",
            "info": { "title": "test", "version": "1.0.0" },
            "methods": [{
                "name": "api.maybeChannel",
                "params": [],
                "result": { "name": "R", "schema": { "oneOf": [
                    { "x-blocks-transferable": "realtime/channel", "x-blocks-type-args": [
                        { "type": "object", "properties": { "x": { "type": "number" } }, "required": ["x"] }
                    ] },
                    { "type": "null" }
                ] } }
            }]
        }
        """
        let output = try generate(from: json)
        XCTAssertTrue(
            output.api.contains("-> RealtimeChannel<MaybeChannel.ResultMessage>?"),
            "a nullable bound transferable keeps its concrete optional type, got:\n\(output.api)"
        )
        XCTAssertTrue(output.api.contains("guard let result else { return nil }"), "a nullable result returns nil for a null body, got:\n\(output.api)")
        XCTAssertTrue(
            output.api.contains("return try JSONDecoder().decode(RealtimeChannel<MaybeChannel.ResultMessage>.self, from: result)"),
            "a nullable bound channel hydrates through RealtimeChannel's Decodable, got:\n\(output.api)"
        )
        // A message decoder formed in generated code inherits MainActor default isolation and traps when the socket task calls it.
        XCTAssertFalse(output.api.contains("{ data in"), "generated code must not form the message decoder, got:\n\(output.api)")
    }

    func testEveryKnownTagResolvesToConcreteType() throws {
        // Iterates the set itself: a tag added without a concrete binding - the
        // drift that emits non-compiling client code - fails here.
        let expectedReturn: [String: String] = [
            "realtime/channel": "-> RealtimeChannel<",
            "file-bucket/download": "-> FileDownloadHandle",
            "file-bucket/upload": "-> FileUploadHandle",
            "oidc/client": "-> OIDCClient"
        ]
        let expectedBody: [String: String] = [
            "realtime/channel": "RealtimeChannel<",
            "file-bucket/download": "FileDownloadHandle.fromJSON(descriptor)",
            "file-bucket/upload": "FileUploadHandle.fromJSON(descriptor)",
            "oidc/client": "OIDCClient.fromJSON(descriptor"
        ]
        for tag in knownTransferableTags {
            guard let concreteReturn = expectedReturn[tag], let concreteBody = expectedBody[tag] else {
                return XCTFail("\(tag) is in knownTransferableTags but has no expected concrete return type")
            }
            let json = """
            {
                "openrpc": "1.3.2",
                "info": { "title": "test", "version": "1.0.0" },
                "methods": [{
                    "name": "api.get",
                    "params": [],
                    "result": { "name": "R", "schema": { "x-blocks-transferable": "\(tag)" } }
                }]
            }
            """
            let output = try generate(from: json)
            XCTAssertTrue(output.api.contains(concreteReturn), "\(tag) should resolve to \(concreteReturn)")
            XCTAssertTrue(
                output.api.contains(concreteBody),
                "\(tag) is bound but its hydration body does not construct \(concreteBody)"
            )
            XCTAssertFalse(
                output.api.contains("UnknownTransferable.fromJSON"),
                "\(tag) is bound but its hydration body fell through to the UnknownTransferable fallback"
            )
        }
    }

    func testUnboundTransferableEscapesTagInEmittedLiteral() throws {
        // Tag carries " and \ - the emitted literal must escape both, or the
        // generated Swift would break (and \( would become interpolation).
        let json = """
        {
            "openrpc": "1.3.2",
            "info": { "title": "test", "version": "1.0.0" },
            "methods": [{
                "name": "api.get",
                "params": [],
                "result": { "name": "R", "schema": { "x-blocks-transferable": "v/a\\"b\\\\c" } }
            }]
        }
        """
        let output = try generate(from: json)
        XCTAssertTrue(output.api.contains(#"expectedTag: "v/a\"b\\c""#), "tag was not escaped for the emitted literal, got:\n\(output.api)")

        // A newline or carriage return in the tag must be escaped too, or the emitted
        // literal would span lines and fail to compile.
        let crlf = try generate(from: """
        {
            "openrpc": "1.3.2",
            "info": { "title": "test", "version": "1.0.0" },
            "methods": [{
                "name": "api.get",
                "params": [],
                "result": { "name": "R", "schema": { "x-blocks-transferable": "v/a\\nb\\rc" } }
            }]
        }
        """)
        XCTAssertTrue(crlf.api.contains(#"expectedTag: "v/a\nb\rc""#), "newline/CR in tag was not escaped, got:\n\(crlf.api)")
    }

    func testDiagnosticNamesModelForCollectionTypeArgument() throws {
        let model = try build(from: """
        {
            "openrpc": "1.3.2",
            "info": { "title": "test", "version": "1.0.0" },
            "methods": [{
                "name": "api.listArg",
                "params": [],
                "result": { "name": "R", "schema": {
                    "x-blocks-transferable": "example-iot/device-link",
                    "x-blocks-type-args": [{ "type": "array", "items": {
                        "type": "object", "properties": { "x": { "type": "number" } }, "required": ["x"] } }]
                }}
            }]
        }
        """)
        let output = try generator.generate(from: model)
        let diagnostic = output.warnings.first { $0.contains("AWSBLOCKS-NATIVE-001") }
        XCTAssertTrue(diagnostic?.contains("with type argument Api.ListArg.ResultMessage") ?? false, "model not named: \(diagnostic ?? "nil")")
    }

    func testDiagnosticNamesModelForMapAndNullableTypeArguments() throws {
        // The diagnostic recurses through map (additionalProperties) and nullable
        // (oneOf [T, null]) type arguments to the underlying model name.
        let mapOutput = try generate(from: """
        {
            "openrpc": "1.3.2",
            "info": { "title": "test", "version": "1.0.0" },
            "methods": [{
                "name": "api.mapArg",
                "params": [],
                "result": { "name": "R", "schema": {
                    "x-blocks-transferable": "example-iot/device-link",
                    "x-blocks-type-args": [{ "type": "object", "additionalProperties": { "$ref": "#/components/schemas/Val" } }]
                }}
            }],
            "components": { "schemas": { "Val": { "type": "object", "properties": { "v": { "type": "string" } }, "required": ["v"] } } }
        }
        """)
        XCTAssertEqual(
            mapOutput.warnings.first { $0.contains("AWSBLOCKS-NATIVE-001") },
            "AWSBLOCKS-NATIVE-001: api.mapArg returns unbound transferable "
                + "'example-iot/device-link' on swift; generated UnknownTransferable with type argument Val."
        )
        let nullableOutput = try generate(from: """
        {
            "openrpc": "1.3.2",
            "info": { "title": "test", "version": "1.0.0" },
            "methods": [{
                "name": "api.nullArg",
                "params": [],
                "result": { "name": "R", "schema": {
                    "x-blocks-transferable": "example-iot/device-link",
                    "x-blocks-type-args": [{ "oneOf": [{ "$ref": "#/components/schemas/Inner" }, { "type": "null" }] }]
                }}
            }],
            "components": { "schemas": { "Inner": { "type": "object", "properties": { "v": { "type": "string" } }, "required": ["v"] } } }
        }
        """)
        XCTAssertEqual(
            nullableOutput.warnings.first { $0.contains("AWSBLOCKS-NATIVE-001") },
            "AWSBLOCKS-NATIVE-001: api.nullArg returns unbound transferable "
                + "'example-iot/device-link' on swift; generated UnknownTransferable with type argument Inner."
        )
    }

    func testRealtimeChannelReturnTypeQualifiesInlineTypeArg() throws {
        // The return type must match the body's qualified nested model, or the
        // generated client won't compile (cannot find type in scope).
        let output = try generate(from: """
        {
            "openrpc": "1.3.2",
            "info": { "title": "test", "version": "1.0.0" },
            "methods": [{
                "name": "api.getChannel",
                "params": [],
                "result": { "name": "R", "schema": {
                    "x-blocks-transferable": "realtime/channel",
                    "x-blocks-type-args": [{ "type": "object", "properties": { "x": { "type": "number" } }, "required": ["x"] }]
                }}
            }]
        }
        """)
        XCTAssertTrue(output.api.contains("-> RealtimeChannel<GetChannel.ResultMessage>"), "return type must qualify the nested type-arg, got:\n\(output.api)")
    }

    func testNestedOIDCClientDecodesAsItsDescriptorWithAWarning() throws {
        let output = try generate(from: """
        {
            "openrpc": "1.3.2",
            "info": { "title": "test", "version": "1.0.0" },
            "methods": [
                { "name": "auth.getSetup", "params": [], "result": { "name": "R", "schema": {
                    "type": "object", "properties": { "client": { "x-blocks-transferable": "oidc/client" } }, "required": ["client"]
                }}},
                { "name": "auth.getClient", "params": [], "result": { "name": "R", "schema": { "x-blocks-transferable": "oidc/client" } } }
            ]
        }
        """)
        XCTAssertTrue(output.api.contains("public let client: JSONValue"), "a nested oidc/client decodes as its descriptor, got:\n\(output.api)")
        XCTAssertTrue(output.api.contains("-> OIDCClient {"), "a direct oidc/client still hydrates, got:\n\(output.api)")
        XCTAssertEqual(output.warnings.filter { $0.contains("oidc/client") }, [
            "swift: auth.getSetup returns an oidc/client below the top level, which decodes as JSONValue; return it directly to get an OIDCClient."
        ])
    }

    // MARK: - OIDC Provider Enums

    private func oidcSpec(_ methods: String) -> String {
        """
        {
            "openrpc": "1.3.2",
            "info": { "title": "test", "version": "1.0.0" },
            "methods": [\(methods)]
        }
        """
    }

    func testTypedOIDCClientEmitsProviderEnumAndSignInOverload() throws {
        let output = try generate(from: oidcSpec("""
            { "name": "auth.getClient", "params": [], "result": { "name": "R", "schema": {
                "x-blocks-transferable": "oidc/client",
                "x-blocks-type-args": [{ "type": "string", "enum": ["google", "github", "my-sso"] }]
            }}}
        """))
        XCTAssertTrue(output.api.contains("public func getClient() async throws -> OIDCClient {"), "the client type is unchanged, got:\n\(output.api)")
        XCTAssertTrue(output.api.contains("""
            public enum GetClient {

                /// The providers `auth.getClient` signs in with.
                public enum Provider: String, CaseIterable, Codable, Sendable {
                    case google
                    case github
                    case mySso = "my-sso"
                }
            }
        """), "got:\n\(output.api)")
        XCTAssertTrue(output.api.contains("""
        extension BlocksRuntime.OIDCClient {
            /// Signs in with one of the providers `auth.getClient` returns a client for.
            public func signIn(
                provider: Auth.GetClient.Provider,
                relayTo: String,
                launcher: any BlocksRuntime.BrowserLauncher
            ) async throws -> BlocksRuntime.OIDCUser {
                try await signIn(provider: provider.rawValue, relayTo: relayTo, launcher: launcher)
            }
        }
        """), "got:\n\(output.api)")
        XCTAssertFalse(output.api.contains("ResultMessage"), "the type argument is not a channel message, got:\n\(output.api)")
        XCTAssertEqual(output.warnings, [])
    }

    func testOIDCClientWithoutAStringEnumTypeArgStaysUntyped() throws {
        let untypedArgs = [
            "",
            #", "x-blocks-type-args": [{ "type": "string" }]"#,
            #", "x-blocks-type-args": [{ "type": "object", "properties": { "x": { "type": "number" } } }]"#
        ]
        for typeArgs in untypedArgs {
            let output = try generate(from: oidcSpec("""
                { "name": "auth.getClient", "params": [], "result": { "name": "R", "schema": { "x-blocks-transferable": "oidc/client"\(typeArgs) } } }
            """))
            XCTAssertTrue(output.api.contains("-> OIDCClient {"), "got:\n\(output.api)")
            XCTAssertFalse(output.api.contains("public enum GetClient"), "no nested types for \(typeArgs), got:\n\(output.api)")
            XCTAssertFalse(output.api.contains("extension BlocksRuntime.OIDCClient"), "no overload for \(typeArgs), got:\n\(output.api)")
        }
    }

    func testOptionalTypedOIDCClientKeepsItsProviderEnum() throws {
        let output = try generate(from: oidcSpec("""
            { "name": "auth.findClient", "params": [], "result": { "name": "R", "schema": { "oneOf": [
                { "x-blocks-transferable": "oidc/client", "x-blocks-type-args": [{ "type": "string", "enum": ["google"] }] },
                { "type": "null" }
            ]}}}
        """))
        XCTAssertTrue(output.api.contains("-> OIDCClient? {"), "got:\n\(output.api)")
        XCTAssertTrue(output.api.contains("provider: Auth.FindClient.Provider,"), "got:\n\(output.api)")
    }

    func testNestedTypedOIDCClientHasNoProviderEnum() throws {
        let output = try generate(from: oidcSpec("""
            { "name": "auth.getSetup", "params": [], "result": { "name": "R", "schema": {
                "type": "object", "properties": { "client": {
                    "x-blocks-transferable": "oidc/client",
                    "x-blocks-type-args": [{ "type": "string", "enum": ["google"] }]
                }}, "required": ["client"]
            }}}
        """))
        XCTAssertTrue(output.api.contains("public let client: JSONValue"), "got:\n\(output.api)")
        XCTAssertFalse(output.api.contains("Provider"), "a client that decodes as JSONValue gets no provider enum, got:\n\(output.api)")
        XCTAssertFalse(output.api.contains("extension BlocksRuntime.OIDCClient"), "got:\n\(output.api)")
    }

    func testProviderCaseNamesAreLegalSwift() throws {
        let output = try generate(from: oidcSpec("""
            { "name": "auth.getClient", "params": [], "result": { "name": "R", "schema": {
                "x-blocks-transferable": "oidc/client",
                "x-blocks-type-args": [{ "type": "string", "enum": ["default", "1password", "Google", "google", "my-sso", "my-sso", "+"] }]
            }}}
        """))
        XCTAssertTrue(output.api.contains("""
                public enum Provider: String, CaseIterable, Codable, Sendable {
                    case `default`
                    case _1password = "1password"
                    case google = "Google"
                    case google2 = "google"
                    case mySso = "my-sso"
                    case _unnamed = "+"
                }
        """), "got:\n\(output.api)")
    }

    func testProviderEnumNameAvoidsAParameterType() throws {
        let output = try generate(from: oidcSpec("""
            { "name": "auth.getClient", "params": [
                { "name": "provider", "required": true, "schema": { "type": "string", "enum": ["a", "b"] } }
            ], "result": { "name": "R", "schema": {
                "x-blocks-transferable": "oidc/client",
                "x-blocks-type-args": [{ "type": "string", "enum": ["google"] }]
            }}}
        """))
        XCTAssertTrue(output.api.contains("public func getClient(provider: GetClient.Provider) async throws -> OIDCClient {"), "got:\n\(output.api)")
        XCTAssertTrue(output.api.contains("public enum ResultProvider: String, CaseIterable, Codable, Sendable {"), "got:\n\(output.api)")
        XCTAssertTrue(output.api.contains("provider: Auth.GetClient.ResultProvider,"), "got:\n\(output.api)")
        XCTAssertEqual(output.warnings, [
            "swift: auth.getClient names its providers Auth.GetClient.ResultProvider, since its operation already declares or uses a type named Provider."
        ])
    }

    func testProviderEnumNameAvoidsVariantStructsAndModels() throws {
        let typedClient = #"{ "x-blocks-transferable": "oidc/client", "x-blocks-type-args": [{ "type": "string", "enum": ["google"] }] }"#
        // A root union's variant structs share the operation enum with the provider enum.
        let variants = try generate(from: oidcSpec("""
            { "name": "auth.getClient", "params": [
                { "name": "via", "required": true, "schema": { "oneOf": [
                    { "type": "object", "required": ["kind", "name"],
                      "properties": { "kind": { "type": "string", "enum": ["provider"] }, "name": { "type": "string" } } },
                    { "type": "object", "required": ["kind", "pw"],
                      "properties": { "kind": { "type": "string", "enum": ["password"] }, "pw": { "type": "string" } } }
                ]}}
            ], "result": { "name": "R", "schema": \(typedClient) } }
        """))
        XCTAssertTrue(variants.api.contains("public struct Provider: Codable {"), "got:\n\(variants.api)")
        XCTAssertTrue(variants.api.contains("public enum ResultProvider: String, CaseIterable, Codable, Sendable {"), "got:\n\(variants.api)")
        // A nested type naming the `Provider` model must not resolve to the provider enum.
        let model = try generate(from: """
        {
            "openrpc": "1.3.2",
            "info": { "title": "test", "version": "1.0.0" },
            "methods": [{ "name": "auth.getClient", "params": [
                { "name": "options", "required": true, "schema": {
                    "type": "object", "properties": { "via": { "$ref": "#/components/schemas/Provider" } }, "required": ["via"]
                }}
            ], "result": { "name": "R", "schema": \(typedClient) } }],
            "components": { "schemas": { "Provider": { "type": "object", "properties": { "id": { "type": "string" } }, "required": ["id"] } } }
        }
        """)
        XCTAssertTrue(model.api.contains("public enum ResultProvider: String, CaseIterable, Codable, Sendable {"), "got:\n\(model.api)")
        XCTAssertFalse(model.api.contains("public enum Provider: String"), "got:\n\(model.api)")
        // With no other types in the operation enum, nothing there can name the model, so the enum keeps its name.
        let unshadowed = try generate(from: """
        {
            "openrpc": "1.3.2",
            "info": { "title": "test", "version": "1.0.0" },
            "methods": [
                { "name": "auth.getClient", "params": [], "result": { "name": "R", "schema": \(typedClient) } },
                { "name": "api.listProviders", "params": [], "result": { "name": "R", "schema": {
                    "type": "array", "items": { "$ref": "#/components/schemas/Provider" }
                }}}
            ],
            "components": { "schemas": { "Provider": { "type": "object", "properties": { "id": { "type": "string" } }, "required": ["id"] } } }
        }
        """)
        XCTAssertTrue(unshadowed.api.contains("provider: Auth.GetClient.Provider,"), "got:\n\(unshadowed.api)")
        XCTAssertTrue(unshadowed.models.contains("public nonisolated struct Provider: Codable {"), "got:\n\(unshadowed.models)")
        XCTAssertEqual(unshadowed.warnings, [])
    }

    func testTypedOIDCClientInAModelHasNoProviderEnum() throws {
        let output = try generate(from: """
        {
            "openrpc": "1.3.2",
            "info": { "title": "test", "version": "1.0.0" },
            "methods": [{ "name": "auth.getSetup", "params": [], "result": { "name": "R", "schema": { "$ref": "#/components/schemas/Setup" } } }],
            "components": { "schemas": { "Setup": { "type": "object", "properties": { "client": {
                "x-blocks-transferable": "oidc/client",
                "x-blocks-type-args": [{ "type": "string", "enum": ["google"] }]
            }}, "required": ["client"] } } }
        }
        """)
        XCTAssertTrue(output.models.contains("public let client: JSONValue"), "got:\n\(output.models)")
        XCTAssertFalse(output.models.contains("enum"), "a client in a model gets no provider enum, got:\n\(output.models)")
        XCTAssertFalse(output.api.contains("Provider"), "got:\n\(output.api)")
    }

    func testDefaultNamespaceProviderEnumIsQualifiedByItsClass() throws {
        let output = try generate(from: oidcSpec("""
            { "name": "getClient", "params": [], "result": { "name": "R", "schema": {
                "x-blocks-transferable": "oidc/client",
                "x-blocks-type-args": [{ "type": "string", "enum": ["google"] }]
            }}}
        """))
        XCTAssertTrue(output.api.contains("/// The providers `getClient` signs in with."), "got:\n\(output.api)")
        XCTAssertTrue(output.api.contains("provider: _Default.GetClient.Provider,"), "got:\n\(output.api)")
    }

    func testUnboundTransferableDiagnosticQualifiesDefaultNamespace() throws {
        // A non-namespaced method nests under `_Default`; the diagnostic must
        // name that class, or the printed type is unusable from app scope.
        let spec = """
        {
            "openrpc": "1.3.2",
            "info": { "title": "test", "version": "1.0.0" },
            "methods": [{
                "name": "connectDevice",
                "params": [],
                "result": { "name": "R", "schema": {
                    "x-blocks-transferable": "example-iot/device-link",
                    "x-blocks-type-args": [{ "type": "object", "properties": { "temp": { "type": "number" } }, "required": ["temp"] }]
                }}
            }]
        }
        """
        let model = try build(from: spec)
        let output = try generator.generate(from: model)
        XCTAssertTrue(output.api.contains("public final nonisolated class _Default: Sendable {"), "expected _Default class, got:\n\(output.api)")
        let diagnostic = output.warnings.first { $0.contains("AWSBLOCKS-NATIVE-001") }
        XCTAssertEqual(
            diagnostic,
            "AWSBLOCKS-NATIVE-001: connectDevice returns unbound transferable "
                + "'example-iot/device-link' on swift; generated UnknownTransferable with type argument _Default.ConnectDevice.ResultMessage."
        )
    }

    func testUnboundTransferableDiagnosticNamesRefTypeArgAtTopLevel() throws {
        // A $ref type argument resolves to a top-level generated type, so the
        // diagnostic names it bare (not namespace-prefixed), unlike an inline nested type.
        let output = try generate(from: """
        {
            "openrpc": "1.3.2",
            "info": { "title": "test", "version": "1.0.0" },
            "methods": [{
                "name": "api.getTelemetry",
                "params": [],
                "result": { "name": "R", "schema": {
                    "x-blocks-transferable": "example-iot/device-link",
                    "x-blocks-type-args": [{ "$ref": "#/components/schemas/Telemetry" }]
                }}
            }],
            "components": {
                "schemas": {
                    "Telemetry": { "type": "object", "properties": { "temp": { "type": "number" } }, "required": ["temp"] }
                }
            }
        }
        """)
        XCTAssertTrue(
            output.models.contains("public nonisolated struct Telemetry"),
            "the $ref type-arg must be a resolvable top-level type, got:\n\(output.models)"
        )
        let diagnostic = output.warnings.first { $0.contains("AWSBLOCKS-NATIVE-001") }
        XCTAssertEqual(
            diagnostic,
            "AWSBLOCKS-NATIVE-001: api.getTelemetry returns unbound transferable "
                + "'example-iot/device-link' on swift; generated UnknownTransferable with type argument Telemetry."
        )
    }

    func testUnboundTransferableDiagnosticReportsNoModelsForPrimitiveTypeArg() throws {
        let output = try generate(from: """
        {
            "openrpc": "1.3.2",
            "info": { "title": "test", "version": "1.0.0" },
            "methods": [{
                "name": "api.getRaw",
                "params": [],
                "result": { "name": "R", "schema": {
                    "x-blocks-transferable": "example-iot/device-link",
                    "x-blocks-type-args": [{ "type": "string" }]
                }}
            }]
        }
        """)
        let diagnostic = output.warnings.first { $0.contains("AWSBLOCKS-NATIVE-001") }
        XCTAssertEqual(
            diagnostic,
            "AWSBLOCKS-NATIVE-001: api.getRaw returns unbound transferable "
                + "'example-iot/device-link' on swift; generated UnknownTransferable with no generated type-argument models."
        )
    }

    func testUnboundTransferableDiagnosticListsMultipleTypeArgModels() throws {
        let output = try generate(from: """
        {
            "openrpc": "1.3.2",
            "info": { "title": "test", "version": "1.0.0" },
            "methods": [{
                "name": "api.multi",
                "params": [],
                "result": { "name": "R", "schema": {
                    "x-blocks-transferable": "example-iot/device-link",
                    "x-blocks-type-args": [
                        { "$ref": "#/components/schemas/Foo" },
                        { "$ref": "#/components/schemas/Bar" }
                    ]
                }}
            }],
            "components": { "schemas": {
                "Foo": { "type": "object", "properties": { "a": { "type": "string" } }, "required": ["a"] },
                "Bar": { "type": "object", "properties": { "b": { "type": "string" } }, "required": ["b"] }
            } }
        }
        """)
        let diagnostic = output.warnings.first { $0.contains("AWSBLOCKS-NATIVE-001") }
        XCTAssertEqual(
            diagnostic,
            "AWSBLOCKS-NATIVE-001: api.multi returns unbound transferable "
                + "'example-iot/device-link' on swift; generated UnknownTransferable with type arguments Foo, Bar."
        )
    }
}
