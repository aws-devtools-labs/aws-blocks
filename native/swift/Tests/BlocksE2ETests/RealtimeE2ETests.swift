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
    }

    func testPublishCursor() async throws {
        let cursor = Cursor(color: "#ff0000", userId: "swift-test", x: 10, y: 20)
        let r = try await api.realtimePublish(cursor: cursor, channel: nil)
        XCTAssertTrue(r.success)
    }

    func testMultiplePublishes() async throws {
        for i in 0 ..< 5 {
            let cursor = Cursor(color: "#000", userId: "burst-\(i)", x: Double(i), y: Double(i * 10))
            let r = try await api.realtimePublish(cursor: cursor, channel: nil)
            XCTAssertTrue(r.success)
        }
    }
}
