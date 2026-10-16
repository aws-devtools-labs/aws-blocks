//
// Copyright Amazon.com Inc. or its affiliates.
// All Rights Reserved.
//
// SPDX-License-Identifier: Apache-2.0
//

import XCTest
@testable import BlocksCodegen

/// JSON-RPC params are positional: the server calls the method with `params` as its argument list
/// (`parseRpcRequest` in `packages/core`). The TypeScript client sends an optional argument that's left out before a
/// set one as `null` in its slot, and leaves trailing unset ones off: `f('a', undefined, 'c')` sends `["a",null,"c"]`,
/// `f('a')` sends `["a"]`. The Swift client appended only the trailing optional arguments that were set
/// (`if let b { _params.append(b) }`), so `send(a: "a", c: "c")` sent `["a","c"]`, which the server read as
/// `b = "c"`. Each argument now keeps its slot, with `JSONValue.null` for a left-out one before a set one.
final class OptionalParameterSlotTests: XCTestCase {

    private func generate(methods: [String]) throws -> String {
        let json = """
        {
            "openrpc": "1.3.2",
            "info": { "title": "test", "version": "1.0.0" },
            "methods": [\(methods.joined(separator: ", "))]
        }
        """
        let rpcModel = try OpenRPCParser().parse(data: Data(json.utf8))
        return SwiftCodeGenerator().generate(from: CodegenModelBuilder().build(from: rpcModel)).api
    }

    private func method(_ name: String, params: [String], result: String = #"{ "type": "string" }"#) -> String {
        """
        { "name": "api.\(name)", "params": [\(params.joined(separator: ", "))], "result": { "name": "R", "schema": \(result) } }
        """
    }

    private func param(_ name: String, _ schema: String = #"{ "type": "string" }"#, required: Bool) -> String {
        #"{ "name": "\#(name)", "required": \#(required), "schema": \#(schema) }"#
    }

    private let nullableString = #"{ "oneOf": [{ "type": "string" }, { "type": "null" }] }"#

    private func assertContains(_ haystack: String, _ needle: String, file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertTrue(haystack.contains(needle), "Expected generated code to contain:\n\(needle)\n--- got ---\n\(haystack)", file: file, line: line)
    }

    func testLeftOutOptionalBeforeASetOneSendsNullInItsSlot() throws {
        let api = try generate(methods: [
            method("send", params: [param("a", required: true), param("b", required: false), param("c", required: false)])
        ])
        assertContains(api, """
                var _params: [any Encodable] = [a]
                if let b { _params.append(b) } else if c != nil { _params.append(JSONValue.null) }
                if let c { _params.append(c) }
                let request = BlocksRequest(method: "api.send", params: _params, id: BlocksRequest.nextId())
        """)
    }

    func testEveryTrailingOptionalButTheLastHoldsItsSlotForAnyLaterOne() throws {
        let api = try generate(methods: [
            method("all", params: [param("a", required: false), param("b", required: false), param("c", required: false)])
        ])
        assertContains(api, """
                var _params: [any Encodable] = []
                if let a { _params.append(a) } else if b != nil || c != nil { _params.append(JSONValue.null) }
                if let b { _params.append(b) } else if c != nil { _params.append(JSONValue.null) }
                if let c { _params.append(c) }
        """)
    }

    func testASingleTrailingOptionalAndOneBeforeARequiredOneAreUnchanged() throws {
        let api = try generate(methods: [
            method("find", params: [param("id", required: true), param("name", required: false)]),
            method("lead", params: [param("a", required: false), param("b", required: true)])
        ])
        assertContains(api, """
                var _params: [any Encodable] = [id]
                if let name { _params.append(name) }
        """)
        // An optional argument before a required one already kept its slot: a nil `String?` encodes as `null`.
        assertContains(api, #"let request = BlocksRequest(method: "api.lead", params: [a, b], id: BlocksRequest.nextId())"#)
    }

    func testParameterNamedJSONValueTakesAnInternalName() throws {
        let api = try generate(methods: [
            method("send", params: [param("JSONValue", required: false), param("b", required: false)])
        ])
        assertContains(api, "public func send(JSONValue JSONValue_2: String? = nil, b: String? = nil) async throws -> String {")
        assertContains(api, "if let JSONValue_2 { _params.append(JSONValue_2) } else if b != nil { _params.append(JSONValue.null) }")
    }

    /// The spec generator writes every TypeScript `x?: T` as an optional parameter whose schema is nullable
    /// (`oneOf [T, null]`), so its Swift type is already `T?`. It had no `= nil` default, unlike an optional parameter
    /// whose schema isn't nullable, so a caller couldn't leave it out (`echoArgs(first: "a", middle: nil, last: "c")`).
    /// An optional parameter now defaults to `nil` whatever its schema; passing `nil` still compiles.
    func testOptionalNullableParameterDefaultsToNil() throws {
        let api = try generate(methods: [
            method("echo", params: [
                param("first", required: true), param("middle", nullableString, required: false),
                param("last", nullableString, required: false)
            ])
        ])
        assertContains(api, "public func echo(first: String, middle: String? = nil, last: String? = nil) async throws -> String {")
    }

    /// A required parameter keeps no default, nullable or not: the caller says what it sends, as before.
    func testRequiredNullableParameterHasNoDefault() throws {
        let api = try generate(methods: [
            method("put", params: [param("value", nullableString, required: true), param("note", required: false)])
        ])
        assertContains(api, "public func put(value: String?, note: String? = nil) async throws -> String {")
    }

    /// Builds the generated module and calls it against a local JSON-RPC server, which prints the params it got.
    func testArgumentsReachTheServerInTheirSlots() throws {
        #if os(macOS)
        let object = #"{ "type": "object", "properties": { "x": { "type": "string" } }, "required": ["x"] }"#
        let dateTime = #"{ "type": "string", "format": "date-time" }"#
        let api = try generate(methods: [
            method("send", params: [param("a", required: true), param("b", required: false), param("c", required: false)]),
            method("lead", params: [param("a", required: false), param("b", required: true)]),
            method("mix", params: [
                param("a", required: false), param("b", required: true), param("c", object, required: false),
                param("d", #"{ "type": "boolean" }"#, required: false)
            ]),
            method("stamp", params: [param("at", dateTime, required: false), param("note", required: false)]),
            method("echoArgs", params: [
                param("first", required: true), param("middle", nullableString, required: false),
                param("last", nullableString, required: false)
            ])
        ])
        let main = ##"""
        import Foundation
        import BlocksRuntime
        import Generated

        \##(Self.jsonRPCServerSource)

        let port = startJSONRPCServer { method, params, _ in
            let sent = (try? JSONSerialization.data(withJSONObject: params, options: [.sortedKeys, .fragmentsAllowed]))
                .map { String(decoding: $0, as: UTF8.self) } ?? "?"
            print("\(method) \(sent)")
            return #""ok""#
        }
        let api = Api(server: BlocksServer(name: "local", url: "http://127.0.0.1:\(port)/aws-blocks/api"))
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let instant = formatter.date(from: "2026-10-05T12:34:56.789Z")!
        do {
            _ = try await api.send(a: "a", c: "c")
            _ = try await api.send(a: "a", b: "b")
            _ = try await api.send(a: "a")
            _ = try await api.send(a: "a", b: "b", c: "c")
            _ = try await api.lead(b: "b")
            _ = try await api.mix(b: "b", d: true)
            _ = try await api.mix(a: "a", b: "b", c: Api.Mix.C(x: "x"))
            _ = try await api.stamp(note: "n")
            _ = try await api.stamp(at: instant, note: "n")
            _ = try await api.echoArgs(first: "a", last: "c")
            _ = try await api.echoArgs(first: "a")
            _ = try await api.echoArgs(first: "a", middle: nil, last: nil)
        } catch {
            print("error: \(error)")
        }
        """##
        guard let run = try runConsumer(models: "", api: api, main: main) else { return }

        XCTAssertFalse(run.compilerOutput.contains("warning:"), "The generated module compiled with warnings:\n\(run.compilerOutput)")
        XCTAssertEqual(run.output.split(separator: "\n").map(String.init), [
            #"api.send ["a",null,"c"]"#,
            #"api.send ["a","b"]"#,
            #"api.send ["a"]"#,
            #"api.send ["a","b","c"]"#,
            #"api.lead [null,"b"]"#,
            #"api.mix [null,"b",null,true]"#,
            #"api.mix ["a","b",{"x":"x"}]"#,
            #"api.stamp [null,"n"]"#,
            #"api.stamp ["2026-10-05T12:34:56.789Z","n"]"#,
            #"api.echoArgs ["a",null,"c"]"#,
            #"api.echoArgs ["a"]"#,
            #"api.echoArgs ["a"]"#
        ])
        #else
        throw XCTSkip("Compiling and running the generated module needs the host toolchain (macOS only).")
        #endif
    }
}
