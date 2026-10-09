//
// Copyright Amazon.com Inc. or its affiliates.
// All Rights Reserved.
//
// SPDX-License-Identifier: Apache-2.0
//

import XCTest
@testable import BlocksCodegen

/// A union arm that is a transferable (`anyOf [channel<Note>, {…}]`) was a payload-less case: it decoded to a
/// case without the channel, and encoded `{}`. It now carries the transferable (`case result_Variant0(
/// RealtimeChannel<Note>)`), decoded from its descriptor like a transferable in a field. A result with an OIDC
/// client arm decodes with `client.makeDecoder()`. In a discriminated union, a transferable arm (an object on the
/// wire, like a map arm) is tried only when the discriminator is missing.
final class TransferableUnionArmTests: XCTestCase {

    private func generate(methods: [String]) throws -> GeneratedSources {
        let json = """
        {
            "openrpc": "1.3.2",
            "info": { "title": "test", "version": "1.0.0" },
            "methods": [\(methods.joined(separator: ", "))],
            "components": { "schemas": {
                "Note": { "type": "object", "properties": { "text": { "type": "string" } }, "required": ["text"] }
            } }
        }
        """
        let rpcModel = try OpenRPCParser().parse(data: Data(json.utf8))
        return SwiftCodeGenerator().generate(from: CodegenModelBuilder().build(from: rpcModel))
    }

    private func method(_ name: String, result: String) -> String {
        """
        { "name": "api.\(name)", "params": [], "result": { "name": "R", "schema": \(result) } }
        """
    }

    private func object(_ properties: [String: String]) -> String {
        let props = properties.sorted { $0.key < $1.key }.map { "\"\($0.key)\": \($0.value)" }.joined(separator: ", ")
        let required = properties.keys.sorted().map { "\"\($0)\"" }.joined(separator: ", ")
        return #"{ "type": "object", "properties": { \#(props) }, "required": [\#(required)] }"#
    }

    private func anyOf(_ members: String...) -> String { #"{ "anyOf": [\#(members.joined(separator: ", "))] }"# }
    private func oneOf(_ members: String...) -> String { #"{ "oneOf": [\#(members.joined(separator: ", "))] }"# }
    private func transferable(_ kind: String) -> String { #"{ "x-blocks-transferable": "\#(kind)" }"# }
    private func channel(_ message: String) -> String {
        #"{ "x-blocks-transferable": "realtime/channel", "x-blocks-type-args": [\#(message)] }"#
    }

    private let string = #"{ "type": "string" }"#
    private let note = ##"{ "$ref": "#/components/schemas/Note" }"##
    private var failure: String { object(["error": string]) }

    private func assertContains(_ haystack: String, _ needle: String, file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertTrue(haystack.contains(needle), "Expected generated code to contain:\n\(needle)\n--- got ---\n\(haystack)", file: file, line: line)
    }

    private func assertNotContains(_ haystack: String, _ needle: String, file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertFalse(haystack.contains(needle), "Expected generated code not to contain:\n\(needle)\n--- got ---\n\(haystack)", file: file, line: line)
    }

    func testTransferableArmsCarryTheirValue() throws {
        let output = try generate(methods: [
            method("openFeed", result: anyOf(channel(note), failure)),
            method("download", result: anyOf(transferable("file-bucket/download"), transferable("file-bucket/upload"), failure)),
            method("signIn", result: anyOf(transferable("oidc/client"), failure))
        ])

        assertContains(output.api, "case result_Variant0(RealtimeChannel<Note>)")
        assertContains(output.api, "self = .result_Variant0(try decoder.singleValueContainer().decode(RealtimeChannel<Note>.self))")
        assertContains(output.api, "case result_Variant0(FileDownloadHandle)")
        assertContains(output.api, "case result_Variant1(FileUploadHandle)")
        assertContains(output.api, "case result_Variant0(OIDCClient)")
        // An OIDC client decodes only with the calling client.
        assertContains(output.api, "return try client.makeDecoder().decode(SignIn.Result.self, from: result)")
        assertContains(output.api, "return try JSONDecoder().decode(OpenFeed.Result.self, from: result)")
        assertNotContains(output.api, "EmptyKey.self)")
    }

    func testChannelArmWithAnInlineMessage() throws {
        let output = try generate(methods: [method("openFeed", result: anyOf(channel(object(["text": string])), failure))])

        assertContains(output.api, "case result_Variant0(RealtimeChannel<Result_Variant0Message>)")
        assertContains(output.api, "public struct Result_Variant0Message: Codable {")
    }

    func testDiscriminatedUnionTriesATransferableArmOnlyWithoutTheDiscriminator() throws {
        let ready = object(["status": #"{ "const": "ready" }"#, "id": string])
        let busy = object(["status": #"{ "const": "busy" }"#])
        let output = try generate(methods: [method("join", result: oneOf(ready, busy, channel(note)))])

        assertContains(output.api, """
                        let container = try decoder.container(keyedBy: CodingKeys.self)
                        if !container.contains(.status), let value = try? decoder.singleValueContainer().decode(RealtimeChannel<Note>.self) {
        """)
    }

    // MARK: - Compiled and run

    /// Builds the generated module and calls it against a local JSON-RPC server that returns either arm.
    func testTransferableArmsDecodeFromTheServersDescriptors() throws {
        #if os(macOS)
        let ready = object(["status": #"{ "const": "ready" }"#, "id": string])
        let busy = object(["status": #"{ "const": "busy" }"#])
        let output = try generate(methods: [
            method("openFeed", result: anyOf(channel(note), failure)),
            method("openFailing", result: anyOf(channel(note), failure)),
            method("signIn", result: anyOf(transferable("oidc/client"), failure)),
            method("join", result: oneOf(ready, busy, channel(note))),
            method("joinReady", result: oneOf(ready, busy, channel(note)))
        ])
        let main = ##"""
        import Foundation
        @testable import BlocksRuntime
        import Generated

        \##(Self.jsonRPCServerSource)

        let channel = #"{"__blocks":"realtime/channel","channel":"app/notes","token":"t","wsUrl":"ws://127.0.0.1:1/ws"}"#
        let oidc = #"{"__blocks":"oidc/client","exchangePath":"/auth/exchange","providers":["google"],"signOutPath":"/auth/signout"}"#
        let port = startJSONRPCServer { method, _, _ in
            switch method {
            case "api.openFeed", "api.join": return channel
            case "api.signIn": return oidc
            case "api.joinReady": return #"{"id":"r1","status":"ready"}"#
            default: return #"{"error":"closed"}"#
            }
        }

        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        func encoded<T: Encodable>(_ value: T) throws -> String { String(decoding: try encoder.encode(value), as: UTF8.self) }

        let api = Api(server: BlocksServer(name: "local", url: "http://127.0.0.1:\(port)/aws-blocks/api"))
        do {
            let feed = try await api.openFeed()
            if case .result_Variant0(let notes) = feed {
                print("\(notes.channel) \(try notes.deserializer(Data(#"{"text":"hi"}"#.utf8)).text)")
            }
            // It encodes back to the descriptor the server sent.
            print(try encoded(feed))
            if case .result_Variant1(let failure) = try await api.openFailing() { print(failure.error) }
            if case .result_Variant0(let client) = try await api.signIn() { print("\(client.providers) \(client.exchangePath)") }
            if case .result_Variant2(let notes) = try await api.join() { print(notes.channel) }
            if case .ready(let ready) = try await api.joinReady() { print(ready.id) }
        } catch {
            print("error: \(error)")
        }
        """##
        guard let run = try runConsumer(models: output.models, api: output.api, main: main, testableRuntime: true) else { return }

        XCTAssertFalse(run.compilerOutput.contains("warning:"), "The generated module compiled with warnings:\n\(run.compilerOutput)")
        XCTAssertEqual(run.output.split(separator: "\n").map(String.init), [
            "app/notes hi",
            #"{"__blocks":"realtime\/channel","channel":"app\/notes","token":"t","wsUrl":"ws:\/\/127.0.0.1:1\/ws"}"#,
            "closed",
            #"["google"] /auth/exchange"#,
            "app/notes",
            "r1"
        ])
        #else
        throw XCTSkip("Compiling and running the generated module needs the host toolchain (macOS only).")
        #endif
    }
}
