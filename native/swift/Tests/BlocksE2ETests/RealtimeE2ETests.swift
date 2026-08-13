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
        // API Gateway's $connect route authenticates the handshake from the
        // query string. A descriptor that hydrates without the connect token
        // still passes every non-socket assertion, then fails only once
        // something opens a socket — so check it here, where no socket is
        // needed and the failure names the cause.
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

        // Consume the stream on its own task. Iterating inline cannot fail this
        // test: `for try await` blocks until a message arrives, so the old
        // `deadline` below the loop was unreachable and a message that never
        // came hung the test until the job timeout killed it, 17 minutes later.
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

        // Publish repeatedly rather than once after a fixed sleep. Subscribing
        // is asynchronous end to end — the handshake runs the $connect Lambda
        // and the subscribe frame is only registered after a DynamoDB write, so
        // on a cold sandbox that takes longer than any single sleep worth
        // hard-coding. A publish that lands before registration is delivered to
        // nobody and is not retried by the server.
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
}
