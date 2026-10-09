//
// Copyright Amazon.com Inc. or its affiliates.
// All Rights Reserved.
//
// SPDX-License-Identifier: Apache-2.0
//

import XCTest
@testable import BlocksCodegen

/// An operation that returns a realtime channel directly decodes each message with the closure it passes to
/// `RealtimeChannel.fromJSON`. That closure always used `JSONDecoder()`, so a message holding an OIDC client
/// (fixture 31's `getSignInFeed`, `RealtimeChannel<SignInOption>`) threw on every message: an `OIDCClient`
/// decodes only with the calling `BlocksClient` in `userInfo`. Such a message now decodes with
/// `client.makeDecoder()`, as a result holding an OIDC client already did. A channel inside a model was fine.
final class ChannelMessageDecoderTests: XCTestCase {

    private func generate(methods: [String]) throws -> GeneratedSources {
        let json = """
        {
            "openrpc": "1.3.2",
            "info": { "title": "test", "version": "1.0.0" },
            "methods": [\(methods.joined(separator: ", "))],
            "components": { "schemas": {
                "Note": { "type": "object", "properties": { "text": { "type": "string" } }, "required": ["text"] },
                "SignInOption": { "type": "object", "properties": {
                    "label": { "type": "string" }, "client": { "x-blocks-transferable": "oidc/client" }
                }, "required": ["label", "client"] }
            } }
        }
        """
        let rpcModel = try OpenRPCParser().parse(data: Data(json.utf8))
        return SwiftCodeGenerator().generate(from: CodegenModelBuilder().build(from: rpcModel))
    }

    private func channelMethod(_ name: String, message: String) -> String {
        """
        { "name": "api.\(name)", "params": [], "result": { "name": "R", "schema": {
            "x-blocks-transferable": "realtime/channel", "x-blocks-type-args": [\(message)] } } }
        """
    }

    private func ref(_ name: String) -> String { ##"{ "$ref": "#/components/schemas/\##(name)" }"## }

    private func assertContains(_ haystack: String, _ needle: String, file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertTrue(haystack.contains(needle), "Expected generated code to contain:\n\(needle)\n--- got ---\n\(haystack)", file: file, line: line)
    }

    private func assertNotContains(_ haystack: String, _ needle: String, file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertFalse(haystack.contains(needle), "Expected generated code not to contain:\n\(needle)\n--- got ---\n\(haystack)", file: file, line: line)
    }

    func testMessageHoldingAnOIDCClientDecodesWithTheClient() throws {
        let output = try generate(methods: [channelMethod("getSignInFeed", message: ref("SignInOption"))])

        assertContains(output.api, """
                return RealtimeChannel<SignInOption>.fromJSON(descriptor, baseHost: BlocksClient.baseHost) { [client] data in
                    try client.makeDecoder().decode(SignInOption.self, from: data)
                }
        """)
        assertNotContains(output.api, "JSONDecoder()")
    }

    func testOIDCClientAtAnyDepthInTheMessage() throws {
        let inline = #"{ "type": "object", "properties": { "options": { "type": "array", "items": \#(ref("SignInOption")) } }, "required": ["options"] }"#
        let output = try generate(methods: [
            channelMethod("getClients", message: #"{ "type": "array", "items": { "x-blocks-transferable": "oidc/client" } }"#),
            channelMethod("getMenu", message: inline),
            channelMethod("getByTenant", message: #"{ "type": "object", "additionalProperties": \#(ref("SignInOption")) }"#)
        ])

        assertContains(output.api, "try client.makeDecoder().decode([OIDCClient].self, from: data)")
        assertContains(output.api, "try client.makeDecoder().decode(GetMenu.ResultMessage.self, from: data)")
        assertContains(output.api, "try client.makeDecoder().decode([String: SignInOption].self, from: data)")
        assertNotContains(output.api, "JSONDecoder()")
    }

    func testMessageWithoutAnOIDCClientKeepsAPlainDecoder() throws {
        let output = try generate(methods: [
            channelMethod("getNotes", message: ref("Note")),
            channelMethod("getFiles", message: #"{ "type": "array", "items": { "x-blocks-transferable": "file-bucket/download" } }"#)
        ])

        assertContains(output.api, """
                return RealtimeChannel<Note>.fromJSON(descriptor, baseHost: BlocksClient.baseHost) { data in
                    try JSONDecoder().decode(Note.self, from: data)
                }
        """)
        assertContains(output.api, "try JSONDecoder().decode([FileDownloadHandle].self, from: data)")
        assertNotContains(output.api, "makeDecoder")
    }

    /// Builds the generated module, serves the channel descriptors from a local HTTP server, and decodes a
    /// message through each channel the generated operation returns.
    func testGeneratedChannelDecodesAMessageHoldingAnOIDCClient() throws {
        #if os(macOS)
        let output = try generate(methods: [
            channelMethod("getSignInFeed", message: ref("SignInOption")),
            channelMethod("getNotes", message: ref("Note"))
        ])
        let main = ##"""
        import Foundation
        @testable import BlocksRuntime
        import Generated

        // A one-request-per-connection HTTP server on a free port that answers every JSON-RPC call with `result`.
        let result = #"{"__blocks":"realtime/channel","channel":"c","wsUrl":"ws://127.0.0.1:1/ws","token":"t"}"#
        let listener = socket(AF_INET, SOCK_STREAM, 0)
        var address = sockaddr_in()
        address.sin_family = sa_family_t(AF_INET)
        address.sin_addr.s_addr = inet_addr("127.0.0.1")
        var length = socklen_t(MemoryLayout<sockaddr_in>.size)
        _ = withUnsafePointer(to: &address) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(listener, $0, length) } }
        _ = listen(listener, 4)
        _ = withUnsafeMutablePointer(to: &address) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { getsockname(listener, $0, &length) }
        }
        let port = UInt16(bigEndian: address.sin_port)
        Thread.detachNewThread {
            while true {
                let connection = accept(listener, nil, nil)
                guard connection >= 0 else { return }
                var request = Data()
                var buffer = [UInt8](repeating: 0, count: 4096)
                while true {
                    let count = read(connection, &buffer, buffer.count)
                    guard count > 0 else { break }
                    request.append(contentsOf: buffer[0 ..< count])
                    let text = String(decoding: request, as: UTF8.self)
                    guard let end = text.range(of: "\r\n\r\n") else { continue }
                    let header = text[..<end.lowerBound].lowercased()
                    let declared = header.components(separatedBy: "\r\n")
                        .first { $0.hasPrefix("content-length:") }
                        .flatMap { Int($0.dropFirst("content-length:".count).trimmingCharacters(in: .whitespaces)) } ?? 0
                    if text[end.upperBound...].utf8.count >= declared { break }
                }
                let body = #"{"jsonrpc":"2.0","id":1,"result":\#(result)}"#
                let response = "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: \(body.utf8.count)\r\n"
                    + "Connection: close\r\n\r\n\(body)"
                _ = response.withCString { write(connection, $0, strlen($0)) }
                close(connection)
            }
        }

        let api = Api(server: BlocksServer(name: "local", url: "http://127.0.0.1:\(port)/aws-blocks/api"))
        let oidc = #"{"__blocks":"oidc/client","providers":["google"],"exchangePath":"/auth/exchange","signOutPath":"/auth/signout"}"#
        do {
            let feed = try await api.getSignInFeed()
            let option = try feed.deserializer(Data(#"{"label":"Google","client":\#(oidc)}"#.utf8))
            print("\(option.label) \(option.client.providers) \(option.client.exchangePath)")
            let notes = try await api.getNotes()
            print(try notes.deserializer(Data(#"{"text":"hi"}"#.utf8)).text)
        } catch {
            print("error: \(error)")
        }
        """##
        guard let run = try runConsumer(models: output.models, api: output.api, main: main, testableRuntime: true) else { return }

        XCTAssertFalse(run.compilerOutput.contains("warning:"), "The generated module compiled with warnings:\n\(run.compilerOutput)")
        XCTAssertEqual(run.output.split(separator: "\n").map(String.init), [
            #"Google ["google"] /auth/exchange"#,
            "hi"
        ])
        #else
        throw XCTSkip("Compiling and running the generated module needs the host toolchain (macOS only).")
        #endif
    }
}
