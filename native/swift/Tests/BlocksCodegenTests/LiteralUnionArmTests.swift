//
// Copyright Amazon.com Inc. or its affiliates.
// All Rights Reserved.
//
// SPDX-License-Identifier: Apache-2.0
//

import XCTest
@testable import BlocksCodegen

/// The parser turned every `const` (and a one-value boolean `enum`) into a string, so a literal lost its JSON
/// type before the builder saw it. Fixture 24's boolean discriminator encoded as the string `"true"` and decoded
/// with `decode(String.self, forKey: .isUpdated)`, which fails on the JSON `true` the server sends; a numeric
/// `const` declared `enum X: String { case 5 }`, which doesn't compile; and a literal arm of a union without a
/// discriminator was a payload-less fallback that encoded `{}` and decoded from any value. A literal now keeps
/// its JSON type: a discriminator encodes and decodes as that type, a literal arm is a payload-less case that
/// encodes as the bare value and decodes only from it, and an arm of several string values carries its enum.
final class LiteralUnionArmTests: XCTestCase {

    private func generate(schemas: String = "{}", methods: [String]) throws -> GeneratedSources {
        let json = """
        {
            "openrpc": "1.3.2",
            "info": { "title": "test", "version": "1.0.0" },
            "methods": [\(methods.joined(separator: ", "))],
            "components": { "schemas": \(schemas) }
        }
        """
        let rpcModel = try OpenRPCParser().parse(data: Data(json.utf8))
        return SwiftCodeGenerator().generate(from: CodegenModelBuilder().build(from: rpcModel))
    }

    private func method(_ name: String, params: String = "[]", result: String) -> String {
        """
        { "name": "api.\(name)", "params": \(params), "result": { "name": "R", "schema": \(result) } }
        """
    }

    private func param(_ name: String, _ schema: String) -> String {
        #"{ "name": "\#(name)", "required": true, "schema": \#(schema) }"#
    }

    private func object(_ properties: [String: String], required: [String]? = nil) -> String {
        let props = properties.sorted { $0.key < $1.key }.map { "\"\($0.key)\": \($0.value)" }.joined(separator: ", ")
        let required = (required ?? properties.keys.sorted()).map { "\"\($0)\"" }.joined(separator: ", ")
        return #"{ "type": "object", "properties": { \#(props) }, "required": [\#(required)] }"#
    }

    private func anyOf(_ members: String...) -> String { #"{ "anyOf": [\#(members.joined(separator: ", "))] }"# }
    private func oneOf(_ members: String...) -> String { #"{ "oneOf": [\#(members.joined(separator: ", "))] }"# }
    private func const(_ json: String) -> String { #"{ "const": \#(json) }"# }

    private let string = #"{ "type": "string" }"#
    private let number = #"{ "type": "number" }"#

    /// Fixture 24's `updateAttributes` result: a map of a boolean-discriminated union, or null.
    private let updateResult = """
    { "type": "object", "additionalProperties": { "oneOf": [
        { "type": "object", "properties": { "isUpdated": { "type": "boolean", "enum": [true] } }, "required": ["isUpdated"] },
        { "type": "object", "properties": {
            "isUpdated": { "type": "boolean", "enum": [false] },
            "nextStep": { "type": "object", "properties": { "name": { "type": "string" } }, "required": ["name"] }
        }, "required": ["isUpdated", "nextStep"] },
        { "type": "null" }
    ] } }
    """

    private func assertContains(_ haystack: String, _ needle: String, file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertTrue(haystack.contains(needle), "Expected generated code to contain:\n\(needle)\n--- got ---\n\(haystack)", file: file, line: line)
    }

    private func assertNotContains(_ haystack: String, _ needle: String, file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertFalse(haystack.contains(needle), "Expected generated code not to contain:\n\(needle)\n--- got ---\n\(haystack)", file: file, line: line)
    }

    // MARK: - Parser

    func testConstKeepsItsJSONType() throws {
        func parsed(_ schema: String) throws -> TypeRef {
            let rpcModel = try OpenRPCParser().parse(data: Data("""
            { "openrpc": "1.3.2", "info": { "title": "t", "version": "1" },
              "methods": [{ "name": "api.f", "params": [\(param("v", schema))], "result": { "name": "R", "schema": \(string) } }] }
            """.utf8))
            return rpcModel.methods[0].params[0].schema
        }
        XCTAssertEqual(try parsed(const(#""a""#)), .unionLiteral(values: ["a"]))
        XCTAssertEqual(try parsed(const("true")), .literal(.boolean(true)))
        XCTAssertEqual(try parsed(const("false")), .literal(.boolean(false)))
        XCTAssertEqual(try parsed(const("5")), .literal(.number(5)))
        XCTAssertEqual(try parsed(const("1.5")), .literal(.number(1.5)))
        XCTAssertEqual(try parsed(#"{ "type": "integer", "const": 5 }"#), .literal(.integer(5)))
        XCTAssertEqual(try parsed(const("null")), .primitive(kind: .void))
        // TypeScript's literal types: `true`, `5`.
        XCTAssertEqual(try parsed(#"{ "type": "boolean", "enum": [true] }"#), .literal(.boolean(true)))
        XCTAssertEqual(try parsed(#"{ "type": "number", "enum": [5] }"#), .literal(.number(5)))
        // `[true, false]` is any boolean, and several numbers are a number.
        XCTAssertEqual(try parsed(#"{ "type": "boolean", "enum": [true, false] }"#), .primitive(kind: .boolean))
        XCTAssertEqual(try parsed(#"{ "type": "number", "enum": [1, 2] }"#), .primitive(kind: .number))
    }

    // MARK: - Discriminators

    func testBooleanDiscriminatorEncodesAndDecodesABoolean() throws {
        let output = try generate(methods: [method("updateAttributes", result: updateResult)])

        assertContains(output.api, "try container.encode(true, forKey: .isUpdated)")
        assertContains(output.api, "try container.encode(false, forKey: .isUpdated)")
        assertContains(output.api, "let disc = try container.decode(Bool.self, forKey: .isUpdated)")
        assertContains(output.api, "case true: self = .isUpdatedTrue")
        assertContains(output.api, "case false: self = .isUpdatedFalse(try IsUpdatedFalse(from: decoder))")
        assertNotContains(output.api, #""true""#)
        // Both values are covered, so a `default` would never run (a compiler warning).
        assertNotContains(output.api, "default:")
    }

    func testOneBooleanValueKeepsADefault() throws {
        let yes = object(["ok": const("true"), "id": string])
        let other = object(["ok": const("true"), "kind": const(#""x""#)])
        // Both arms share `ok: true`, so `kind` (a string) isn't on both and `ok` is the discriminator.
        let output = try generate(methods: [method("check", result: oneOf(yes, other))])

        assertContains(output.api, "let disc = try container.decode(Bool.self, forKey: .ok)")
        assertContains(output.api, "case true:")
        assertContains(output.api, "default:")
    }

    func testNumericDiscriminator() throws {
        let one = object(["code": const("1"), "a": string])
        let two = object(["code": const("2"), "b": string])
        let output = try generate(methods: [method("status", result: oneOf(one, two))])

        assertContains(output.api, "case code1(Code1)")
        assertContains(output.api, "case code2(Code2)")
        assertContains(output.api, "try container.encode(1, forKey: .code)")
        assertContains(output.api, "let disc = try container.decode(Double.self, forKey: .code)")
        assertContains(output.api, "case 2: self = .code2(try Code2(from: decoder))")
        assertContains(output.api, "default:")
    }

    func testStringDiscriminatorIsPreferredAndUnchanged() throws {
        let email = object(["type": const(#""email""#), "on": const("true"), "body": string])
        let sms = object(["type": const(#""sms""#), "on": const("false"), "text": string])
        let output = try generate(methods: [method("notify", result: oneOf(email, sms))])

        assertContains(output.api, "let disc = try container.decode(String.self, forKey: .`type`)")
        assertContains(output.api, #"case "email": self = .email(try Email(from: decoder))"#)
        // The other literal is a field of its type.
        assertContains(output.api, "public let on: Bool")
    }

    func testLiteralFieldIsAValueOfItsType() throws {
        let output = try generate(methods: [method("get", result: object([
            "ok": const("true"), "version": const("2"), "count": #"{ "type": "integer", "const": 3 }"#, "kind": const(#""v""#)
        ]))])

        assertContains(output.api, "public let ok: Bool")
        assertContains(output.api, "public let version: Double")
        assertContains(output.api, "public let count: Int")
        assertContains(output.api, "public let kind: Kind")
        assertNotContains(output.api, "case 2")
    }

    // MARK: - Literal arms

    func testLiteralArmsArePayloadlessAndMatchTheirValue() throws {
        let mode = anyOf(const(#""auto""#), number, const("false"), object(["level": number]))
        let output = try generate(methods: [method("setMode", params: "[\(param("mode", mode))]", result: string)])

        assertContains(output.api, "case mode_Variant0\n")
        assertContains(output.api, "case mode_Variant1(Double)")
        assertContains(output.api, "case mode_Variant2\n")
        assertContains(output.api, """
                        case .mode_Variant0:
                            var container = encoder.singleValueContainer()
                            try container.encode("auto")
        """)
        assertContains(output.api, "try container.encode(false)")
        assertContains(output.api, """
                        if let value = try? decoder.singleValueContainer().decode(String.self), value == "auto" {
                            self = .mode_Variant0
                            return
                        }
        """)
        assertContains(output.api, "if let value = try? decoder.singleValueContainer().decode(Bool.self), value == false {")
        // A literal arm isn't a fallback: a value no arm matches is an error.
        assertContains(output.api, "var lastError: Error?")
        assertNotContains(output.api, "EmptyKey.self)")
    }

    func testUnionOfOnlyLiteralsThrowsWithoutALastError() throws {
        let output = try generate(methods: [method("pick", params: "[\(param("p", anyOf(const(#""a""#), const("1"))))]", result: string)])

        assertNotContains(output.api, "lastError")
        assertContains(output.api, "if let value = try? decoder.singleValueContainer().decode(Double.self), value == 1 {")
        assertContains(output.api, #"throw DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: "No P variant matched"))"#)
    }

    func testEnumArmCarriesItsEnum() throws {
        let level = anyOf(#"{ "type": "string", "enum": ["low", "high"] }"#, number)
        // In an operation, and in a component schema (separately: the operation's union would reuse the schema's).
        let operation = try generate(methods: [method("setLevel", params: "[\(param("level", level))]", result: string)])
        let schema = try generate(
            schemas: #"{ "Setting": \#(object(["level": level])) }"#,
            methods: [method("getSetting", result: ##"{ "$ref": "#/components/schemas/Setting" }"##)]
        )

        assertContains(operation.api, "case level_Variant0(Level_Variant0)")
        assertContains(operation.api, "public enum Level_Variant0: String, Codable {\n            case low\n            case high")
        assertContains(schema.models, "case level_Variant0(Level_Variant0)")
        assertContains(schema.models, "public enum Level_Variant0: String, Codable {\n    case low\n    case high")
    }

    func testDiscriminatedUnionWithALiteralArm() throws {
        let kindA = object(["kind": const(#""a""#), "x": string])
        let kindB = object(["kind": const(#""b""#)])
        let output = try generate(methods: [method("act", result: oneOf(kindA, kindB, const("false")))])

        assertContains(output.api, "case result_Variant2\n")
        assertContains(output.api, """
                        case .result_Variant2:
                            var container = encoder.singleValueContainer()
                            try container.encode(false)
        """)
        assertContains(output.api, """
                    public init(from decoder: Decoder) throws {
                        if let value = try? decoder.singleValueContainer().decode(Bool.self), value == false {
                            self = .result_Variant2
                            return
                        }
                        let container = try decoder.container(keyedBy: CodingKeys.self)
        """)
    }

    // MARK: - Compiled and run

    /// Builds the generated module and an executable that round-trips the server's JSON through each shape.
    func testLiteralsRoundTripThroughJSON() throws {
        #if os(macOS)
        let kindA = object(["kind": const(#""a""#), "x": string])
        let kindB = object(["kind": const(#""b""#)])
        let output = try generate(methods: [
            method("updateAttributes", result: updateResult),
            method("status", result: oneOf(object(["code": const("1"), "a": string]), object(["code": const("2.5"), "b": string]))),
            method("setMode", params: "[\(param("mode", anyOf(const(#""auto""#), number, const("false"), object(["level": number]))))]", result: string),
            method("act", result: oneOf(kindA, kindB, const("false"))),
            method("pick", result: anyOf(#"{ "type": "string", "enum": ["low", "high"] }"#, const("0"))),
            method("get", result: object(["ok": const("true"), "version": const("2")]))
        ])
        let main = #"""
        import Foundation
        import BlocksRuntime
        import Generated

        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        func roundTrip<T: Codable>(_ json: String, as type: T.Type) -> String {
            do {
                let decoded = try JSONDecoder().decode(T.self, from: Data(json.utf8))
                return String(decoding: try encoder.encode(decoded), as: UTF8.self)
            } catch {
                return "error"
            }
        }

        // Fixture 24: the server sends booleans.
        print(roundTrip(#"{"a":{"isUpdated":true},"b":{"isUpdated":false,"nextStep":{"name":"CONFIRM"}},"c":null}"#,
                        as: [String: Api.UpdateAttributes.ResultValue?].self))
        print(roundTrip(#"{"a":{"isUpdated":"true"}}"#, as: [String: Api.UpdateAttributes.ResultValue?].self))
        // A numeric discriminator.
        print(roundTrip(#"{"a":"x","code":1}"#, as: Api.Status.Result.self))
        print(roundTrip(#"{"b":"y","code":2.5}"#, as: Api.Status.Result.self))
        print(roundTrip(#"{"b":"y","code":3}"#, as: Api.Status.Result.self))
        // Literal arms decode only from their value, and encode as it.
        for json in [#""auto""#, "1.5", "false", #"{"level":2}"#, "true", #""manual""#] {
            print(roundTrip(json, as: Api.SetMode.Mode.self))
        }
        let request = BlocksRequest(method: "api.setMode", params: [Api.SetMode.Mode.mode_Variant2], id: 1)
        print(String(decoding: try encoder.encode(request), as: UTF8.self))
        for json in ["false", #"{"kind":"a","x":"y"}"#, #"{"kind":"b"}"#, "true"] {
            print(roundTrip(json, as: Api.Act.Result.self))
        }
        for json in [#""high""#, "0", #""mid""#, "1"] {
            print(roundTrip(json, as: Api.Pick.Result.self))
        }
        print(roundTrip(#"{"ok":true,"version":2}"#, as: Api.Get.Result.self))
        """#
        guard let run = try runConsumer(models: output.models, api: output.api, main: main) else { return }

        XCTAssertFalse(run.compilerOutput.contains("warning:"), "The generated module compiled with warnings:\n\(run.compilerOutput)")
        XCTAssertEqual(run.output.split(separator: "\n").map(String.init), [
            #"{"a":{"isUpdated":true},"b":{"isUpdated":false,"nextStep":{"name":"CONFIRM"}},"c":null}"#,
            "error",
            #"{"a":"x","code":1}"#,
            #"{"b":"y","code":2.5}"#,
            "error",
            #""auto""#,
            "1.5",
            "false",
            #"{"level":2}"#,
            "error",
            "error",
            #"{"id":1,"jsonrpc":"2.0","method":"api.setMode","params":[false]}"#,
            "false",
            #"{"kind":"a","x":"y"}"#,
            #"{"kind":"b"}"#,
            "error",
            #""high""#,
            "0",
            "error",
            "error",
            #"{"ok":true,"version":2}"#
        ])
        #else
        throw XCTSkip("Compiling and running the generated module needs the host toolchain (macOS only).")
        #endif
    }
}
