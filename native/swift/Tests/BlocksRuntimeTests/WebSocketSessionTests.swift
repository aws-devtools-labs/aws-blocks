//
// Copyright Amazon.com Inc. or its affiliates.
// All Rights Reserved.
//
// SPDX-License-Identifier: Apache-2.0
//

import XCTest
@testable import BlocksRuntime

/// Records pool events for one listener.
private final class RecordingListener: RealtimeSocketListener {
    private let lock = NSLock()
    private var _opens = 0
    private var _messages: [String] = []
    private var _errors: [Error] = []

    var opens: Int { lock.lock()
    defer { lock.unlock() }
    return _opens
    }
    var messages: [String] { lock.lock()
    defer { lock.unlock() }
    return _messages
    }
    var errors: [Error] { lock.lock()
    defer { lock.unlock() }
    return _errors
    }

    func onOpen(_ socket: RealtimeSocket) {
        lock.lock()
        _opens += 1
        lock.unlock()
    }

    func onMessage(_ text: String) {
        lock.lock()
        _messages.append(text)
        lock.unlock()
    }

    func onFailure(_ error: Error) {
        lock.lock()
        _errors.append(error)
        lock.unlock()
    }
}

final class WebSocketSessionTests: XCTestCase {

    private let url = "wss://example.com/ws"

    func testAcquireThrowsOnInvalidURL() {
        let harness = FakeRealtimeHarness()
        let listener = RecordingListener()

        XCTAssertThrowsError(try harness.session.acquire(wsUrl: "", token: "tok", listener: listener)) { error in
            guard case RealtimeError.connectionFailed(let msg, _)? = error as? RealtimeError else {
                return XCTFail("Expected .connectionFailed, got \(error)")
            }
            XCTAssertTrue(msg.contains("Invalid WebSocket URL"))
        }
        XCTAssertTrue(harness.sockets.isEmpty)
    }

    func testAcquireOpensSocketAndNotifiesOpen() async throws {
        let harness = FakeRealtimeHarness()
        let listener = RecordingListener()

        try harness.session.acquire(wsUrl: url, token: "tok", listener: listener)

        XCTAssertEqual(harness.sockets.count, 1)
        XCTAssertTrue(harness.sockets[0].isResumed)
        XCTAssertEqual(harness.sockets[0].request.url?.absoluteString, url)
        XCTAssertEqual(harness.sockets[0].request.value(forHTTPHeaderField: "User-Agent"), blocksUserAgentToken)
        await waitUntil("the listener sees the socket open") { listener.opens == 1 }
        harness.session.release(wsUrl: url, token: "tok", listener: listener)
    }

    func testAcquireReusesSameConnectionAndDispatchesToEveryListener() async throws {
        let harness = FakeRealtimeHarness()
        let first = RecordingListener()
        let second = RecordingListener()

        try harness.session.acquire(wsUrl: url, token: "abc", listener: first)
        try harness.session.acquire(wsUrl: url, token: "abc", listener: second)
        XCTAssertEqual(harness.sockets.count, 1)

        harness.sockets[0].deliver("frame")
        await waitUntil("both listeners get the frame") { first.messages == ["frame"] && second.messages == ["frame"] }
        // A listener that joins an open socket is told it's open, so it can send its subscribe.
        await waitUntil("both listeners see the socket open") { first.opens == 1 && second.opens == 1 }

        harness.session.release(wsUrl: url, token: "abc", listener: first)
        harness.session.release(wsUrl: url, token: "abc", listener: second)
    }

    func testDifferentTokensCreateDifferentConnections() throws {
        let harness = FakeRealtimeHarness()
        let first = RecordingListener()
        let second = RecordingListener()

        try harness.session.acquire(wsUrl: url, token: "token1", listener: first)
        try harness.session.acquire(wsUrl: url, token: "token2", listener: second)

        XCTAssertEqual(harness.sockets.count, 2)
        harness.session.release(wsUrl: url, token: "token1", listener: first)
        harness.session.release(wsUrl: url, token: "token2", listener: second)
    }

    func testReleaseLastListenerClosesConnection() throws {
        let harness = FakeRealtimeHarness()
        let listener = RecordingListener()

        try harness.session.acquire(wsUrl: url, token: "tok", listener: listener)
        harness.session.release(wsUrl: url, token: "tok", listener: listener)

        XCTAssertTrue(harness.sockets[0].isCancelled)
        XCTAssertEqual(harness.session.connectionCount, 0)

        let again = RecordingListener()
        try harness.session.acquire(wsUrl: url, token: "tok", listener: again)
        XCTAssertEqual(harness.sockets.count, 2, "acquiring after the last release opens a new socket")
        harness.session.release(wsUrl: url, token: "tok", listener: again)
    }

    func testReleaseWithMultipleListenersKeepsConnection() throws {
        let harness = FakeRealtimeHarness()
        let first = RecordingListener()
        let second = RecordingListener()

        try harness.session.acquire(wsUrl: url, token: "tok", listener: first)
        try harness.session.acquire(wsUrl: url, token: "tok", listener: second)
        harness.session.release(wsUrl: url, token: "tok", listener: first)

        XCTAssertFalse(harness.sockets[0].isCancelled)
        let third = RecordingListener()
        try harness.session.acquire(wsUrl: url, token: "tok", listener: third)
        XCTAssertEqual(harness.sockets.count, 1)

        harness.session.release(wsUrl: url, token: "tok", listener: second)
        harness.session.release(wsUrl: url, token: "tok", listener: third)
        XCTAssertTrue(harness.sockets[0].isCancelled)
    }

    func testReleaseNonExistentConnectionDoesNotCrash() {
        let harness = FakeRealtimeHarness()
        harness.session.release(wsUrl: "wss://nonexistent.com/ws", token: "tok", listener: RecordingListener())
    }

    // MARK: - Dead sockets

    func testFailedSocketIsDroppedFromThePoolAndEveryListenerIsTold() async throws {
        let harness = FakeRealtimeHarness()
        let first = RecordingListener()
        let second = RecordingListener()
        try harness.session.acquire(wsUrl: url, token: "tok", listener: first)
        try harness.session.acquire(wsUrl: url, token: "tok", listener: second)

        harness.sockets[0].fail()

        await waitUntil("both listeners get the failure") { first.errors.count == 1 && second.errors.count == 1 }
        XCTAssertEqual((first.errors.first as? URLError)?.code, .networkConnectionLost)
        XCTAssertEqual(harness.session.connectionCount, 0)

        // A later acquire on the same key opens a new socket rather than joining the dead one.
        let later = RecordingListener()
        try harness.session.acquire(wsUrl: url, token: "tok", listener: later)
        XCTAssertEqual(harness.sockets.count, 2)
        let newSocket = try XCTUnwrap(harness.sockets.dropFirst().first)

        // A stale release from a listener of the dead socket leaves the new one alone.
        harness.session.release(wsUrl: url, token: "tok", listener: first)
        XCTAssertFalse(newSocket.isCancelled)
        harness.session.release(wsUrl: url, token: "tok", listener: later)
        XCTAssertTrue(newSocket.isCancelled)
    }

    // MARK: - Keep-alive

    func testPingsEveryNineMinutesWhileTheSocketHasAListener() async throws {
        let harness = FakeRealtimeHarness()
        let listener = RecordingListener()
        try harness.session.acquire(wsUrl: url, token: "tok", listener: listener)
        let socket = harness.sockets[0]

        await waitUntil("the keep-alive waits") { harness.clock.pendingDurations == [9 * 60 * 1_000_000_000] }
        XCTAssertEqual(socket.pingCount, 0, "no ping before the first interval")

        harness.clock.advance(by: 9 * 60 * 1_000_000_000 - 1)
        try await Task.sleep(nanoseconds: 20_000_000)
        XCTAssertEqual(socket.pingCount, 0, "no ping before 9 minutes")

        harness.clock.advance(by: 1)
        await waitUntil("the first ping") { socket.pingCount == 1 }
        XCTAssertEqual(socket.sent.last, #"{"action":"ping"}"#)

        await waitUntil("the keep-alive waits again") { harness.clock.pendingDurations.count == 1 }
        harness.clock.advance(by: 9 * 60 * 1_000_000_000)
        await waitUntil("the second ping") { socket.pingCount == 2 }

        harness.session.release(wsUrl: url, token: "tok", listener: listener)
    }

    func testOneKeepAlivePerSocketNotPerListener() async throws {
        let harness = FakeRealtimeHarness()
        let first = RecordingListener()
        let second = RecordingListener()
        try harness.session.acquire(wsUrl: url, token: "tok", listener: first)
        try harness.session.acquire(wsUrl: url, token: "tok", listener: second)

        await waitUntil("one keep-alive waits") { harness.clock.pendingDurations.count == 1 }
        harness.clock.advance(by: WebSocketSession.keepAliveInterval)
        await waitUntil("one ping") { harness.sockets[0].pingCount == 1 }
        try await Task.sleep(nanoseconds: 20_000_000)
        XCTAssertEqual(harness.sockets[0].pingCount, 1)

        harness.session.release(wsUrl: url, token: "tok", listener: first)
        harness.session.release(wsUrl: url, token: "tok", listener: second)
    }

    func testKeepAliveStopsWhenTheLastListenerLeaves() async throws {
        let harness = FakeRealtimeHarness()
        let first = RecordingListener()
        let second = RecordingListener()
        try harness.session.acquire(wsUrl: url, token: "tok", listener: first)
        try harness.session.acquire(wsUrl: url, token: "tok", listener: second)
        await waitUntil("the keep-alive waits") { harness.clock.pendingDurations.count == 1 }

        harness.session.release(wsUrl: url, token: "tok", listener: first)
        try await Task.sleep(nanoseconds: 20_000_000)
        XCTAssertEqual(harness.clock.pendingDurations.count, 1, "the keep-alive runs while a listener remains")

        harness.session.release(wsUrl: url, token: "tok", listener: second)
        await waitUntil("the keep-alive stops") { harness.clock.pendingDurations.isEmpty }
        harness.clock.advance(by: WebSocketSession.keepAliveInterval)
        try await Task.sleep(nanoseconds: 20_000_000)
        XCTAssertEqual(harness.sockets[0].pingCount, 0)
    }

    func testKeepAliveStopsWhenTheSocketFails() async throws {
        let harness = FakeRealtimeHarness()
        let listener = RecordingListener()
        try harness.session.acquire(wsUrl: url, token: "tok", listener: listener)
        await waitUntil("the keep-alive waits") { harness.clock.pendingDurations.count == 1 }

        harness.sockets[0].fail()

        await waitUntil("the keep-alive stops") { harness.clock.pendingDurations.isEmpty }
        harness.session.release(wsUrl: url, token: "tok", listener: listener)
    }
}
