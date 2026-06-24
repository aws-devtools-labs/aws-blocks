//
// Copyright Amazon.com Inc. or its affiliates.
// All Rights Reserved.
//
// SPDX-License-Identifier: Apache-2.0
//

import XCTest
@testable import BlocksRuntime

final class RealtimeChannelTests: XCTestCase {

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
