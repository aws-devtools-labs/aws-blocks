//
// Copyright Amazon.com Inc. or its affiliates.
// All Rights Reserved.
//
// SPDX-License-Identifier: Apache-2.0
//

import XCTest
@testable import BlocksCodegen

/// A union arm that isn't an object (a string, a number, a boolean, an array, a map) used to become a
/// payload-less case: fixture 09's `anyOf [string, {text, fuzzy}]` decoded `"abc"` to `.query_Variant0`, which
/// encoded back as `{}`. Every value was lost, and the first such case was the fallback that accepted anything.
/// Such an arm now carries its value (`case query_Variant0(String)`), decoded and encoded as a bare JSON value.
/// A `null` arm makes the union optional, as before.
final class PrimitiveUnionArmTests: XCTestCase {

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
    private func array(_ items: String) -> String { #"{ "type": "array", "items": \#(items) }"# }
    private func map(_ values: String) -> String { #"{ "type": "object", "additionalProperties": \#(values) }"# }
    private func literal(_ value: String) -> String { #"{ "const": "\#(value)" }"# }

    private let string = #"{ "type": "string" }"#
    private let number = #"{ "type": "number" }"#
    private let integer = #"{ "type": "integer" }"#
    private let boolean = #"{ "type": "boolean" }"#
    private let null = #"{ "type": "null" }"#

    private func assertContains(_ haystack: String, _ needle: String, file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertTrue(haystack.contains(needle), "Expected generated code to contain:\n\(needle)\n--- got ---\n\(haystack)", file: file, line: line)
    }

    private func assertNotContains(_ haystack: String, _ needle: String, file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertFalse(haystack.contains(needle), "Expected generated code not to contain:\n\(needle)\n--- got ---\n\(haystack)", file: file, line: line)
    }

    /// Fixture 09's `query` parameter.
    private var searchQuery: String {
        anyOf(string, object(["text": string, "fuzzy": boolean], required: ["text"]))
    }

    // MARK: - Generated code

    func testStringArmCarriesItsValue() throws {
        let output = try generate(methods: [method("search", params: "[\(param("query", searchQuery))]", result: string)])

        assertContains(output.api, "case query_Variant0(String)")
        assertContains(output.api, "case query_Variant1(Query_Variant1)")
        assertContains(output.api, "self = .query_Variant0(try decoder.singleValueContainer().decode(String.self))")
        // Through a single-value container, so the encoder's strategies apply (FX35: a `Date` arm).
        assertContains(output.api, """
                        case .query_Variant0(let payload):
                            var container = encoder.singleValueContainer()
                            try container.encode(payload)
        """)
        // The string case is no longer a payload-less fallback that accepts any value and encodes `{}`.
        assertNotContains(output.api, "self = .query_Variant0\n")
        assertNotContains(output.api, "_ = encoder.container(keyedBy: EmptyKey.self)")
    }

    func testEachPrimitiveArmCarriesItsOwnType() throws {
        let key = anyOf(string, number, integer, boolean, object(["id": string]))
        let output = try generate(methods: [method("lookup", params: "[\(param("key", key))]", result: string)])

        assertContains(output.api, "case key_Variant0(String)")
        assertContains(output.api, "case key_Variant1(Double)")
        assertContains(output.api, "case key_Variant2(Int)")
        assertContains(output.api, "case key_Variant3(Bool)")
        assertContains(output.api, "case key_Variant4(Key_Variant4)")
        // With no payload-less case there's no fallback, so a value no arm matches is an error.
        assertContains(output.api, "throw lastError ?? DecodingError.dataCorrupted(")
    }

    func testNullArmMakesTheUnionOptional() throws {
        let query = anyOf(string, number, object(["text": string]), null)
        let output = try generate(methods: [method("search", params: "[\(param("query", query))]", result: string)])

        assertContains(output.api, "public func search(query: Search.Query?) async throws -> String")
        assertContains(output.api, "case query_Variant0(String)")
        assertContains(output.api, "case query_Variant1(Double)")
    }

    func testArrayAndMapArmsCarryTheirValues() throws {
        let result = anyOf(array(string), map(integer), array(object(["q": string])), object(["a": string]))
        let output = try generate(methods: [method("list", result: result)])

        assertContains(output.api, "case result_Variant0([String])")
        assertContains(output.api, "case result_Variant1([String: Int])")
        assertContains(output.api, "case result_Variant3(Result_Variant3)")
        // The element of an array of objects is declared beside the union, like a variant's struct.
        assertContains(output.api, "case result_Variant2([Result_Variant2])")
        assertContains(output.api, "public struct Result_Variant2: Codable {\n            public let q: String")
    }

    func testValueArmsInComponentSchemasAndNestedRecords() throws {
        let filter = object([
            "value": anyOf(string, integer, object(["op": string])),
            "meta": object(["inner": anyOf(boolean, object(["y": string]))]),
            "objs": anyOf(array(object(["q": string])), object(["w": string]))
        ])
        let output = try generate(
            schemas: #"{ "Filter": \#(filter) }"#,
            methods: [method("getFilter", result: ##"{ "$ref": "#/components/schemas/Filter" }"##)]
        )

        assertContains(output.models, "case value_Variant0(String)")
        assertContains(output.models, "case value_Variant1(Int)")
        assertContains(output.models, "        case inner_Variant0(Bool)")
        assertContains(output.models, "case objs_Variant0([Objs_Variant0])")
        assertContains(output.models, "public struct Objs_Variant0: Codable {\n    public let q: String")
    }

    func testUnionsThatDifferOnlyInAValueArmAreNotMerged() throws {
        // Both shapes used to be `{}|{x}`, so the second schema field reused the first's union.
        let pair = object(["a": anyOf(string, object(["x": string])), "b": anyOf(number, object(["x": string]))])
        let output = try generate(
            schemas: #"{ "Pair": \#(pair) }"#,
            methods: [method("getPair", result: ##"{ "$ref": "#/components/schemas/Pair" }"##)]
        )

        assertContains(output.models, "public let a: A")
        assertContains(output.models, "public let b: B")
        assertContains(output.models, "case a_Variant0(String)")
        assertContains(output.models, "case b_Variant0(Double)")
    }

    func testDiscriminatedUnionWithAValueArm() throws {
        let kindA = object(["kind": literal("a"), "x": string])
        let kindB = object(["kind": literal("b")])
        let output = try generate(methods: [method("act", result: oneOf(kindA, kindB, string))])

        assertContains(output.api, "case result_Variant2(String)")
        // The value arm encodes bare, so each object case opens the keyed container itself.
        assertContains(output.api, """
                        case .a(let params):
                            var container = encoder.container(keyedBy: CodingKeys.self)
                            try container.encode("a", forKey: .kind)
                            try params.encode(to: encoder)
        """)
        assertContains(output.api, """
                        case .result_Variant2(let value):
                            var container = encoder.singleValueContainer()
                            try container.encode(value)
        """)
        assertContains(output.api, """
                    public init(from decoder: Decoder) throws {
                        if let value = try? decoder.singleValueContainer().decode(String.self) {
                            self = .result_Variant2(value)
                            return
                        }
                        let container = try decoder.container(keyedBy: CodingKeys.self)
        """)
    }

    func testDiscriminatedUnionWithAMapArmTriesItOnlyWithoutTheDiscriminator() throws {
        let kindA = object(["kind": literal("a"), "x": string])
        let kindB = object(["kind": literal("b")])
        let output = try generate(methods: [method("act", result: oneOf(kindA, kindB, map(string)))])

        assertContains(output.api, """
                        let container = try decoder.container(keyedBy: CodingKeys.self)
                        if !container.contains(.kind), let value = try? decoder.singleValueContainer().decode([String: String].self) {
        """)
    }

    // MARK: - Unchanged

    func testFieldlessObjectArmIsStillAPayloadlessFallback() throws {
        let empty = #"{ "type": "object", "properties": {} }"#
        let output = try generate(methods: [method("ping", params: "[\(param("probe", anyOf(object(["id": string]), empty)))]", result: string)])

        assertContains(output.api, "case probe_Variant1\n")
        assertContains(output.api, "_ = encoder.container(keyedBy: EmptyKey.self)")
        assertContains(output.api, "self = .probe_Variant1\n")
        assertNotContains(output.api, "var lastError")
    }

    func testDiscriminatedUnionWithoutValueArmsOpensTheContainerOnce() throws {
        let kindA = object(["kind": literal("a"), "x": string])
        let kindB = object(["kind": literal("b")])
        let output = try generate(methods: [method("act", result: oneOf(kindA, kindB))])

        assertContains(output.api, """
                    public func encode(to encoder: Encoder) throws {
                        var container = encoder.container(keyedBy: CodingKeys.self)
                        switch self {
                        case .a(let params):
                            try container.encode("a", forKey: .kind)
        """)
        assertContains(output.api, """
                    public init(from decoder: Decoder) throws {
                        let container = try decoder.container(keyedBy: CodingKeys.self)
                        let disc = try container.decode(String.self, forKey: .kind)
        """)
    }

    // MARK: - Compiled and run

    /// Builds the generated module and an executable that round-trips every arm through JSON.
    func testEveryArmRoundTripsThroughJSON() throws {
        #if os(macOS)
        let filter = object([
            "value": anyOf(string, integer, object(["op": string])),
            "meta": object(["inner": anyOf(boolean, object(["y": string]))]),
            "objs": anyOf(array(object(["q": string])), object(["w": string]))
        ])
        let kindA = object(["kind": literal("a"), "x": string])
        let kindB = object(["kind": literal("b")])
        let output = try generate(
            schemas: #"{ "Filter": \#(filter) }"#,
            methods: [
                method("search", params: "[\(param("query", searchQuery))]", result: object(["count": integer])),
                method("lookup", params: "[\(param("key", anyOf(string, number, integer, boolean, object(["id": string]), null)))]", result: string),
                method("list", result: anyOf(array(string), map(integer), array(object(["q": string])), object(["a": string]))),
                method("act", result: oneOf(kindA, kindB, string)),
                method("tag", result: oneOf(kindA, kindB, map(string))),
                method("getFilter", result: ##"{ "$ref": "#/components/schemas/Filter" }"##)
            ]
        )
        let main = #"""
        import Foundation
        import BlocksRuntime
        import Generated

        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        func roundTrip<T: Codable>(_ json: String, as type: T.Type) -> String {
            do {
                let decoded = try JSONDecoder().decode(T.self, from: Data(json.utf8))
                let reencoded = try JSONDecoder().decode(T.self, from: try encoder.encode(decoded))
                return String(decoding: try encoder.encode(reencoded), as: UTF8.self)
            } catch {
                return "error"
            }
        }
        func encoded<T: Encodable>(_ value: T) throws -> String {
            String(decoding: try encoder.encode(value), as: UTF8.self)
        }

        // Fixture 09's shape: the string arm keeps its value.
        print(roundTrip(#""abc""#, as: Api.Search.Query.self))
        print(roundTrip(#"{"fuzzy":true,"text":"t"}"#, as: Api.Search.Query.self))
        print(roundTrip("42", as: Api.Search.Query.self))
        if case .query_Variant0(let text) = try JSONDecoder().decode(Api.Search.Query.self, from: Data(#""abc""#.utf8)) {
            print(text)
        }
        // A request sends the value itself.
        let request = BlocksRequest(method: "api.search", params: [Api.Search.Query.query_Variant0("abc")], id: 1)
        print(try encoded(request))

        // A string, a number, an integer, a boolean, an object and null.
        for json in [#""k""#, "1.5", "true", #"{"id":"i"}"#, "null", "[1]"] {
            print(roundTrip(json, as: Api.Lookup.Key?.self))
        }
        if case .key_Variant1(let number) = try JSONDecoder().decode(Api.Lookup.Key.self, from: Data("1.5".utf8)) {
            print(number)
        }
        if case .key_Variant1(let number) = try JSONDecoder().decode(Api.Lookup.Key.self, from: Data("7".utf8)) {
            print(number)
        }
        print(try encoded(Api.Lookup.Key.key_Variant2(7)))

        // Arrays and maps.
        for json in [#"["a","b"]"#, #"{"k":1}"#, #"[{"q":"x"}]"#, #"{"a":"y"}"#] {
            print(roundTrip(json, as: Api.List.Result.self))
        }

        // Discriminated unions with a value arm.
        for json in [#""s""#, #"{"kind":"a","x":"y"}"#, #"{"kind":"b"}"#] {
            print(roundTrip(json, as: Api.Act.Result.self))
        }
        for json in [#"{"m":"n"}"#, #"{"kind":"a","x":"y"}"#, #"{"kind":"b"}"#] {
            print(roundTrip(json, as: Api.Tag.Result.self))
        }

        // A component schema, a nested record and an array of objects.
        print(roundTrip(#"{"meta":{"inner":false},"objs":[{"q":"r"}],"value":"v"}"#, as: Filter.self))
        print(roundTrip(#"{"meta":{"inner":{"y":"z"}},"objs":{"w":"w"},"value":3}"#, as: Filter.self))
        let filter = Filter(meta: Filter.Meta(inner: .inner_Variant0(true)), objs: .objs_Variant0([Objs_Variant0(q: "q")]),
                            value: .value_Variant1(9))
        print(try encoded(filter))
        """#
        guard let run = try runConsumer(models: output.models, api: output.api, main: main) else { return }

        XCTAssertFalse(run.compilerOutput.contains("warning:"), "The generated module compiled with warnings:\n\(run.compilerOutput)")
        XCTAssertEqual(run.output.split(separator: "\n").map(String.init), [
            #""abc""#,
            #"{"fuzzy":true,"text":"t"}"#,
            "error",
            "abc",
            #"{"id":1,"jsonrpc":"2.0","method":"api.search","params":["abc"]}"#,
            #""k""#,
            "1.5",
            "true",
            #"{"id":"i"}"#,
            "null",
            "error",
            "1.5",
            "7.0",
            "7",
            #"["a","b"]"#,
            #"{"k":1}"#,
            #"[{"q":"x"}]"#,
            #"{"a":"y"}"#,
            #""s""#,
            #"{"kind":"a","x":"y"}"#,
            #"{"kind":"b"}"#,
            #"{"m":"n"}"#,
            #"{"kind":"a","x":"y"}"#,
            #"{"kind":"b"}"#,
            #"{"meta":{"inner":false},"objs":[{"q":"r"}],"value":"v"}"#,
            #"{"meta":{"inner":{"y":"z"}},"objs":{"w":"w"},"value":3}"#,
            #"{"meta":{"inner":true},"objs":[{"q":"q"}],"value":9}"#
        ])
        #else
        throw XCTSkip("Compiling and running the generated module needs the host toolchain (macOS only).")
        #endif
    }
}
