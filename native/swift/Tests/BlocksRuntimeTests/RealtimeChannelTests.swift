//
// Copyright Amazon.com Inc. or its affiliates.
// All Rights Reserved.
//
// SPDX-License-Identifier: Apache-2.0
//

import XCTest
@testable import BlocksRuntime

final class RealtimeChannelTests: XCTestCase {

    // Server frame parsing. The AWS server sends the payload under `data`; the
    // mock sends `payload`. Reading only `payload` drops every AWS message, so
    // subscribe worked against the mock and silently received nothing from a
    // deployed backend.

    private func decoded(_ data: Data?) -> [String: Int]? {
        guard let data else { return nil }
        return try? JSONDecoder().decode([String: Int].self, from: data)
    }

    func testFramePayloadReadsAwsDataField() {
        let text = #"{"type":"message","channel":"c","data":{"x":42}}"#
        XCTAssertEqual(decoded(RealtimeFrame.payload(from: text, channel: "c")), ["x": 42])
    }

    func testFramePayloadReadsMockPayloadField() {
        let text = #"{"type":"message","channel":"c","payload":{"x":7}}"#
        XCTAssertEqual(decoded(RealtimeFrame.payload(from: text, channel: "c")), ["x": 7])
    }

    func testFramePayloadIgnoresControlFrames() {
        // subscribe_success arrives first on every subscribe; it must not reach
        // the deserializer.
        let text = #"{"type":"subscribe_success","channel":"c"}"#
        XCTAssertNil(RealtimeFrame.payload(from: text, channel: "c"))
    }

    func testFramePayloadIgnoresOtherChannels() {
        let text = #"{"type":"message","channel":"other","data":{"x":1}}"#
        XCTAssertNil(RealtimeFrame.payload(from: text, channel: "c"))
    }

    func testFramePayloadIgnoresNonJSON() {
        XCTAssertNil(RealtimeFrame.payload(from: "not json", channel: "c"))
    }

    func testFromJSONParsesDescriptor() {
        let json: [String: Any] = [
            "channel": "cursors",
            "wsUrl": "wss://example.com/ws",
            "token": "abc123"
        ]

        let channel = RealtimeChannel<[String: Any]>.fromJSON(json) { data in
            guard let obj = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
                throw RPCError(message: "Invalid JSON")
            }
            return obj
        }

        XCTAssertEqual(channel.channel, "cursors")
        XCTAssertEqual(channel.wsUrl, "wss://example.com/ws")
        XCTAssertEqual(channel.token, "abc123")
    }

    func testFromJSONRewritesLocalhost() {
        let json: [String: Any] = [
            "channel": "test",
            "wsUrl": "ws://localhost:3001/ws",
            "token": "tok"
        ]

        let channel = RealtimeChannel<String>.fromJSON(json, baseHost: "192.168.1.100") { String(data: $0, encoding: .utf8) ?? "" }

        XCTAssertEqual(channel.wsUrl, "ws://192.168.1.100:3001/ws")
    }

    func testFromJSONNoRewriteWhenBaseHostIsLocalhost() {
        let json: [String: Any] = [
            "channel": "test",
            "wsUrl": "ws://localhost:3001/ws",
            "token": "tok"
        ]

        let channel = RealtimeChannel<String>.fromJSON(json, baseHost: "localhost") { String(data: $0, encoding: .utf8) ?? "" }

        XCTAssertEqual(channel.wsUrl, "ws://localhost:3001/ws")
    }

    // API Gateway `$connect` reads the handshake credential from
    // queryStringParameters.token. If fromJSON drops connectToken, every
    // subscribe fails at the handshake. These tests guard that path.

    func testFromJSONAppendsConnectTokenAsQueryParam() {
        let json: [String: Any] = [
            "channel": "cursors",
            "wsUrl": "wss://abc123.execute-api.us-east-1.amazonaws.com/rt",
            "connectToken": "connect-abc",
            "token": "channel-xyz"
        ]

        let channel = RealtimeChannel<String>.fromJSON(json) { String(data: $0, encoding: .utf8) ?? "" }

        XCTAssertEqual(
            channel.wsUrl,
            "wss://abc123.execute-api.us-east-1.amazonaws.com/rt?token=connect-abc"
        )
        // The channel token stays off the URL. It is for the subscribe message.
        XCTAssertEqual(channel.token, "channel-xyz")
    }

    func testFromJSONOmitsConnectTokenWhenAbsentOrEmpty() {
        for value in [nil, ""] as [String?] {
            var json: [String: Any] = [
                "channel": "cursors",
                "wsUrl": "wss://example.com/ws",
                "token": "tok"
            ]
            if let value {
                json["connectToken"] = value
            }

            let channel = RealtimeChannel<String>.fromJSON(json) { String(data: $0, encoding: .utf8) ?? "" }

            XCTAssertEqual(channel.wsUrl, "wss://example.com/ws", "connectToken=\(String(describing: value))")
        }
    }

    func testFromJSONPreservesExistingQueryParams() {
        let json: [String: Any] = [
            "channel": "cursors",
            "wsUrl": "wss://example.com/rt?stage=beta",
            "connectToken": "connect-abc",
            "token": "tok"
        ]

        let channel = RealtimeChannel<String>.fromJSON(json) { String(data: $0, encoding: .utf8) ?? "" }

        XCTAssertEqual(channel.wsUrl, "wss://example.com/rt?stage=beta&token=connect-abc")
    }

    func testFromJSONKeepsARealConnectTokenIntact() {
        // mintConnectToken emits base64url plus a '.' separator. Every character
        // is query-safe, and the token must reach the server unchanged or the
        // HMAC check fails.
        let token = "eyJjaGFubmVsIjoiYXBwLXJ0JGNvbm5lY3QiLCJleHAiOjF9.s0me-Sig_123"
        let json: [String: Any] = [
            "channel": "cursors",
            "wsUrl": "wss://example.com/rt",
            "connectToken": token,
            "token": "tok"
        ]

        let channel = RealtimeChannel<String>.fromJSON(json) { String(data: $0, encoding: .utf8) ?? "" }

        XCTAssertEqual(channel.wsUrl, "wss://example.com/rt?token=\(token)")
    }

    func testFromJSONEncodesAmpersandSoTheTokenCannotBeTruncated() {
        // base64url has no '&', but if the format changes, a raw '&' would split
        // the query and the server would read a truncated token.
        let json: [String: Any] = [
            "channel": "cursors",
            "wsUrl": "wss://example.com/rt",
            "connectToken": "abc&def",
            "token": "tok"
        ]

        let channel = RealtimeChannel<String>.fromJSON(json) { String(data: $0, encoding: .utf8) ?? "" }

        XCTAssertEqual(channel.wsUrl, "wss://example.com/rt?token=abc%26def")
    }

    func testFromJSONAppliesLocalhostRewriteBeforeAppendingConnectToken() {
        let json: [String: Any] = [
            "channel": "cursors",
            "wsUrl": "ws://localhost:3001/realtime",
            "connectToken": "connect-abc",
            "token": "tok"
        ]

        let channel = RealtimeChannel<String>.fromJSON(json, baseHost: "192.168.1.100") {
            String(data: $0, encoding: .utf8) ?? ""
        }

        XCTAssertEqual(channel.wsUrl, "ws://192.168.1.100:3001/realtime?token=connect-abc")
    }

    func testSubscribeThrowsAfterClose() {
        let channel = RealtimeChannel<String>(
            channel: "test",
            wsUrl: "wss://example.com/ws",
            token: "tok",
            deserializer: { String(data: $0, encoding: .utf8) ?? "" }
        )

        channel.close()

        let stream = channel.subscribe()
        let expectation = XCTestExpectation(description: "Stream should throw channelClosed")

        Task {
            do {
                for try await _ in stream {
                    XCTFail("Should not receive values")
                }
                XCTFail("Should have thrown")
            } catch let error as RealtimeError {
                if case .channelClosed = error {
                    expectation.fulfill()
                } else {
                    XCTFail("Expected channelClosed, got \(error)")
                }
            } catch {
                XCTFail("Expected RealtimeError, got \(error)")
            }
        }

        wait(for: [expectation], timeout: 1.0)
    }

    func testCloseIsIdempotent() {
        let channel = RealtimeChannel<String>(
            channel: "test",
            wsUrl: "wss://example.com/ws",
            token: "tok",
            deserializer: { String(data: $0, encoding: .utf8) ?? "" }
        )

        // Should not crash when called multiple times
        channel.close()
        channel.close()
        channel.close()
    }

    /// Ensures the realtime closure passes raw bytes to the decoder:
    /// the deserializer should receive raw payload bytes so callers can hand
    /// them straight to JSONDecoder, removing the redundant Data → String →
    /// Data round trip.
    func testDeserializerReceivesData() throws {
        // swiftlint:disable identifier_name
        struct Cursor: Codable, Equatable { let x: Int
        let y: Int
        }
        // swiftlint:enable identifier_name

        let json: [String: Any] = [
            "channel": "cursors",
            "wsUrl": "wss://example.com/ws",
            "token": "tok"
        ]

        let deserializer: (Data) throws -> Cursor = { data in
            try JSONDecoder().decode(Cursor.self, from: data)
        }

        let channel = RealtimeChannel<Cursor>.fromJSON(json, deserializer: deserializer)

        XCTAssertEqual(channel.channel, "cursors")
        XCTAssertEqual(channel.wsUrl, "wss://example.com/ws")
        XCTAssertEqual(channel.token, "tok")
    }
}
