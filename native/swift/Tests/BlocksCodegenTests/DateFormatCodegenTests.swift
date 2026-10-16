//
// Copyright Amazon.com Inc. or its affiliates.
// All Rights Reserved.
//
// SPDX-License-Identifier: Apache-2.0
//

import XCTest
@testable import BlocksCodegen

/// The server sends a `Date` as its ISO 8601 string (`JSON.stringify` → `toISOString()`), and the spec says
/// `format: date-time`, which generates a `Date`. Every generated decode used a plain `JSONDecoder()`, which
/// expects a number, so no such result decoded, and requests sent a number. A result or a channel message that
/// holds a `Date` at any depth now decodes with `client.makeDecoder()`, which reads ISO 8601, and requests encode
/// with the client's encoder (BlocksRuntime). A union's `Date` arm encodes through a single-value container, so
/// the encoder's strategy applies. `format: date` (a calendar day, `"2026-10-05"`) is a `String`: a `Date` can't
/// tell a day from a date-time, and would be sent as one.
final class DateFormatCodegenTests: XCTestCase {

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

    private func object(_ properties: [String: String]) -> String {
        let props = properties.sorted { $0.key < $1.key }.map { "\"\($0.key)\": \($0.value)" }.joined(separator: ", ")
        let required = properties.keys.sorted().map { "\"\($0)\"" }.joined(separator: ", ")
        return #"{ "type": "object", "properties": { \#(props) }, "required": [\#(required)] }"#
    }

    private func array(_ items: String) -> String { #"{ "type": "array", "items": \#(items) }"# }
    private func ref(_ name: String) -> String { ##"{ "$ref": "#/components/schemas/\##(name)" }"## }
    private func channel(_ message: String) -> String {
        #"{ "x-blocks-transferable": "realtime/channel", "x-blocks-type-args": [\#(message)] }"#
    }

    private let string = #"{ "type": "string" }"#
    private let dateTime = #"{ "type": "string", "format": "date-time" }"#
    private let day = #"{ "type": "string", "format": "date" }"#
    private var event: String { object(["at": dateTime, "title": string]) }

    private func assertContains(_ haystack: String, _ needle: String, file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertTrue(haystack.contains(needle), "Expected generated code to contain:\n\(needle)\n--- got ---\n\(haystack)", file: file, line: line)
    }

    private func assertNotContains(_ haystack: String, _ needle: String, file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertFalse(haystack.contains(needle), "Expected generated code not to contain:\n\(needle)\n--- got ---\n\(haystack)", file: file, line: line)
    }

    func testResultsHoldingADateDecodeWithTheClientsDecoder() throws {
        let output = try generate(
            schemas: #"{ "Event": \#(event), "Agenda": \#(object(["events": array(ref("Event"))])) }"#,
            methods: [
                method("now", result: dateTime),
                method("maybeNow", result: #"{ "oneOf": [\#(dateTime), { "type": "null" }] }"#),
                method("getEvent", result: event),
                method("getHistory", result: array(dateTime)),
                method("getAgenda", result: ref("Agenda")),
                method("getByRoom", result: #"{ "type": "object", "additionalProperties": \#(ref("Event")) }"#)
            ]
        )

        assertContains(output.api, "return try client.makeDecoder().decode(Date.self, from: result)")
        assertContains(output.api, "guard let result else { return nil }\n        return try client.makeDecoder().decode(Date.self, from: result)")
        assertContains(output.api, "return try client.makeDecoder().decode(GetEvent.Result.self, from: result)")
        assertContains(output.api, "return try client.makeDecoder().decode([Date].self, from: result)")
        assertContains(output.api, "return try client.makeDecoder().decode(Agenda.self, from: result)")
        assertContains(output.api, "return try client.makeDecoder().decode([String: Event].self, from: result)")
        assertNotContains(output.api, "JSONDecoder()")
    }

    func testChannelMessageHoldingADateDecodesWithTheClientsDecoder() throws {
        let output = try generate(
            schemas: #"{ "Event": \#(event) }"#,
            methods: [method("getFeed", result: channel(ref("Event"))), method("getTitles", result: channel(string))]
        )

        assertContains(output.api, """
                return RealtimeChannel<Event>.fromJSON(descriptor, baseHost: BlocksClient.baseHost) { [client] data in
                    try client.makeDecoder().decode(Event.self, from: data)
                }
        """)
        assertContains(output.api, "try JSONDecoder().decode(String.self, from: data)")
    }

    func testResultWithoutADateKeepsAPlainDecoder() throws {
        let output = try generate(methods: [method("getDay", result: object(["day": day, "title": string]))])

        assertContains(output.api, "return try JSONDecoder().decode(GetDay.Result.self, from: result)")
        assertNotContains(output.api, "makeDecoder")
    }

    func testCalendarDayIsAString() throws {
        let output = try generate(methods: [method("book", params: "[\(param("on", day))]", result: object(["days": array(day)]))])

        assertContains(output.api, "public func book(on: String) async throws -> Book.Result")
        assertContains(output.api, "public let days: [String]")
        assertNotContains(output.api, "Date")
    }

    func testDateArmEncodesThroughTheEncoder() throws {
        let when = #"{ "anyOf": [\#(dateTime), \#(object(["after": dateTime]))] }"#
        let output = try generate(methods: [method("schedule", params: "[\(param("when", when))]", result: when)])

        assertContains(output.api, "case when_Variant0(Date)")
        assertContains(output.api, """
                        case .when_Variant0(let payload):
                            var container = encoder.singleValueContainer()
                            try container.encode(payload)
        """)
        // The result is the parameter's union.
        assertContains(output.api, "return try client.makeDecoder().decode(Schedule.When.self, from: result)")
    }

    // MARK: - Compiled and run

    /// Builds the generated module and calls it against a local JSON-RPC server that sends what AWS Blocks
    /// sends: dates as ISO 8601 strings. Checks what each request sent, and what each result decoded to.
    func testDatesCrossTheWireAsISOStrings() throws {
        #if os(macOS)
        let when = #"{ "anyOf": [\#(dateTime), \#(object(["after": dateTime]))] }"#
        let output = try generate(
            schemas: #"{ "Event": \#(event) }"#,
            methods: [
                method("echo", params: "[\(param("at", dateTime))]", result: dateTime),
                method("getEvent", params: "[\(param("event", ref("Event")))]", result: ref("Event")),
                method("getHistory", params: "[\(param("at", array(dateTime)))]", result: array(dateTime)),
                method("schedule", params: "[\(param("when", when))]", result: when),
                method("getByRoom", result: #"{ "type": "object", "additionalProperties": { "oneOf": [\#(dateTime), { "type": "null" }] } }"#),
                method("book", params: "[\(param("on", day))]", result: day),
                method("getFeed", result: channel(ref("Event")))
            ]
        )
        let main = ##"""
        import Foundation
        @testable import BlocksRuntime
        import Generated

        \##(Self.jsonRPCServerSource)

        let wire = "2026-10-05T12:34:56.789Z"
        let port = startJSONRPCServer { method, params, body in
            // The parameters as the server reads them, normalized with sorted keys, so the check holds whatever
            // order the encoder writes an object's keys in.
            let sent = (try? JSONSerialization.data(withJSONObject: params, options: [.sortedKeys])).map { String(decoding: $0, as: UTF8.self) }
            print("sent \(method): \(sent.map { #""params":\#($0)"# } ?? body)")
            switch method {
            case "api.getByRoom": return #"{"a":"\#(wire)","b":null}"#
            case "api.getFeed": return #"{"__blocks":"realtime/channel","channel":"c","wsUrl":"ws://127.0.0.1:1/ws","token":"t"}"#
            default:
                // Echo the first parameter back: what the client sent is what the server would return.
                guard let first = params.first,
                      let data = try? JSONSerialization.data(withJSONObject: first, options: [.fragmentsAllowed, .sortedKeys])
                else { return "null" }
                return String(decoding: data, as: UTF8.self)
            }
        }

        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let instant = formatter.date(from: wire)!
        let api = Api(server: BlocksServer(name: "local", url: "http://127.0.0.1:\(port)/aws-blocks/api"))
        do {
            print(formatter.string(from: try await api.echo(at: instant)))
            let event = try await api.getEvent(event: Event(at: instant, title: "launch"))
            print("\(event.title) \(formatter.string(from: event.at))")
            print(try await api.getHistory(at: [instant, instant]).map { formatter.string(from: $0) })
            if case .when_Variant0(let at) = try await api.schedule(when: .when_Variant0(instant)) {
                print(formatter.string(from: at))
            }
            if case .when_Variant1(let range) = try await api.schedule(when: .when_Variant1(Api.Schedule.When_Variant1(after: instant))) {
                print(formatter.string(from: range.after))
            }
            let rooms = try await api.getByRoom()
            print(rooms.keys.sorted().map { "\($0)=\(rooms[$0]!.map { formatter.string(from: $0) } ?? "nil")" })
            print(try await api.book(on: "2026-10-05"))
            let feed = try await api.getFeed()
            print(formatter.string(from: try feed.deserializer(Data(#"{"at":"\#(wire)","title":"t"}"#.utf8)).at))
        } catch {
            print("error: \(error)")
        }
        """##
        guard let run = try runConsumer(models: output.models, api: output.api, main: main, testableRuntime: true) else { return }

        XCTAssertFalse(run.compilerOutput.contains("warning:"), "The generated module compiled with warnings:\n\(run.compilerOutput)")
        let wire = "2026-10-05T12:34:56.789Z"
        XCTAssertEqual(run.output.split(separator: "\n").map(String.init), [
            #"sent api.echo: "params":["\#(wire)"]"#,
            wire,
            #"sent api.getEvent: "params":[{"at":"\#(wire)","title":"launch"}]"#,
            "launch \(wire)",
            #"sent api.getHistory: "params":[["\#(wire)","\#(wire)"]]"#,
            #"["\#(wire)", "\#(wire)"]"#,
            #"sent api.schedule: "params":["\#(wire)"]"#,
            wire,
            #"sent api.schedule: "params":[{"after":"\#(wire)"}]"#,
            wire,
            #"sent api.getByRoom: "params":[]"#,
            #"["a=\#(wire)", "b=nil"]"#,
            #"sent api.book: "params":["2026-10-05"]"#,
            "2026-10-05",
            #"sent api.getFeed: "params":[]"#,
            wire
        ])
        #else
        throw XCTSkip("Compiling and running the generated module needs the host toolchain (macOS only).")
        #endif
    }
}
