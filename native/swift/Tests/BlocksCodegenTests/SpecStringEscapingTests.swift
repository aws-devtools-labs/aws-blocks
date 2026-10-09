//
// Copyright Amazon.com Inc. or its affiliates.
// All Rights Reserved.
//
// SPDX-License-Identifier: Apache-2.0
//

import XCTest
@testable import BlocksCodegen

/// Every spec string the generator writes into a Swift string literal goes through `swiftStringContent`, which
/// escapes `\` first, then `"`, then line breaks and other control characters, so the literal spells the spec's
/// text exactly: it neither breaks (`"say "hi""`) nor interpolates (`"x\(1+1)"` would send `"x2"`). FX46 routed
/// wire keys, enum raw values, discriminators, literal arms, method and server names through it; two sites were
/// left: a `pattern` constraint (only `\` and `"` were escaped, so a line break in it broke the literal) and a string
/// `default`, which was written in its JSON spelling (`"a\/b"`, `"\u0001"`), and JSON's escapes aren't Swift's.
final class SpecStringEscapingTests: XCTestCase {

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
        #"{ "name": "api.\#(name)", "params": \#(params), "result": { "name": "R", "schema": \#(result) } }"#
    }

    private func ref(_ name: String) -> String { ##"{ "$ref": "#/components/schemas/\##(name)" }"## }

    private func assertContains(_ haystack: String, _ needle: String, file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertTrue(haystack.contains(needle), "Expected generated code to contain:\n\(needle)\n--- got ---\n\(haystack)", file: file, line: line)
    }

    private func assertNotContains(_ haystack: String, _ needle: String, file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertFalse(haystack.contains(needle), "Expected generated code not to contain:\n\(needle)\n--- got ---\n\(haystack)", file: file, line: line)
    }

    // The awkward strings, as JSON string content: `say "hi"`, `x\(1+1)`, `new⏎line`, `back\slash`.
    private let awkward = [#"say \"hi\""#, #"x\\(1+1)"#, #"new\nline"#, #"back\\slash"#]

    /// A record whose properties are named with the awkward strings.
    private var odd: String {
        let props = awkward.map { #""\#($0)": { "type": "string" }"# }.joined(separator: ", ")
        return #"{ "type": "object", "properties": { \#(props) }, "required": [\#(awkward.map { "\"\($0)\"" }.joined(separator: ", "))] }"#
    }

    private var mood: String { #"{ "type": "string", "enum": [\#(awkward.map { "\"\($0)\"" }.joined(separator: ", "))] }"# }

    /// A union of literal arms, one per awkward string, and a number so it isn't a plain string enum.
    private var pick: String {
        #"{ "anyOf": [\#(awkward.map { #"{ "const": "\#($0)" }"# }.joined(separator: ", ")), { "type": "number" }] }"#
    }

    private let defaults = #"""
    { "type": "object", "properties": {
        "note": { "type": "string", "default": "a/b \\(1+1)\n\u0001" },
        "plain": { "type": "string", "default": "plain" }
    } }
    """#

    private let code = #"{ "type": "object", "properties": { "code": { "type": "string", "pattern": "^a\nb$" } }, "required": ["code"] }"#

    // MARK: - The generated literals

    func testPropertyEnumAndLiteralArmSpellTheirStringsEscaped() throws {
        let output = try generate(
            schemas: #"{ "Odd": \#(odd), "Mood": \#(mood) }"#,
            methods: [method("pick", result: pick)]
        )
        for escaped in [#""say \"hi\"""#, #""x\\(1+1)""#, #""new\nline""#, #""back\\slash""#] {
            assertContains(output.models, " = \(escaped)\n")
            assertContains(output.api, "\(escaped)")
        }
        // Never live: no interpolation, no raw line break, no bare quote inside a literal.
        assertNotContains(output.models + output.api, #"x\(1+1)"#)
        assertNotContains(output.models + output.api, "new\nline")
        assertNotContains(output.models + output.api, #""say "hi"""#)
    }

    func testStringDefaultIsASwiftLiteralNotItsJSONSpelling() throws {
        let output = try generate(schemas: #"{ "Defaults": \#(defaults) }"#, methods: [method("get", result: ref("Defaults"))])
        // JSON writes `/` as `\/` and U+0001 as `\u0001`; neither is a Swift escape.
        assertContains(output.models, #"note: String? = "a/b \\(1+1)\n\u{1}""#)
        assertContains(output.models, #"plain: String? = "plain""#)
        assertNotContains(output.models, #"\/"#)
        assertNotContains(output.models, #"\u0001"#)
    }

    func testPatternWithALineBreakIsEscaped() throws {
        let output = try generate(schemas: #"{ "Code": \#(code) }"#, methods: [method("get", result: ref("Code"))])
        assertContains(output.models, #"guard code.range(of: "^a\nb$", options: .regularExpression) != nil"#)
        assertContains(output.models, #"throw CodegenError.validation("code must match pattern ^a\nb$")"#)
    }

    func testPlainStringsAreUnchanged() throws {
        let output = try generate(
            schemas: #"{ "Tag": { "type": "object", "properties": { "name": { "type": "string", "pattern": "^[A-Z]{3}$", "default": "ABC" } } } }"#,
            methods: [method("get", result: ref("Tag"))]
        )
        assertContains(output.models, #"name: String? = "ABC""#)
        assertContains(output.models, #"range(of: "^[A-Z]{3}$", options: .regularExpression)"#)
    }

    // MARK: - Compiled and run

    /// Builds the generated module and round-trips each awkward string through a property's key, an enum value, a
    /// literal arm and a default, from outside the module.
    func testAwkwardStringsCompileAndRoundTrip() throws {
        #if os(macOS)
        let output = try generate(
            schemas: #"{ "Odd": \#(odd), "Mood": \#(mood), "Defaults": \#(defaults), "Code": \#(code) }"#,
            methods: [
                method("odd", result: ref("Odd")),
                method("mood", result: ref("Mood")),
                method("pick", result: pick),
                method("defaults", result: ref("Defaults")),
                method("code", result: ref("Code"))
            ]
        )
        let main = ##"""
        import Foundation
        import BlocksRuntime
        import Generated

        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        func json<T: Encodable>(_ value: T) -> String {
            (try? encoder.encode(value)).map { String(decoding: $0, as: UTF8.self) } ?? "error"
        }
        func roundTrip<T: Codable>(_ text: String, as type: T.Type) -> String {
            guard let decoded = try? JSONDecoder().decode(T.self, from: Data(text.utf8)) else { return "error" }
            return json(decoded)
        }

        print(roundTrip(#"{"back\\slash":"b","new\nline":"n","say \"hi\"":"s","x\\(1+1)":"x"}"#, as: Odd.self))
        for text in [#""say \"hi\"""#, #""x\\(1+1)""#, #""new\nline""#, #""back\\slash""#] {
            print("\(roundTrip(text, as: Mood.self)) \(roundTrip(text, as: Api.Pick.Result.self))")
        }
        // What a live `\(1+1)` would have made of the literal.
        print("\(roundTrip(#""x2""#, as: Mood.self)) \(roundTrip(#""x2""#, as: Api.Pick.Result.self))")
        print(json(Defaults()))
        print(json(try Code(code: "a\nb")))
        do {
            _ = try Code(code: "ab")
        } catch let error as CodegenError {
            print(String(reflecting: error.message))
        }
        """##
        guard let run = try runConsumer(models: output.models, api: output.api, main: main) else { return }

        XCTAssertFalse(run.compilerOutput.contains("warning:"), "The generated module compiled with warnings:\n\(run.compilerOutput)")
        XCTAssertEqual(run.output.split(separator: "\n").map(String.init), [
            #"{"back\\slash":"b","new\nline":"n","say \"hi\"":"s","x\\(1+1)":"x"}"#,
            #""say \"hi\"" "say \"hi\"""#,
            #""x\\(1+1)" "x\\(1+1)""#,
            #""new\nline" "new\nline""#,
            #""back\\slash" "back\\slash""#,
            "error error",
            #"{"note":"a/b \\(1+1)\n\u0001","plain":"plain"}"#,
            #"{"code":"a\nb"}"#,
            #""code must match pattern ^a\nb$""#
        ])
        #else
        throw XCTSkip("Compiling and running the generated module needs the host toolchain (macOS only).")
        #endif
    }
}
