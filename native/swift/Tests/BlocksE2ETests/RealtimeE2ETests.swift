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

        try await Task.sleep(nanoseconds: 500_000_000)

        let published = Cursor(color: "#00ff00", userId: "swift-sub-test", x: 42, y: 99)
        _ = try await api.realtimePublish(cursor: published, channel: "swift-sub-test")

        let deadline = Date().addingTimeInterval(5)
        for try await msg in stream {
            XCTAssertEqual(msg.userId, "swift-sub-test")
            XCTAssertEqual(msg.x, 42)
            XCTAssertEqual(msg.y, 99)
            XCTAssertEqual(msg.color, "#00ff00")
            break
        }
        XCTAssertTrue(Date() < deadline, "Timed out waiting for message")
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
