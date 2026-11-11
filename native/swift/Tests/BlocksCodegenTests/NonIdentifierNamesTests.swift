//
// Copyright Amazon.com Inc. or its affiliates.
// All Rights Reserved.
//
// SPDX-License-Identifier: Apache-2.0
//

import XCTest
@testable import BlocksCodegen

/// Names the spec supplies reach generated code only as sanitized identifiers or escaped literals.
final class NonIdentifierNamesTests: XCTestCase {

    private var fixtureSpecURL: URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("codegen-fixtures/29-non-identifier-names/spec.json")
    }

    private func generate(_ data: Data) throws -> GeneratedSources {
        let rpcModel = try OpenRPCParser().parse(data: data)
        return try SwiftCodeGenerator().generate(from: CodegenModelBuilder().build(from: rpcModel))
    }

    private func generate(_ json: String) throws -> GeneratedSources {
        try generate(Data(json.utf8))
    }

    /// `source` with every string literal and comment removed, which leaves only the code a spec
    /// name could have reached as an identifier.
    private func codeOnly(_ source: String) -> String {
        var out = ""
        var chars = Array(source)[...]
        while let char = chars.first {
            if chars.starts(with: "//") {
                chars = chars.drop { $0 != "\n" }
            } else if char == "\"" {
                chars = chars.dropFirst()
                var depth = 0
                while let next = chars.first, next != "\"" || depth > 0 {
                    if chars.starts(with: "\\(") {
                        depth += 1
                        chars = chars.dropFirst(2)
                    } else if next == "\\" {
                        chars = chars.dropFirst(2)
                    } else {
                        if depth > 0 && next == ")" { depth -= 1 }
                        chars = chars.dropFirst()
                    }
                }
                chars = chars.dropFirst()
                out += "\"\""
            } else {
                out.append(char)
                chars = chars.dropFirst()
            }
        }
        return out
    }

    private func recordSpec(_ fields: [String]) -> String {
        let properties = fields.map { "\"\($0)\": { \"type\": \"string\" }" }.joined(separator: ", ")
        return """
        {
          "openrpc": "1.3.2",
          "info": { "title": "test", "version": "1.0.0" },
          "methods": [{
            "name": "api.get", "params": [],
            "result": { "name": "GetResult", "schema": { "type": "object", "properties": { \(properties) } } }
          }]
        }
        """
    }

    func testSanitizerKeepsOnlyIdentifierCharacters() {
        XCTAssertEqual(swiftIdentifier("camelCase"), "camelCase")
        XCTAssertEqual(swiftIdentifier("run { error(\"x\") } || id"), "run___error__x________id")
        XCTAssertEqual(swiftIdentifier("9lives"), "_9lives")
        XCTAssertEqual(swiftIdentifier("é"), "_unnamed")
        XCTAssertEqual(swiftIdentifier("*/"), "__unnamed")
        XCTAssertEqual(escapedSwiftName("a`b\nc"), "a_b_c")
        XCTAssertEqual(pascalCase("Sample\"Type${x}`;"), "Sample_Type__x___")
    }

    func testFixtureGenerates() throws {
        let output = try generate(Data(contentsOf: fixtureSpecURL))

        XCTAssertTrue(output.models.contains("struct Sample_Type__x___: Codable {"), "got:\n\(output.models)")
        XCTAssertTrue(output.models.contains("case run___error__x________id = \"run { error(\\\"x\\\") } || id\""), "got:\n\(output.models)")
        XCTAssertTrue(output.api.contains("run___error__xParam________p: String"), "got:\n\(output.api)")
    }

    func testNoSpecTextSurvivesOutsideALiteralOrComment() throws {
        let output = try generate(Data(contentsOf: fixtureSpecURL))
        let code = codeOnly(output.models + output.api)

        for fragment in ["error(", "{ error", "`", "${", "\\(", "*/", "'", ";", "||", " sp ace", "with space"] {
            XCTAssertFalse(code.contains(fragment), "'\(fragment)' reached code:\n\(code)")
        }
    }

    func testTwoFieldsThatReduceToOneIdentifierFail() {
        XCTAssertThrowsError(try generate(recordSpec(["a-b", "a_b"]))) { error in
            let message = String(describing: error)
            XCTAssertTrue(message.contains("'a-b'") && message.contains("'a_b'"), message)
        }
    }

    func testTwoParametersThatReduceToOneIdentifierFail() {
        let spec = """
        {
          "openrpc": "1.3.2",
          "info": { "title": "test", "version": "1.0.0" },
          "methods": [{
            "name": "api.put",
            "params": [
              { "name": "a b", "required": true, "schema": { "type": "string" } },
              { "name": "a;b", "required": true, "schema": { "type": "string" } }
            ],
            "result": { "name": "PutResult", "schema": { "type": "boolean" } }
          }]
        }
        """
        XCTAssertThrowsError(try generate(spec)) { error in
            XCTAssertTrue(String(describing: error).contains("parameters"), String(describing: error))
        }
    }

    func testTwoSchemasThatReduceToOneIdentifierFail() {
        let spec = """
        {
          "openrpc": "1.3.2",
          "info": { "title": "test", "version": "1.0.0" },
          "components": { "schemas": {
            "A;b": { "type": "object", "properties": { "x": { "type": "string" } } },
            "A b": { "type": "object", "properties": { "y": { "type": "string" } } }
          }},
          "methods": []
        }
        """
        XCTAssertThrowsError(try generate(spec)) { error in
            XCTAssertTrue(String(describing: error).contains("schemas"), String(describing: error))
        }
    }

    func testKeywordEnumValuesAreBackticked() throws {
        let spec = """
        {
          "openrpc": "1.3.2",
          "info": { "title": "test", "version": "1.0.0" },
          "methods": [{
            "name": "api.pick",
            "params": [
              { "name": "choice", "required": true, "schema": { "type": "string", "enum": ["default", "in", "plain"] } }
            ],
            "result": { "name": "PickResult", "schema": { "type": "boolean" } }
          }]
        }
        """
        let output = try generate(spec)

        XCTAssertTrue(output.api.contains("case `default`\n"), "got:\n\(output.api)")
        XCTAssertTrue(output.api.contains("case `in`\n"), "got:\n\(output.api)")
        XCTAssertTrue(output.api.contains("case plain\n"), "got:\n\(output.api)")
    }

    /// A discriminated union whose tags are `default`, `self`, `class` and `type`, as a component
    /// schema (`Shape`) and as an inline parameter. `Shape` also has a `text` tag, which names a
    /// reserved type that a nested type may shadow.
    private let keywordUnionSpec = """
    {
      "openrpc": "1.3.2",
      "info": { "title": "test", "version": "1.0.0" },
      "components": { "schemas": {
        "Shape": { "oneOf": [
          { "type": "object", "properties": { "kind": { "type": "string", "enum": ["default"] } }, "required": ["kind"] },
          { "type": "object", "properties": { "kind": { "type": "string", "enum": ["self"] }, "a": { "type": "string" } }, "required": ["kind", "a"] },
          { "type": "object", "properties": { "kind": { "type": "string", "enum": ["class"] }, "b": { "type": "string" } }, "required": ["kind", "b"] },
          { "type": "object", "properties": { "kind": { "type": "string", "enum": ["type"] }, "c": { "type": "string" } }, "required": ["kind", "c"] },
          { "type": "object", "properties": { "kind": { "type": "string", "enum": ["text"] }, "d": { "type": "string" } }, "required": ["kind", "d"] }
        ]}
      }},
      "methods": [{
        "name": "api.draw",
        "params": [{ "name": "input", "required": true, "schema": { "oneOf": [
          { "type": "object", "properties": { "op": { "type": "string", "enum": ["default"] } }, "required": ["op"] },
          { "type": "object", "properties": { "op": { "type": "string", "enum": ["self"] }, "x": { "type": "string" } }, "required": ["op", "x"] },
          { "type": "object", "properties": { "op": { "type": "string", "enum": ["class"] }, "y": { "type": "string" } }, "required": ["op", "y"] }
        ]}}],
        "result": { "name": "DrawResult", "schema": { "$ref": "#/components/schemas/Shape" } }
      }]
    }
    """

    func testKeywordDiscriminatorValuesGenerateBacktickedUnionCases() throws {
        let output = try generate(keywordUnionSpec)

        for expected in [
            "case `default`\n",
            "case selfValue(SelfValue)\n",
            "case `class`(Class)\n",
            "case typeValue(TypeValue)\n",
            "case text(Text)\n",
            "case .`default`:",
            "case .`class`(let params):",
            "case \"default\": self = .`default`\n",
            "case \"self\": self = .selfValue(try SelfValue(from: decoder))",
            "case \"class\": self = .`class`(try Class(from: decoder))",
        ] {
            XCTAssertTrue(output.models.contains(expected), "missing '\(expected)' in:\n\(output.models)")
        }
        for expected in [
            "case `default`\n",
            "case selfValue(SelfValue)\n",
            "case `class`(Class)\n",
            "case \"default\": self = .`default`\n",
        ] {
            XCTAssertTrue(output.api.contains(expected), "missing '\(expected)' in:\n\(output.api)")
        }
    }

    /// Only `self` and `type` tags gain a `Value` suffix; a `text` tag keeps `Text`.
    func testReservedDiscriminatorValuesGenerateSuffixedVariantStructs() throws {
        let output = try generate(keywordUnionSpec)

        XCTAssertTrue(output.models.contains("struct SelfValue: Codable {"), "got:\n\(output.models)")
        XCTAssertTrue(output.models.contains("struct TypeValue: Codable {"), "got:\n\(output.models)")
        XCTAssertTrue(output.models.contains("struct Class: Codable {"), "got:\n\(output.models)")
        XCTAssertTrue(output.models.contains("struct Text: Codable {"), "got:\n\(output.models)")
        XCTAssertFalse(output.models.contains("TextValue"), "got:\n\(output.models)")
        XCTAssertTrue(output.api.contains("struct SelfValue: Codable {"), "got:\n\(output.api)")
        for source in [output.models, output.api] {
            for fragment in ["struct Self:", "struct Type:", "case self(", "case default", "case class(", "case type("] {
                XCTAssertFalse(source.contains(fragment), "'\(fragment)' in:\n\(source)")
            }
        }
    }

    func testTwoOperationsWhoseTypesNestInOneEnumFail() {
        let inlineResult = #"{ "type": "object", "properties": { "a": { "type": "string" } } }"#
        let spec = """
        {
          "openrpc": "1.3.2",
          "info": { "title": "test", "version": "1.0.0" },
          "methods": [
            { "name": "api.get-x", "params": [], "result": { "name": "R1", "schema": \(inlineResult) } },
            { "name": "api.getX", "params": [], "result": { "name": "R2", "schema": \(inlineResult) } }
          ]
        }
        """
        XCTAssertThrowsError(try generate(spec)) { error in
            let message = String(describing: error)
            XCTAssertTrue(message.contains("'get-x'") && message.contains("'getX'") && message.contains("'GetX'"), message)
        }
    }

    func testTwoServersThatReduceToOneIdentifierFail() {
        let spec = """
        {
          "openrpc": "1.3.2",
          "info": { "title": "test", "version": "1.0.0" },
          "servers": [
            { "name": "my-server", "url": "https://a.example.com" },
            { "name": "my.server", "url": "https://b.example.com" }
          ],
          "methods": [{ "name": "api.run", "params": [], "result": { "name": "RunResult", "schema": { "type": "boolean" } } }]
        }
        """
        XCTAssertThrowsError(try generate(spec)) { error in
            let message = String(describing: error)
            XCTAssertTrue(message.contains("servers") && message.contains("'my-server'"), message)
        }
    }

    func testSchemaTypeIsDeclaredAndReferencedUnderOneName() throws {
        let spec = """
        {
          "openrpc": "1.3.2",
          "info": { "title": "test", "version": "1.0.0" },
          "components": { "schemas": {
            "my-type": { "type": "object", "properties": { "a": { "type": "string" } } }
          }},
          "methods": [{
            "name": "api.get", "params": [],
            "result": { "name": "GetResult", "schema": { "$ref": "#/components/schemas/my-type" } }
          }]
        }
        """
        let output = try generate(spec)

        XCTAssertEqual(output.models.components(separatedBy: "struct my_type: Codable").count, 2, "got:\n\(output.models)")
        XCTAssertFalse(output.models.contains("MyType"), "got:\n\(output.models)")
        XCTAssertTrue(output.api.contains("decode(my_type.self"), "got:\n\(output.api)")
    }
}
