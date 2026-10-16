//
// Copyright Amazon.com Inc. or its affiliates.
// All Rights Reserved.
//
// SPDX-License-Identifier: Apache-2.0
//

import XCTest
@testable import BlocksCodegen

/// A channel's message type that the spec declares inline is generated as a type nested in the operation's enum
/// (`Api.GetChannel.ResultMessage`). The operation's method sits in `Api`, outside that enum, so its signature
/// must name the type qualified (`GetChannel.ResultMessage`), at any depth of the result or a parameter: a bare
/// `ResultMessage` doesn't compile. Inside the nested types, the bare name resolves and stays as it was.
final class TransferableTypeArgumentTests: XCTestCase {

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

    private func channel(_ message: String) -> String {
        #"{ "x-blocks-transferable": "realtime/channel", "x-blocks-type-args": [\#(message)] }"#
    }

    private func object(_ property: String) -> String {
        #"{ "type": "object", "properties": { "\#(property)": { "type": "string" } }, "required": ["\#(property)"] }"#
    }

    private let download = #"{ "x-blocks-transferable": "file-bucket/download" }"#
    private let upload = #"{ "x-blocks-transferable": "file-bucket/upload" }"#
    private let noteRef = ##"{ "$ref": "#/components/schemas/Note" }"##

    private func assertContains(_ haystack: String, _ needle: String, file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertTrue(haystack.contains(needle), "Expected generated code to contain:\n\(needle)\n--- got ---\n\(haystack)", file: file, line: line)
    }

    private func assertNotContains(_ haystack: String, _ needle: String, file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertFalse(haystack.contains(needle), "Expected generated code not to contain:\n\(needle)\n--- got ---\n\(haystack)", file: file, line: line)
    }

    // MARK: - A direct channel result (fixture 17)

    func testDirectChannelResultQualifiesItsInlineMessageType() throws {
        let output = try generate(methods: [method("getChannel", result: channel(object("message")))])

        assertContains(output.api, "public func getChannel() async throws -> RealtimeChannel<GetChannel.ResultMessage> {")
        assertNotContains(output.api, "RealtimeChannel<ResultMessage>")
        // The body already used the qualified name; it's unchanged.
        assertContains(output.api, "return RealtimeChannel<GetChannel.ResultMessage>.fromJSON(descriptor, baseHost: BlocksClient.baseHost) { data in")
        assertContains(output.api, "try JSONDecoder().decode(GetChannel.ResultMessage.self, from: data)")
        assertContains(output.api, "public enum GetChannel {\n\n        public struct ResultMessage: Codable {")
    }

    func testChannelWhoseInlineMessageHoldsAnotherInlineType() throws {
        let message = #"{ "type": "object", "properties": { "author": \#(object("name")) }, "required": ["author"] }"#
        let output = try generate(methods: [method("watch", result: channel(message))])

        assertContains(output.api, "public func watch() async throws -> RealtimeChannel<Watch.ResultMessage> {")
        // Inside the message struct, its own nested type is named bare, as Swift resolves it there.
        assertContains(output.api, "public let author: Author")
    }

    func testChannelOfAnArrayOfInlineMessages() throws {
        let output = try generate(methods: [method("batch", result: channel(#"{ "type": "array", "items": \#(object("text")) }"#))])

        assertContains(output.api, "public func batch() async throws -> RealtimeChannel<[Batch.ResultMessage]> {")
    }

    func testChannelOfAnInlineEnum() throws {
        let output = try generate(methods: [method("status", result: channel(#"{ "type": "string", "enum": ["up", "down"] }"#))])

        assertContains(output.api, "public func status() async throws -> RealtimeChannel<Status.ResultMessage> {")
    }

    // MARK: - Channels inside a container result

    func testListOfChannelsResult() throws {
        let output = try generate(methods: [method("feeds", result: #"{ "type": "array", "items": \#(channel(object("text"))) }"#)])

        assertContains(output.api, "public func feeds() async throws -> [RealtimeChannel<Feeds.ResultMessage>] {")
        assertContains(output.api, "return try JSONDecoder().decode([RealtimeChannel<Feeds.ResultMessage>].self, from: result)")
    }

    func testNullableChannelResult() throws {
        let output = try generate(methods: [method("maybe", result: #"{ "oneOf": [\#(channel(object("text"))), { "type": "null" }] }"#)])

        assertContains(output.api, "public func maybe() async throws -> RealtimeChannel<Maybe.ResultMessage>? {")
        // A nullable bound transferable hydrates from its descriptor, as a direct one does (#656).
        assertContains(output.api, "guard let result else { return nil }")
        assertContains(output.api, "return RealtimeChannel<Maybe.ResultMessage>.fromJSON(descriptor, baseHost: BlocksClient.baseHost)")
    }

    func testMapAndNestedContainerChannelResults() throws {
        let output = try generate(methods: [
            method("byUser", result: #"{ "type": "object", "additionalProperties": \#(channel(object("who"))) }"#),
            method("grouped", result: #"{ "type": "object", "additionalProperties": { "type": "array", "items": \#(channel(object("text"))) } }"#),
            method("sparse", result: #"{ "type": "array", "items": { "oneOf": [\#(channel(object("text"))), { "type": "null" }] } }"#)
        ])

        assertContains(output.api, "public func byUser() async throws -> [String: RealtimeChannel<ByUser.ResultValueMessage>] {")
        assertContains(output.api, "public func grouped() async throws -> [String: [RealtimeChannel<Grouped.ResultValueMessage>]] {")
        assertContains(output.api, "public func sparse() async throws -> [RealtimeChannel<Sparse.ResultMessage>?] {")
    }

    // MARK: - A channel parameter

    func testChannelParameterQualifiesItsInlineMessageType() throws {
        let params = #"[{ "name": "feed", "required": true, "schema": \#(channel(object("text"))) }]"#
        let output = try generate(methods: [method("forward", params: params, result: #"{ "type": "string" }"#)])

        assertContains(output.api, "public func forward(feed: RealtimeChannel<Forward.FeedMessage>) async throws -> String {")
    }

    // MARK: - Unchanged

    func testNamedAndPrimitiveMessageTypesAndFileHandlesAreUnchanged() throws {
        let output = try generate(
            schemas: #"{ "Note": \#(object("title")) }"#,
            methods: [
                method("notes", result: channel(noteRef)),
                method("ticks", result: channel(#"{ "type": "string" }"#)),
                method("untyped", result: #"{ "x-blocks-transferable": "realtime/channel" }"#),
                method("files", result: #"{ "type": "array", "items": \#(download) }"#),
                method("upload", result: #"{ "oneOf": [\#(upload), { "type": "null" }] }"#)
            ]
        )

        assertContains(output.api, "public func notes() async throws -> RealtimeChannel<Note> {")
        assertContains(output.api, "public func ticks() async throws -> RealtimeChannel<String> {")
        assertContains(output.api, "public func untyped() async throws -> RealtimeChannel<JSONValue> {")
        assertContains(output.api, "public func files() async throws -> [FileDownloadHandle] {")
        assertContains(output.api, "public func upload() async throws -> FileUploadHandle? {")
    }

    func testChannelFieldsInsideNestedTypesKeepTheBareName() throws {
        let result = #"""
        { "type": "object", "properties": {
            "feed": \#(channel(object("text"))),
            "inner": { "type": "object", "properties": { "count": \#(channel(object("n"))) }, "required": ["count"] }
        }, "required": ["feed", "inner"] }
        """#
        let output = try generate(
            schemas: #"{ "Board": { "type": "object", "properties": { "feed": \#(channel(object("text"))) }, "required": ["feed"] } }"#,
            methods: [method("session", result: result)]
        )

        assertContains(output.api, "public func session() async throws -> Session.Result {")
        assertContains(output.api, "public let feed: RealtimeChannel<FeedMessage>")
        assertContains(output.api, "public let count: RealtimeChannel<CountMessage>")
        assertContains(output.models, "public let feed: RealtimeChannel<FeedMessage>")
    }

    // MARK: - Compiles as its own module

    func testEveryShapeCompilesAndIsNameableFromAnotherModule() throws {
        #if os(macOS)
        let output = try generate(
            schemas: #"{ "Note": \#(object("title")) }"#,
            methods: [
                method("getChannel", result: channel(object("message"))),
                method("feeds", result: #"{ "type": "array", "items": \#(channel(object("text"))) }"#),
                method("maybe", result: #"{ "oneOf": [\#(channel(object("text"))), { "type": "null" }] }"#),
                method("byUser", result: #"{ "type": "object", "additionalProperties": \#(channel(object("who"))) }"#),
                method("batch", result: channel(#"{ "type": "array", "items": \#(object("text")) }"#)),
                method("forward", params: #"[{ "name": "feed", "required": true, "schema": \#(channel(object("text"))) }]"#,
                       result: #"{ "type": "string" }"#),
                method("notes", result: channel(noteRef))
            ]
        )
        let consumer = """
        import BlocksRuntime
        import Generated

        func consume(_ api: Api, feed: RealtimeChannel<Api.Forward.FeedMessage>) async throws {
            let direct: RealtimeChannel<Api.GetChannel.ResultMessage> = try await api.getChannel()
            let list: [RealtimeChannel<Api.Feeds.ResultMessage>] = try await api.feeds()
            let maybe: RealtimeChannel<Api.Maybe.ResultMessage>? = try await api.maybe()
            let byUser: [String: RealtimeChannel<Api.ByUser.ResultValueMessage>] = try await api.byUser()
            let batch: RealtimeChannel<[Api.Batch.ResultMessage]> = try await api.batch()
            let echoed: String = try await api.forward(feed: feed)
            let notes: RealtimeChannel<Note> = try await api.notes()
            _ = (direct, list, maybe, byUser, batch, echoed, notes)
            _ = Api.GetChannel.ResultMessage(message: "hi")
        }
        """
        try typecheckConsumer(models: output.models, api: output.api, consumer: consumer)
        #else
        throw XCTSkip("Compiling a second module needs the host toolchain (macOS only).")
        #endif
    }
}
