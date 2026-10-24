//
// Copyright Amazon.com Inc. or its affiliates.
// All Rights Reserved.
//
// SPDX-License-Identifier: Apache-2.0
//

import XCTest
@testable import BlocksRuntime

// swiftlint:disable nesting
/// Decode coverage for transferables nested in a result. `GetSession.Result` mirrors the generated golden
/// `native/codegen-fixtures/25-nested-transferable-operation-result/swift/Api.swift`, and `Files` holds file
/// handles as the generator emits them. If the generator output changes, regenerate the golden and update this mirror.
final class NestedTransferableDecodeTests: XCTestCase {

    enum GetSession {
        struct Result: Codable {
            let channel: RealtimeChannel<ChannelMessage>
            let event: Event
            let inner: Inner
            let integerValues: RealtimeChannel<[Int]>
            let sessionId: String
            let stringValues: RealtimeChannel<[String]>

            struct ChannelMessage: Codable {
                let text: String
            }

            struct Message: Codable {
                let channel: RealtimeChannel<ChannelMessage>

                struct ChannelMessage: Codable {
                    let body: String
                }
            }

            struct Presence: Codable {
                let channel: RealtimeChannel<ChannelMessage>

                struct ChannelMessage: Codable {
                    let online: Bool
                }
            }

            enum Event: Codable {
                case message(Message)
                case presence(Presence)

                enum CodingKeys: String, CodingKey {
                    case kind
                }

                func encode(to encoder: Encoder) throws {
                    var container = encoder.container(keyedBy: CodingKeys.self)
                    switch self {
                    case .message(let params):
                        try container.encode("message", forKey: .kind)
                        try params.encode(to: encoder)
                    case .presence(let params):
                        try container.encode("presence", forKey: .kind)
                        try params.encode(to: encoder)
                    }
                }

                init(from decoder: Decoder) throws {
                    let container = try decoder.container(keyedBy: CodingKeys.self)
                    let disc = try container.decode(String.self, forKey: .kind)
                    switch disc {
                    case "message": self = .message(try Message(from: decoder))
                    case "presence": self = .presence(try Presence(from: decoder))
                    default:
                        throw DecodingError.dataCorruptedError(forKey: .kind, in: container, debugDescription: "Unknown value: \(disc)")
                    }
                }
            }

            struct Inner: Codable {
                let channel: RealtimeChannel<ChannelMessage>

                struct ChannelMessage: Codable {
                    let count: Int
                }
            }
        }
    }

    struct Files: Codable {
        let download: FileDownloadHandle
        let thumbnail: FileDownloadHandle?
        let uploads: [FileUploadHandle]
    }

    /// Captures the descriptor a nested transferable's `init(from:)` reads.
    private struct DescriptorProbe: Decodable {
        let json: [String: Any]

        init(from decoder: Decoder) throws {
            self.json = try TransferableCoding.descriptor(from: decoder)
        }
    }

    /// A `realtime/channel` descriptor as the server sends it, for channel `app/<name>`.
    private func channelDescriptor(_ name: String, wsUrl: String = "wss://example.com/rt") -> String {
        #"{"__blocks":"realtime/channel","channel":"app/\#(name)","wsUrl":"\#(wsUrl)","connectToken":"c-\#(name)","token":"t-\#(name)"}"#
    }

    private func decodeSession(event: String) throws -> GetSession.Result {
        let fields = [
            #""sessionId":"s-1""#,
            #""channel":"# + channelDescriptor("chat"),
            #""inner":{"channel":"# + channelDescriptor("counter") + "}",
            #""event":"# + event,
            #""stringValues":"# + channelDescriptor("strings"),
            #""integerValues":"# + channelDescriptor("ints")
        ]
        return try JSONDecoder().decode(GetSession.Result.self, from: Data(("{" + fields.joined(separator: ",") + "}").utf8))
    }

    private func assertReadOnly(_ encode: @autoclosure () throws -> Data, at path: [String], file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertThrowsError(try encode(), file: file, line: line) { error in
            guard case EncodingError.invalidValue(_, let context) = error else {
                return XCTFail("Expected EncodingError.invalidValue, got \(error)", file: file, line: line)
            }
            XCTAssertEqual(context.debugDescription, "Transferables are read-only", file: file, line: line)
            XCTAssertEqual(context.codingPath.map(\.stringValue), path, file: file, line: line)
        }
    }

    // MARK: - Realtime channels

    func testDecodesNestedChannelsAtEveryDepth() throws {
        let result = try decodeSession(event: #"{"kind":"presence","channel":"# + channelDescriptor("presence") + "}")

        XCTAssertEqual(result.sessionId, "s-1")
        XCTAssertEqual(result.channel.channel, "app/chat")
        XCTAssertEqual(result.channel.wsUrl, "wss://example.com/rt?token=c-chat")
        XCTAssertEqual(result.channel.token, "t-chat")
        XCTAssertEqual(result.inner.channel.channel, "app/counter")
        XCTAssertEqual(result.inner.channel.token, "t-counter")
        XCTAssertEqual(result.stringValues.channel, "app/strings")
        XCTAssertEqual(result.integerValues.channel, "app/ints")
        guard case .presence(let presence) = result.event else { return XCTFail("expected .presence, got \(result.event)") }
        XCTAssertEqual(presence.channel.channel, "app/presence")
        XCTAssertEqual(presence.channel.wsUrl, "wss://example.com/rt?token=c-presence")
        XCTAssertEqual(presence.channel.token, "t-presence")
    }

    func testDecodesNestedChannelInMessageArm() throws {
        let result = try decodeSession(event: #"{"kind":"message","channel":"# + channelDescriptor("messages") + "}")

        guard case .message(let message) = result.event else { return XCTFail("expected .message, got \(result.event)") }
        XCTAssertEqual(message.channel.channel, "app/messages")
        XCTAssertEqual(message.channel.token, "t-messages")
        XCTAssertEqual(try message.channel.deserializer(Data(#"{"body":"hi"}"#.utf8)).body, "hi")
    }

    func testNestedChannelsDecodeMessagesAsTheirTypeArgument() throws {
        let result = try decodeSession(event: #"{"kind":"presence","channel":"# + channelDescriptor("presence") + "}")

        XCTAssertEqual(try result.channel.deserializer(Data(#"{"text":"hello"}"#.utf8)).text, "hello")
        XCTAssertEqual(try result.inner.channel.deserializer(Data(#"{"count":3}"#.utf8)).count, 3)
        XCTAssertEqual(try result.stringValues.deserializer(Data(#"["a","b"]"#.utf8)), ["a", "b"])
        XCTAssertEqual(try result.integerValues.deserializer(Data("[1,2]".utf8)), [1, 2])
        XCTAssertThrowsError(try result.integerValues.deserializer(Data(#"["x"]"#.utf8)))
        guard case .presence(let presence) = result.event else { return XCTFail("expected .presence, got \(result.event)") }
        XCTAssertTrue(try presence.channel.deserializer(Data(#"{"online":true}"#.utf8)).online)
    }

    func testNestedChannelHydratesLikeATopLevelResult() throws {
        let previousHost = BlocksClient.baseHost
        BlocksClient.baseHost = "192.168.1.100"
        defer { BlocksClient.baseHost = previousHost }
        let descriptor = channelDescriptor("local", wsUrl: "ws://localhost:3001/realtime")

        let nested = try JSONDecoder().decode(GetSession.Result.Inner.self, from: Data((#"{"channel":"# + descriptor + "}").utf8)).channel
        // What the generated code does with a top-level channel result.
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(descriptor.utf8)) as? [String: Any])
        let topLevel = RealtimeChannel<GetSession.Result.Inner.ChannelMessage>.fromJSON(json, baseHost: BlocksClient.baseHost) { data in
            try JSONDecoder().decode(GetSession.Result.Inner.ChannelMessage.self, from: data)
        }

        XCTAssertEqual(nested.wsUrl, "ws://192.168.1.100:3001/realtime?token=c-local")
        XCTAssertEqual(nested.wsUrl, topLevel.wsUrl)
        XCTAssertEqual(nested.channel, topLevel.channel)
        XCTAssertEqual(nested.token, topLevel.token)
    }

    func testNestedChannelWithBadDescriptorThrowsInsteadOfTrapping() {
        let missingToken = Data(#"{"channel":{"channel":"app/c","wsUrl":"wss://example.com/rt"}}"#.utf8)
        XCTAssertThrowsError(try JSONDecoder().decode(GetSession.Result.Inner.self, from: missingToken)) { error in
            guard case DecodingError.dataCorrupted(let context) = error else {
                return XCTFail("Expected DecodingError.dataCorrupted, got \(error)")
            }
            XCTAssertEqual(context.codingPath.map(\.stringValue), ["channel"])
        }

        let notAnObject = Data(#"{"channel":"app/c"}"#.utf8)
        XCTAssertThrowsError(try JSONDecoder().decode(GetSession.Result.Inner.self, from: notAnObject)) { error in
            guard case DecodingError.typeMismatch = error else {
                return XCTFail("Expected DecodingError.typeMismatch, got \(error)")
            }
        }
    }

    // MARK: - File handles

    func testDecodesNestedFileHandles() throws {
        let data = Data(#"""
        {"download":{"__blocks":"file-bucket/download","url":"https://s3.example/get"},
         "uploads":[{"__blocks":"file-bucket/upload","url":"https://s3.example/put-1","contentType":"image/png"},
                    {"__blocks":"file-bucket/upload","url":"https://s3.example/put-2"}]}
        """#.utf8)

        let files = try JSONDecoder().decode(Files.self, from: data)

        XCTAssertEqual(files.download.getUrl(), "https://s3.example/get")
        XCTAssertNil(files.thumbnail)
        XCTAssertEqual(files.uploads.map { $0.getUrl() }, ["https://s3.example/put-1", "https://s3.example/put-2"])
    }

    func testNestedUploadHandleKeepsItsContentType() async throws {
        let listener = try LoopbackListener()
        defer { listener.close() }
        let upload = #"{"__blocks":"file-bucket/upload","url":"http://127.0.0.1:\#(listener.port)/put","contentType":"image/png"}"#
        let data = Data((#"{"download":{"url":"https://s3.example/get"},"uploads":["# + upload + "]}").utf8)
        let files = try JSONDecoder().decode(Files.self, from: data)

        _ = try? await files.uploads[0].upload(data: Data("x".utf8))

        let head = listener.waitForRequestHead()
        XCTAssertTrue(head.lowercased().contains("\r\ncontent-type: image/png\r\n"), "upload must send the descriptor's content type; got: \(head)")
    }

    func testNestedFileHandleWithoutURLThrowsLikeFromJSON() {
        let data = Data(#"{"download":{"__blocks":"file-bucket/download"},"uploads":[]}"#.utf8)
        XCTAssertThrowsError(try JSONDecoder().decode(Files.self, from: data)) { error in
            guard case FileBucketError.invalidURL = error else {
                return XCTFail("Expected FileBucketError.invalidURL, got \(error)")
            }
        }
    }

    // MARK: - Encoding and descriptor values

    func testEncodingANestedTransferableThrows() throws {
        let result = try decodeSession(event: #"{"kind":"message","channel":"# + channelDescriptor("messages") + "}")
        let files = try JSONDecoder().decode(Files.self, from: Data(#"{"download":{"url":"https://s3.example/get"},"uploads":[]}"#.utf8))

        assertReadOnly(try JSONEncoder().encode(result), at: ["channel"])
        assertReadOnly(try JSONEncoder().encode(result.event), at: ["channel"])
        assertReadOnly(try JSONEncoder().encode(files), at: ["download"])
    }

    func testDescriptorReadsAsJSONSerializationDoes() throws {
        let data = Data(#"{"s":"x","i":3,"d":1.5,"b":true,"n":null,"a":[1,"two",false],"o":{"k":{"deep":2}}}"#.utf8)

        let decoded = try JSONDecoder().decode(DescriptorProbe.self, from: data).json
        let serialized = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])

        XCTAssertEqual(NSDictionary(dictionary: decoded), NSDictionary(dictionary: serialized))
        // NSNumber equality treats true as 1, so check the boolean kind directly.
        let flag = try XCTUnwrap(decoded["b"] as? NSNumber)
        XCTAssertEqual(CFGetTypeID(flag), CFBooleanGetTypeID())
        XCTAssertEqual(decoded["i"] as? Int, 3)
        // As from JSONSerialization, an integer also reads as a Double.
        XCTAssertEqual(decoded["i"] as? Double, 3)
        XCTAssertEqual(decoded["d"] as? Double, 1.5)
        XCTAssertTrue(decoded["n"] is NSNull)
    }
}
// swiftlint:enable nesting
