//
// Copyright Amazon.com Inc. or its affiliates.
// All Rights Reserved.
//
// SPDX-License-Identifier: Apache-2.0
//

import XCTest
@testable import BlocksRuntime

/// Mock delegate that records WebSocket events for testing.
private class MockWebSocketDelegate: WebSocketDelegate {
    var openCalled = false
    var messages: [String] = []
    var errors: [Error] = []
    var closedCodes: [Int] = []

    func onOpen(_ webSocket: URLSessionWebSocketTask) {
        openCalled = true
    }

    func onMessage(_ webSocket: URLSessionWebSocketTask, text: String) {
        messages.append(text)
    }

    func onFailure(_ webSocket: URLSessionWebSocketTask, error: Error) {
        errors.append(error)
    }

    func onClosed(_ webSocket: URLSessionWebSocketTask, code: Int, reason: String) {
        closedCodes.append(code)
    }
}

final class WebSocketSessionTests: XCTestCase {

    func testAcquireThrowsOnInvalidURL() {
        let session = WebSocketSession()
        let delegate = MockWebSocketDelegate()

        XCTAssertThrowsError(try session.acquire(wsUrl: "", token: "tok", listener: delegate)) { error in
            if let realtimeError = error as? RealtimeError {
                if case .websocket(let msg, _) = realtimeError {
                    XCTAssertTrue(msg.contains("Invalid WebSocket URL"))
                } else {
                    XCTFail("Expected .websocket error")
                }
            } else {
                XCTFail("Expected RealtimeError")
            }
        }
    }

    func testAcquireReturnsConnectionForValidURL() throws {
        let session = WebSocketSession()
        let delegate = MockWebSocketDelegate()

        let connection = try session.acquire(wsUrl: "wss://echo.websocket.org", token: "tok", listener: delegate)
        XCTAssertEqual(connection.key, "wss://echo.websocket.org|tok")

        // Cleanup
        session.release(wsUrl: "wss://echo.websocket.org", token: "tok", listener: delegate)
    }

    func testAcquireReusesSameConnection() throws {
        let session = WebSocketSession()
        let delegate1 = MockWebSocketDelegate()
        let delegate2 = MockWebSocketDelegate()

        let conn1 = try session.acquire(wsUrl: "wss://example.com/ws", token: "abc", listener: delegate1)
        let conn2 = try session.acquire(wsUrl: "wss://example.com/ws", token: "abc", listener: delegate2)

        // Same underlying task (same key)
        XCTAssertEqual(conn1.key, conn2.key)
        XCTAssertTrue(conn1.task === conn2.task)

        // Cleanup
        session.release(wsUrl: "wss://example.com/ws", token: "abc", listener: delegate1)
        session.release(wsUrl: "wss://example.com/ws", token: "abc", listener: delegate2)
    }

    func testDifferentTokensCreateDifferentConnections() throws {
        let session = WebSocketSession()
        let delegate1 = MockWebSocketDelegate()
        let delegate2 = MockWebSocketDelegate()

        let conn1 = try session.acquire(wsUrl: "wss://example.com/ws", token: "token1", listener: delegate1)
        let conn2 = try session.acquire(wsUrl: "wss://example.com/ws", token: "token2", listener: delegate2)

        XCTAssertNotEqual(conn1.key, conn2.key)
        XCTAssertFalse(conn1.task === conn2.task)

        // Cleanup
        session.release(wsUrl: "wss://example.com/ws", token: "token1", listener: delegate1)
        session.release(wsUrl: "wss://example.com/ws", token: "token2", listener: delegate2)
    }

    func testReleaseLastDelegateClosesConnection() throws {
        let session = WebSocketSession()
        let delegate = MockWebSocketDelegate()

        let connection = try session.acquire(wsUrl: "wss://example.com/ws", token: "tok", listener: delegate)

        // Release the only delegate — connection should be closed
        session.release(wsUrl: "wss://example.com/ws", token: "tok", listener: delegate)

        // Acquiring again should create a NEW connection (different task)
        let delegate2 = MockWebSocketDelegate()
        let connection2 = try session.acquire(wsUrl: "wss://example.com/ws", token: "tok", listener: delegate2)
        XCTAssertFalse(connection.task === connection2.task)

        // Cleanup
        session.release(wsUrl: "wss://example.com/ws", token: "tok", listener: delegate2)
    }

    func testReleaseWithMultipleDelegatesKeepsConnection() throws {
        let session = WebSocketSession()
        let delegate1 = MockWebSocketDelegate()
        let delegate2 = MockWebSocketDelegate()

        let conn1 = try session.acquire(wsUrl: "wss://example.com/ws", token: "tok", listener: delegate1)
        _ = try session.acquire(wsUrl: "wss://example.com/ws", token: "tok", listener: delegate2)

        // Release one delegate — connection should stay open
        session.release(wsUrl: "wss://example.com/ws", token: "tok", listener: delegate1)

        // Acquiring again should return the SAME connection
        let delegate3 = MockWebSocketDelegate()
        let conn3 = try session.acquire(wsUrl: "wss://example.com/ws", token: "tok", listener: delegate3)
        XCTAssertTrue(conn1.task === conn3.task)

        // Cleanup
        session.release(wsUrl: "wss://example.com/ws", token: "tok", listener: delegate2)
        session.release(wsUrl: "wss://example.com/ws", token: "tok", listener: delegate3)
    }

    func testReleaseNonExistentConnectionDoesNotCrash() {
        let session = WebSocketSession()
        let delegate = MockWebSocketDelegate()

        // Should not crash
        session.release(wsUrl: "wss://nonexistent.com/ws", token: "tok", listener: delegate)
    }
}
