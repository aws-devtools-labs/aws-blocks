//
// Copyright Amazon.com Inc. or its affiliates.
// All Rights Reserved.
//
// SPDX-License-Identifier: Apache-2.0
//

import XCTest
@testable import BlocksCodegen

/// Coverage for the constraint / format-type / default-value / const / tuple
/// Constraint and default-value tests. These assert the IR
/// shape and the generated Swift output against fixture specs.
final class ConstraintsAndDefaultsTests: XCTestCase {

    private func generate(_ spec: String) throws -> (models: String, api: String) {
        let data = Data(spec.utf8)
        let rpcModel = try OpenRPCParser().parse(data: data)
        let codegen = CodegenModelBuilder().build(from: rpcModel)
        return SwiftCodeGenerator().generate(from: codegen)
    }

    private func allOutput(_ spec: String) throws -> String {
        let out = try generate(spec)
        return out.models + "\n" + out.api
    }

    func testFormatStringMappedToFoundationType() throws {
        let spec = """
        {
            "openrpc": "1.3.2",
            "info": { "title": "test", "version": "1.0.0" },
            "methods": [{
                "name": "api.get",
                "params": [{ "name": "input", "required": true, "schema": {
                    "type": "object",
                    "properties": {
                        "id": { "type": "string", "format": "uuid" },
                        "ts": { "type": "string", "format": "date-time" },
                        "url": { "type": "string", "format": "uri" }
                    },
                    "required": ["id", "ts", "url"]
                }}],
                "result": { "name": "GetResult", "schema": { "type": "object", "properties": { "ok": { "type": "boolean" } }, "required": ["ok"] } }
            }]
        }
        """

        let all = try allOutput(spec)
        XCTAssertTrue(all.contains("let id: UUID"))
        XCTAssertTrue(all.contains("let ts: Date"))
        XCTAssertTrue(all.contains("let url: URL"))
    }

    func testStringConstraintsEmitPreconditions() throws {
        let spec = """
        {
            "openrpc": "1.3.2",
            "info": { "title": "test", "version": "1.0.0" },
            "methods": [{
                "name": "api.signUp",
                "params": [{ "name": "input", "required": true, "schema": {
                    "type": "object",
                    "properties": { "email": { "type": "string", "minLength": 5, "maxLength": 254 } },
                    "required": ["email"]
                }}],
                "result": { "name": "SignUpResult", "schema": { "type": "boolean" } }
            }]
        }
        """

        let all = try allOutput(spec)
        XCTAssertTrue(all.contains("guard email.count >= 5"),
                      "Should emit minLength guard")
        XCTAssertTrue(all.contains("guard email.count <= 254"),
                      "Should emit maxLength guard")
    }

    func testNumericConstraintsEmitPreconditions() throws {
        let spec = """
        {
            "openrpc": "1.3.2",
            "info": { "title": "test", "version": "1.0.0" },
            "methods": [{
                "name": "api.score",
                "params": [{ "name": "input", "required": true, "schema": {
                    "type": "object",
                    "properties": {
                        "v": { "type": "integer", "minimum": 1, "maximum": 100 }
                    },
                    "required": ["v"]
                }}],
                "result": { "name": "ScoreResult", "schema": { "type": "boolean" } }
            }]
        }
        """

        let all = try allOutput(spec)
        XCTAssertTrue(all.contains("guard v >= 1"))
        XCTAssertTrue(all.contains("guard v <= 100"))
    }

    func testDefaultValuesRenderedAsSwiftLiterals() throws {
        let spec = """
        {
            "openrpc": "1.3.2",
            "info": { "title": "test", "version": "1.0.0" },
            "methods": [{
                "name": "api.create",
                "params": [{ "name": "input", "required": true, "schema": {
                    "type": "object",
                    "properties": {
                        "role":   { "type": "string", "default": "viewer" },
                        "active": { "type": "boolean", "default": true },
                        "max":    { "type": "integer", "default": 5 }
                    }
                }}],
                "result": { "name": "CreateResult", "schema": { "type": "boolean" } }
            }]
        }
        """

        let all = try allOutput(spec)
        XCTAssertTrue(all.contains("role: String? = \"viewer\""))
        XCTAssertTrue(all.contains("active: Bool? = true"))
        XCTAssertTrue(all.contains("max: Int? = 5"))
    }

    func testConstParsesAsSingleValueEnum() throws {
        let spec = """
        {
            "openrpc": "1.3.2",
            "info": { "title": "test", "version": "1.0.0" },
            "methods": [{
                "name": "api.get",
                "params": [{ "name": "input", "required": true, "schema": {
                    "type": "object",
                    "properties": { "tier": { "const": "premium" } },
                    "required": ["tier"]
                }}],
                "result": { "name": "GetResult", "schema": { "type": "boolean" } }
            }]
        }
        """

        let all = try allOutput(spec)
        // Const renders as a single-value enum on the field's nested type.
        XCTAssertTrue(all.contains("case premium"),
                      "Const value should appear as an enum case")
    }

    func testMultiPrefixItemsEmitsPositionalFields() throws {
        let spec = """
        {
            "openrpc": "1.3.2",
            "info": { "title": "test", "version": "1.0.0" },
            "methods": [{
                "name": "api.coords",
                "params": [{ "name": "input", "required": true, "schema": {
                    "prefixItems": [
                        { "type": "number" },
                        { "type": "number" }
                    ]
                }}],
                "result": { "name": "CoordsResult", "schema": { "type": "boolean" } }
            }]
        }
        """

        let all = try allOutput(spec)
        XCTAssertTrue(all.contains("let item0: Double"),
                      "Tuple should produce positional field item0")
        XCTAssertTrue(all.contains("let item1: Double"),
                      "Tuple should produce positional field item1")
    }

    func testListMinMaxItemsEmitsPreconditions() throws {
        let spec = """
        {
            "openrpc": "1.3.2",
            "info": { "title": "test", "version": "1.0.0" },
            "methods": [{
                "name": "api.tags",
                "params": [{ "name": "input", "required": true, "schema": {
                    "type": "object",
                    "properties": {
                        "tags": { "type": "array", "items": { "type": "string" }, "minItems": 1, "maxItems": 10 }
                    },
                    "required": ["tags"]
                }}],
                "result": { "name": "TagsResult", "schema": { "type": "boolean" } }
            }]
        }
        """

        let all = try allOutput(spec)
        XCTAssertTrue(all.contains("guard tags.count >= 1"))
        XCTAssertTrue(all.contains("guard tags.count <= 10"))
    }

    func testPatternConstraintEmitsPrecondition() throws {
        let spec = """
        {
            "openrpc": "1.3.2",
            "info": { "title": "test", "version": "1.0.0" },
            "methods": [{
                "name": "api.create",
                "params": [{ "name": "input", "required": true, "schema": {
                    "type": "object",
                    "properties": {
                        "code": { "type": "string", "pattern": "^[A-Z]{3}$" }
                    },
                    "required": ["code"]
                }}],
                "result": { "name": "CreateResult", "schema": { "type": "boolean" } }
            }]
        }
        """

        let all = try allOutput(spec)
        XCTAssertTrue(all.contains("range(of: \"^[A-Z]{3}$\", options: .regularExpression)"),
                      "Should emit pattern validation using range(of:options:)")
    }

    func testOptionalPatternConstraintEmitsPrecondition() throws {
        let spec = """
        {
            "openrpc": "1.3.2",
            "info": { "title": "test", "version": "1.0.0" },
            "methods": [{
                "name": "api.create",
                "params": [{ "name": "input", "required": true, "schema": {
                    "type": "object",
                    "properties": {
                        "tag": { "type": "string", "pattern": "^[a-z]+$" }
                    }
                }}],
                "result": { "name": "CreateResult", "schema": { "type": "boolean" } }
            }]
        }
        """

        let all = try allOutput(spec)
        XCTAssertTrue(all.contains("if let v = tag"),
                      "Optional field should unwrap before validation")
        XCTAssertTrue(all.contains("v.range(of: \"^[a-z]+$\", options: .regularExpression)"),
                      "Should validate unwrapped optional against pattern")
    }
}
