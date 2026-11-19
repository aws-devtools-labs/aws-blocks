//
// Copyright Amazon.com Inc. or its affiliates.
// All Rights Reserved.
//
// SPDX-License-Identifier: Apache-2.0
//

import XCTest
@testable import BlocksRuntime

final class RealtimeE2ETests: BlocksE2ETestCase {

    func testGetChannelDescriptor() async throws {
        let channel = try await api.realtimeGetChannel(channel: nil)
        XCTAssertNotNil(channel)
        // A descriptor with no connect token passes every non-socket assertion
        // and fails only when a socket opens. Check it here, with no socket.
        XCTAssertTrue(
            channel.wsUrl.contains("token="),
            "hydrated wsUrl carries no connect token: \(channel.wsUrl)"
        )
    }

    func testPublishCursor() async throws {
        let cursor = Cursor(color: "#ff0000", userId: "swift-test", x: 10, y: 20)
        let result = try await api.realtimePublish(cursor: cursor, channel: nil)
        XCTAssertTrue(result.success)
    }

    func testSubscribeAndReceive() async throws {
        let channel = try await api.realtimeGetChannel(channel: "swift-sub-test")
        let stream = channel.subscribe()

        // Consume the stream on its own task. `for try await` blocks until a
        // message arrives, so an inline loop hangs the test when none comes.
        let received = XCTestExpectation(description: "cursor received on channel")
        let consumer = Task {
            for try await msg in stream {
                XCTAssertEqual(msg.userId, "swift-sub-test")
                XCTAssertEqual(msg.x, 42)
                XCTAssertEqual(msg.y, 99)
                XCTAssertEqual(msg.color, "#00ff00")
                received.fulfill()
                break
            }
        }

        // Publish once a second, not once after a fixed sleep. The subscribe
        // frame is live only after a DynamoDB write, and a cold sandbox takes
        // longer than any fixed sleep. The server drops a publish that lands
        // before the frame is live and does not retry it.
        let published = Cursor(color: "#00ff00", userId: "swift-sub-test", x: 42, y: 99)
        let publisher = Task {
            for _ in 0 ..< 20 {
                _ = try? await api.realtimePublish(cursor: published, channel: "swift-sub-test")
                try? await Task.sleep(nanoseconds: 1_000_000_000)
            }
        }

        await fulfillment(of: [received], timeout: 25)
        publisher.cancel()
        consumer.cancel()
        channel.close()
    }

    func testMultiplePublishes() async throws {
        for idx in 0 ..< 5 {
            let cursor = Cursor(color: "#000", userId: "burst-\(idx)", x: Double(idx), y: Double(idx * 10))
            let result = try await api.realtimePublish(cursor: cursor, channel: nil)
            XCTAssertTrue(result.success)
        }
    }

    /// A subscribe the server refuses ends the stream with `subscriptionEnded` and no code, rather than leaving it
    /// open and quiet. The server answers a bad channel token with an error frame for the channel.
    func testRefusedSubscribeEndsWithSubscriptionEnded() async throws {
        let issued = try await api.realtimeGetChannel(channel: "swift-refused")
        let forged = RealtimeChannel<Cursor>(
            channel: issued.channel,
            wsUrl: issued.wsUrl,
            token: "not-a-valid-channel-token"
        ) { try JSONDecoder().decode(Cursor.self, from: $0) }
        defer { forged.close() }

        let ended = Task { () -> Error? in
            do {
                for try await _ in forged.subscribe() {}
                return nil
            } catch {
                return error
            }
        }
        let timeout = Task {
            try await Task.sleep(nanoseconds: 20_000_000_000)
            ended.cancel()
        }
        let error = await ended.value
        timeout.cancel()

        guard case RealtimeError.subscriptionEnded(let channel, let code, let message, _)? = error as? RealtimeError
        else {
            return XCTFail("Expected subscriptionEnded, got \(String(describing: error))")
        }
        XCTAssertEqual(channel, issued.channel)
        XCTAssertNil(code)
        XCTAssertTrue(message.contains("Unauthorized"), message)
    }

    /// `close()` finishes an active stream normally.
    func testCloseFinishesTheActiveStream() async throws {
        let channel = try await api.realtimeGetChannel(channel: "swift-close")
        let finished = XCTestExpectation(description: "the stream finished normally")
        let consumer = Task {
            do {
                for try await _ in channel.subscribe() {}
                finished.fulfill()
            } catch {
                XCTFail("Expected a normal finish, got \(error)")
            }
        }
        // Let the socket open and the subscribe go out before closing.
        try await Task.sleep(nanoseconds: 1_000_000_000)

        channel.close()

        await fulfillment(of: [finished], timeout: 10)
        consumer.cancel()
    }
}
