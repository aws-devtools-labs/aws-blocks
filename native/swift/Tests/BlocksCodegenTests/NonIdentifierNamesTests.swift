//
// Copyright Amazon.com Inc. or its affiliates.
// All Rights Reserved.
//
// SPDX-License-Identifier: Apache-2.0
//

import XCTest
@testable import BlocksCodegen

/// Names the spec supplies reach generated code only as identifiers or escaped literals.
final class NonIdentifierNamesTests: XCTestCase {

    private var fixtureSpecURL: URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("codegen-fixtures/43-non-identifier-names/spec.json")
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

    private func schemasSpec(_ names: [String]) -> String {
        let schemas = names.map {
            "\"\($0)\": { \"type\": \"object\", \"properties\": { \"a\": { \"type\": \"string\" } } }"
        }.joined(separator: ", ")
        let methods = names.enumerated().map { idx, name in
            """
            { "name": "api.get\(idx)", "params": [],
              "result": { "name": "Get\(idx)Result", "schema": { "$ref": "#/components/schemas/\(name)" } } }
            """
        }.joined(separator: ", ")
        return """
        {
          "openrpc": "1.3.2",
          "info": { "title": "test", "version": "1.0.0" },
          "components": { "schemas": { \(schemas) } },
          "methods": [\(methods)]
        }
        """
    }

    func testSanitizerKeepsOnlyIdentifierCharacters() {
        XCTAssertEqual(sanitizedSwiftName("run { error(\"x\") } || id"), "run___error__x________id")
        XCTAssertEqual(sanitizedSwiftName("9lives"), "_9lives")
        XCTAssertEqual(sanitizedSwiftName("1st"), "_1st")
        XCTAssertEqual(sanitizedSwiftName("$"), "_unnamed")
        XCTAssertEqual(sanitizedSwiftName("*/"), "__unnamed")
        XCTAssertEqual(sanitizedSwiftName(""), "_unnamed")
        XCTAssertFalse(isValidSwiftIdentifier("_"))
        XCTAssertEqual(escapedSwiftName("_"), "_unnamed")
        XCTAssertEqual(escapedSwiftName("a`b\nc"), "a_b_c")
    }

    func testNoSpecTextSurvivesOutsideALiteralOrComment() throws {
        let output = try generate(Data(contentsOf: fixtureSpecURL))
        let code = codeOnly(output.models + output.api)

        for fragment in ["error(", "{ error", "`", "${", "\\(", "*/", "'", ";", "||", " sp ace", "with space"] {
            XCTAssertFalse(code.contains(fragment), "'\(fragment)' reached code:\n\(code)")
        }
        XCTAssertFalse(code.contains("let _:"), "a lone `_` can't be declared:\n\(code)")
    }

    func testFixtureKeepsLeadingDigits() throws {
        let output = try generate(Data(contentsOf: fixtureSpecURL))

        XCTAssertTrue(output.models.contains("case _9lives = \"9lives\""), "got:\n\(output.models)")
        XCTAssertTrue(output.models.contains("case _1st = \"1st\""), "got:\n\(output.models)")
    }

    func testSchemaTypeIsDeclaredAndReferencedUnderOneName() throws {
        let output = try generate(schemasSpec(["Sample-Type${x}`;"]))
        let name = specTypeName("Sample-Type${x}`;")

        XCTAssertEqual(output.models.components(separatedBy: "struct \(name): Codable").count, 2, "got:\n\(output.models)")
        XCTAssertTrue(output.api.contains("decode(\(name).self"), "got:\n\(output.api)")
    }

    func testSchemasThatReduceToOneIdentifierGetDistinctTypes() throws {
        let output = try generate(schemasSpec(["my-type!", "my-type?"]))
        let name = specTypeName("my-type!")

        XCTAssertTrue(output.models.contains("struct \(name): Codable"), "got:\n\(output.models)")
        XCTAssertTrue(output.models.contains("struct \(name)_2: Codable"), "got:\n\(output.models)")
        XCTAssertTrue(output.api.contains("decode(\(name).self"), "got:\n\(output.api)")
        XCTAssertTrue(output.api.contains("decode(\(name)_2.self"), "got:\n\(output.api)")
    }

    func testFieldsThatReduceToOneIdentifierKeepTheirKeys() throws {
        let output = try generate(recordSpec(["a-b", "a_b"]))

        XCTAssertTrue(output.api.contains("= \"a-b\""), "got:\n\(output.api)")
        XCTAssertTrue(output.api.contains("a_b_2"), "got:\n\(output.api)")
    }
}
