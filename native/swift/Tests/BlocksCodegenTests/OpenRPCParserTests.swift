//
// Copyright Amazon.com Inc. or its affiliates.
// All Rights Reserved.
//
// SPDX-License-Identifier: Apache-2.0
//

import XCTest
@testable import BlocksCodegen

final class OpenRPCParserTests: XCTestCase {
    let parser = OpenRPCParser()

    // MARK: - Basic Parsing

    func testParsesSimpleMethod() throws {
        let spec = Data("""
        {
            "openrpc": "1.3.2",
            "info": { "title": "test", "version": "1.0.0" },
            "methods": [{
                "name": "api.greet",
                "params": [{ "name": "name", "required": true, "schema": { "type": "string" } }],
                "result": { "name": "GreetResult", "schema": { "type": "object", "properties": { "message": { "type": "string" } }, "required": ["message"] } }
            }]
        }
        """.utf8)

        let model = try parser.parse(data: spec)
        XCTAssertEqual(model.methods.count, 1)
        XCTAssertEqual(model.methods[0].name, "api.greet")
        XCTAssertEqual(model.methods[0].params.count, 1)
        XCTAssertEqual(model.methods[0].params[0].name, "name")
        XCTAssertTrue(model.methods[0].params[0].required)
    }

    func testParsesComponentSchemas() throws {
        let spec = Data("""
        {
            "openrpc": "1.3.2",
            "info": { "title": "test", "version": "1.0.0" },
            "methods": [],
            "components": {
                "schemas": {
                    "Todo": {
                        "type": "object",
                        "properties": { "title": { "type": "string" }, "done": { "type": "boolean" } },
                        "required": ["title", "done"]
                    }
                }
            }
        }
        """.utf8)

        let model = try parser.parse(data: spec)
        XCTAssertEqual(model.componentSchemas.count, 1)
        XCTAssertNotNil(model.componentSchemas["Todo"])
    }

    // MARK: - Format Handling

    func testParsesUUIDFormat() throws {
        let spec = Data("""
        {
            "openrpc": "1.3.2",
            "info": { "title": "test", "version": "1.0.0" },
            "methods": [{
                "name": "api.get",
                "params": [{ "name": "id", "required": true, "schema": { "type": "string", "format": "uuid" } }],
                "result": { "name": "Result", "schema": { "type": "string" } }
            }]
        }
        """.utf8)

        let model = try parser.parse(data: spec)
        if case .primitive(let kind, let constraints) = model.methods[0].params[0].schema {
            XCTAssertEqual(kind, .string)
            XCTAssertEqual(constraints.format, "uuid")
        } else {
            XCTFail("Expected primitive string with format=uuid")
        }
    }

    func testParsesDateTimeFormat() throws {
        let spec = Data("""
        {
            "openrpc": "1.3.2",
            "info": { "title": "test", "version": "1.0.0" },
            "methods": [{
                "name": "api.get",
                "params": [{ "name": "ts", "required": true, "schema": { "type": "string", "format": "date-time" } }],
                "result": { "name": "Result", "schema": { "type": "string" } }
            }]
        }
        """.utf8)

        let model = try parser.parse(data: spec)
        // Parser surfaces format-bearing strings as `.primitive(.string)` with
        // the `format` carried in `Constraints`. The builder later promotes
        // these to `ResolvedType.formattedType(...)` — see CodegenModelBuilderTests.
        if case .primitive(let kind, let constraints) = model.methods[0].params[0].schema {
            XCTAssertEqual(kind, .string)
            XCTAssertEqual(constraints.format, "date-time")
        } else {
            XCTFail("Expected primitive string with format=date-time")
        }
    }

    func testParsesURIFormat() throws {
        let spec = Data("""
        {
            "openrpc": "1.3.2",
            "info": { "title": "test", "version": "1.0.0" },
            "methods": [{
                "name": "api.get",
                "params": [{ "name": "link", "required": true, "schema": { "type": "string", "format": "uri" } }],
                "result": { "name": "Result", "schema": { "type": "string" } }
            }]
        }
        """.utf8)

        let model = try parser.parse(data: spec)
        if case .primitive(let kind, let constraints) = model.methods[0].params[0].schema {
            XCTAssertEqual(kind, .string)
            XCTAssertEqual(constraints.format, "uri")
        } else {
            XCTFail("Expected primitive string with format=uri")
        }
    }

    // MARK: - Record/Map Type

    func testParsesRecordType() throws {
        let spec = Data("""
        {
            "openrpc": "1.3.2",
            "info": { "title": "test", "version": "1.0.0" },
            "methods": [{
                "name": "api.getScores",
                "params": [],
                "result": { "name": "Scores", "schema": { "type": "object", "additionalProperties": { "type": "number" } } }
            }]
        }
        """.utf8)

        let model = try parser.parse(data: spec)
        if case .mapType(let valueType) = model.methods[0].result!.schema {
            if case .primitive(let kind, _) = valueType {
                XCTAssertEqual(kind, .number)
            } else {
                XCTFail("Expected primitive number as map value")
            }
        } else {
            XCTFail("Expected mapType")
        }
    }

    // MARK: - Nullable

    func testParsesNullableOneOf() throws {
        let spec = Data("""
        {
            "openrpc": "1.3.2",
            "info": { "title": "test", "version": "1.0.0" },
            "methods": [{
                "name": "api.get",
                "params": [{ "name": "val", "required": true, "schema": { "oneOf": [{ "type": "string" }, { "type": "null" }] } }],
                "result": { "name": "Result", "schema": { "type": "string" } }
            }]
        }
        """.utf8)

        let model = try parser.parse(data: spec)
        if case .nullable(let inner) = model.methods[0].params[0].schema {
            if case .primitive(let kind, _) = inner {
                XCTAssertEqual(kind, .string)
            } else {
                XCTFail("Expected primitive string inside nullable")
            }
        } else {
            XCTFail("Expected nullable")
        }
    }

    // MARK: - anyOf

    func testParsesAnyOfAsUnion() throws {
        let spec = Data("""
        {
            "openrpc": "1.3.2",
            "info": { "title": "test", "version": "1.0.0" },
            "methods": [{
                "name": "api.get",
                "params": [{ "name": "val", "required": true, "schema": { "anyOf": [{ "type": "string" }, { "type": "number" }] } }],
                "result": { "name": "Result", "schema": { "type": "string" } }
            }]
        }
        """.utf8)

        let model = try parser.parse(data: spec)
        if case .union(let members) = model.methods[0].params[0].schema {
            XCTAssertEqual(members.count, 2)
        } else {
            XCTFail("Expected union")
        }
    }

    // MARK: - const + tuple support
    //
    // `const` and multi-element `prefixItems` were previously rejected with
    // `CodegenError.unsupportedSchema`; they are
    // now first-class. `z.literal("foo")` collapses to a single-value enum
    // (so it can participate in discriminator detection); a multi-element
    // `prefixItems` array becomes an `inlineObject` with positional fields.

    func testParsesConstAsSingleValueEnum() throws {
        let spec = Data("""
        {
            "openrpc": "1.3.2",
            "info": { "title": "test", "version": "1.0.0" },
            "methods": [{
                "name": "api.get",
                "params": [{ "name": "val", "required": true, "schema": { "const": "foo" } }],
                "result": { "name": "Result", "schema": { "type": "string" } }
            }]
        }
        """.utf8)

        let model = try parser.parse(data: spec)
        if case .unionLiteral(let values) = model.methods[0].params[0].schema {
            XCTAssertEqual(values, ["foo"])
        } else {
            XCTFail("Expected unionLiteral([\"foo\"]) for const")
        }
    }

    func testParsesMultiPrefixItemsAsTupleObject() throws {
        let spec = Data("""
        {
            "openrpc": "1.3.2",
            "info": { "title": "test", "version": "1.0.0" },
            "methods": [{
                "name": "api.get",
                "params": [{ "name": "val", "required": true, "schema": { "prefixItems": [{ "type": "string" }, { "type": "number" }] } }],
                "result": { "name": "Result", "schema": { "type": "string" } }
            }]
        }
        """.utf8)

        let model = try parser.parse(data: spec)
        if case .inlineObject(let fields, _, _) = model.methods[0].params[0].schema {
            XCTAssertEqual(fields.count, 2)
            XCTAssertEqual(fields.map { $0.name }, ["item0", "item1"])
        } else {
            XCTFail("Expected inlineObject with positional fields for multi-element tuple")
        }
    }

    func testSinglePrefixItemTreatedAsArray() throws {
        let spec = Data("""
        {
            "openrpc": "1.3.2",
            "info": { "title": "test", "version": "1.0.0" },
            "methods": [{
                "name": "api.get",
                "params": [{ "name": "val", "required": true, "schema": { "prefixItems": [{ "type": "string" }] } }],
                "result": { "name": "Result", "schema": { "type": "string" } }
            }]
        }
        """.utf8)

        let model = try parser.parse(data: spec)
        if case .arrayType(let elementType, _) = model.methods[0].params[0].schema {
            if case .primitive(let kind, _) = elementType {
                XCTAssertEqual(kind, .string)
            } else {
                XCTFail("Expected primitive string as array element")
            }
        } else {
            XCTFail("Expected arrayType")
        }
    }

    // MARK: - Transferable

    func testParsesTransferable() throws {
        let spec = Data("""
        {
            "openrpc": "1.3.2",
            "info": { "title": "test", "version": "1.0.0" },
            "methods": [{
                "name": "api.getChannel",
                "params": [],
                "result": {
                    "name": "Channel",
                    "schema": {
                        "x-blocks-transferable": "realtime/channel",
                        "x-blocks-type-args": [{
                            "type": "object",
                            "properties": { "x": { "type": "number" } },
                            "required": ["x"]
                        }]
                    }
                }
            }]
        }
        """.utf8)

        let model = try parser.parse(data: spec)
        if case .transferable(let kind, let args) = model.methods[0].result!.schema {
            XCTAssertEqual(kind, "realtime/channel")
            XCTAssertEqual(args.count, 1)
        } else {
            XCTFail("Expected transferable")
        }
    }
}
