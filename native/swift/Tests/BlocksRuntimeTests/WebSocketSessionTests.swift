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
    let channel: String
    let unsubscribesOnLeave: Bool

    init(channel: String = "c", unsubscribesOnLeave: Bool = true) {
        self.channel = channel
        self.unsubscribesOnLeave = unsubscribesOnLeave
    }

    var subscribeFrame: String { "subscribe:\(channel)" }

    private let lock = NSLock()
    private var _messages: [String] = []
    private var _errors: [Error] = []

    var messages: [String] { lock.lock()
    defer { lock.unlock() }
    return _messages
    }
    var errors: [Error] { lock.lock()
    defer { lock.unlock() }
    return _errors
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

        XCTAssertThrowsError(try harness.session.acquire(wsUrl: "", listener: listener)) { error in
            guard case RealtimeError.connectionFailed(let msg, _)? = error as? RealtimeError else {
                return XCTFail("Expected .connectionFailed, got \(error)")
            }
            XCTAssertTrue(msg.contains("Invalid WebSocket URL"))
        }
        XCTAssertTrue(harness.sockets.isEmpty)
    }

    func testRealtimeSessionTimeoutOutlastsTheKeepAliveAndTheHandshakeRequestKeepsIt() throws {
        // The session's request timeout defaults to 60 seconds; the realtime session's must outlast the ping.
        let keepAliveSeconds = TimeInterval(WebSocketSession.keepAliveInterval) / 1_000_000_000
        XCTAssertGreaterThan(WebSocketSession.requestTimeout, keepAliveSeconds)
        XCTAssertLessThan(WebSocketSession.handshakeTimeout, keepAliveSeconds)

        let harness = FakeRealtimeHarness()
        let listener = RecordingListener()
        try harness.session.acquire(wsUrl: url, listener: listener)
        // A request timeout applies to the task for its whole life, so the handshake request must not set one.
        // URLRequest's default, 60, means unset, and the session's timeout applies.
        XCTAssertEqual(harness.sockets[0].request.timeoutInterval, URLRequest(url: URL(string: url)!).timeoutInterval)
        harness.session.release(wsUrl: url, listener: listener)

        XCTAssertEqual(
            BlocksRuntimeSession.realtime.configuration.timeoutIntervalForRequest,
            WebSocketSession.requestTimeout
        )
        XCTAssertEqual(
            BlocksRuntimeSession.realtime.configuration.httpAdditionalHeaders?["User-Agent"] as? String,
            blocksUserAgentToken
        )
    }

    func testReleaseSendsUnsubscribeOnlyWhenTheChannelLeavesASocketThatStaysOpen() async throws {
        let harness = FakeRealtimeHarness()
        let first = RecordingListener(channel: "a")
        let firstTwin = RecordingListener(channel: "a")
        let ended = RecordingListener(channel: "b", unsubscribesOnLeave: false)
        let remaining = RecordingListener(channel: "c")
        for listener in [first, firstTwin, ended, remaining] {
            try harness.session.acquire(wsUrl: url, listener: listener)
        }
        let socket = harness.sockets[0]
        let unsubscribes = { socket.sent.filter { $0.contains("unsubscribe") } }

        harness.session.release(wsUrl: url, listener: first)
        harness.session.release(wsUrl: url, listener: ended)
        try await Task.sleep(nanoseconds: 50_000_000)
        XCTAssertEqual(unsubscribes(), [], "a still has a listener; the server already ended b")

        harness.session.release(wsUrl: url, listener: firstTwin)
        await waitUntil("a is unsubscribed") { unsubscribes().count == 1 }
        XCTAssertEqual(unsubscribes(), [#"{"action":"unsubscribe","channel":"a"}"#])

        harness.session.release(wsUrl: url, listener: remaining)
        XCTAssertTrue(socket.isCancelled)
        try await Task.sleep(nanoseconds: 50_000_000)
        XCTAssertEqual(unsubscribes().count, 1, "the last listener closes the socket instead")
    }

    func testReleaseThenAcquireOfOneChannelQueuesUnsubscribeBeforeSubscribe() async throws {
        let harness = FakeRealtimeHarness()
        let keeper = RecordingListener(channel: "b")
        let leaving = RecordingListener(channel: "a")
        try harness.session.acquire(wsUrl: url, listener: keeper)
        try harness.session.acquire(wsUrl: url, listener: leaving)
        await waitUntil("both subscribes are sent") { harness.sockets[0].sent.count == 2 }

        harness.session.release(wsUrl: url, listener: leaving)
        let returning = RecordingListener(channel: "a")
        try harness.session.acquire(wsUrl: url, listener: returning)

        await waitUntil("both frames are sent") { harness.sockets[0].sent.count == 4 }
        XCTAssertEqual(
            Array(harness.sockets[0].sent.suffix(2)),
            [#"{"action":"unsubscribe","channel":"a"}"#, "subscribe:a"]
        )
        harness.session.release(wsUrl: url, listener: keeper)
        harness.session.release(wsUrl: url, listener: returning)
    }

    func testAcquireOpensSocketAndSendsTheSubscribe() async throws {
        let harness = FakeRealtimeHarness()
        let listener = RecordingListener()

        try harness.session.acquire(wsUrl: url, listener: listener)

        XCTAssertEqual(harness.sockets.count, 1)
        XCTAssertTrue(harness.sockets[0].isResumed)
        XCTAssertEqual(harness.sockets[0].request.url?.absoluteString, url)
        XCTAssertEqual(harness.sockets[0].request.value(forHTTPHeaderField: "User-Agent"), blocksUserAgentToken)
        await waitUntil("the subscribe is sent") { harness.sockets[0].sent == ["subscribe:c"] }
        harness.session.release(wsUrl: url, listener: listener)
    }

    func testAcquireReusesSameConnectionAndDispatchesToEveryListener() async throws {
        let harness = FakeRealtimeHarness()
        let first = RecordingListener()
        let second = RecordingListener()

        try harness.session.acquire(wsUrl: url, listener: first)
        try harness.session.acquire(wsUrl: url, listener: second)
        XCTAssertEqual(harness.sockets.count, 1)

        harness.sockets[0].deliver("frame")
        await waitUntil("both listeners get the frame") { first.messages == ["frame"] && second.messages == ["frame"] }
        // A listener that joins an open socket has its subscribe sent too.
        await waitUntil("both subscribes are sent") { harness.sockets[0].sent == ["subscribe:c", "subscribe:c"] }

        harness.session.release(wsUrl: url, listener: first)
        harness.session.release(wsUrl: url, listener: second)
    }

    func testDifferentURLsCreateDifferentConnections() throws {
        // The connect token is part of the URL, so a different connect token is a different socket.
        let harness = FakeRealtimeHarness()
        let first = RecordingListener()
        let second = RecordingListener()

        try harness.session.acquire(wsUrl: url + "?token=a", listener: first)
        try harness.session.acquire(wsUrl: url + "?token=b", listener: second)

        XCTAssertEqual(harness.sockets.count, 2)
        harness.session.release(wsUrl: url + "?token=a", listener: first)
        harness.session.release(wsUrl: url + "?token=b", listener: second)
    }

    func testConnectionErrorFrameDropsTheSocketBeforeListenersHearIt() async throws {
        let harness = FakeRealtimeHarness()
        let listener = RecordingListener()
        try harness.session.acquire(wsUrl: url, listener: listener)

        harness.sockets[0].deliver(#"{"type":"error","message":"Invalid channel"}"#)

        await waitUntil("the listener gets the frame") { listener.messages.count == 1 }
        XCTAssertEqual(harness.session.connectionCount, 0)
        XCTAssertTrue(harness.sockets[0].isCancelled)
        await waitUntil("the keep-alive stops") { harness.clock.pendingDurations.isEmpty }
    }

    func testServerCloseReachesListenersAsRealtimeSocketClosed() async throws {
        let harness = FakeRealtimeHarness()
        let listener = RecordingListener()
        try harness.session.acquire(wsUrl: url, listener: listener)

        harness.sockets[0].fail(RealtimeSocketClosed(code: 1_001, reason: "Going away"))

        await waitUntil("the listener gets the close") { listener.errors.count == 1 }
        let closed = listener.errors.first as? RealtimeSocketClosed
        XCTAssertEqual(closed?.code, 1_001)
        XCTAssertEqual(closed?.reason, "Going away")
        XCTAssertEqual(harness.session.connectionCount, 0)
    }

    func testReleaseLastListenerClosesConnection() throws {
        let harness = FakeRealtimeHarness()
        let listener = RecordingListener()

        try harness.session.acquire(wsUrl: url, listener: listener)
        harness.session.release(wsUrl: url, listener: listener)

        XCTAssertTrue(harness.sockets[0].isCancelled)
        XCTAssertEqual(harness.session.connectionCount, 0)

        let again = RecordingListener()
        try harness.session.acquire(wsUrl: url, listener: again)
        XCTAssertEqual(harness.sockets.count, 2, "acquiring after the last release opens a new socket")
        harness.session.release(wsUrl: url, listener: again)
    }

    func testReleaseWithMultipleListenersKeepsConnection() throws {
        let harness = FakeRealtimeHarness()
        let first = RecordingListener()
        let second = RecordingListener()

        try harness.session.acquire(wsUrl: url, listener: first)
        try harness.session.acquire(wsUrl: url, listener: second)
        harness.session.release(wsUrl: url, listener: first)

        XCTAssertFalse(harness.sockets[0].isCancelled)
        let third = RecordingListener()
        try harness.session.acquire(wsUrl: url, listener: third)
        XCTAssertEqual(harness.sockets.count, 1)

        harness.session.release(wsUrl: url, listener: second)
        harness.session.release(wsUrl: url, listener: third)
        XCTAssertTrue(harness.sockets[0].isCancelled)
    }

    func testReleaseNonExistentConnectionDoesNotCrash() {
        let harness = FakeRealtimeHarness()
        harness.session.release(wsUrl: "wss://nonexistent.com/ws", listener: RecordingListener())
    }

    // MARK: - Dead sockets

    func testFailedSocketIsDroppedFromThePoolAndEveryListenerIsTold() async throws {
        let harness = FakeRealtimeHarness()
        let first = RecordingListener()
        let second = RecordingListener()
        try harness.session.acquire(wsUrl: url, listener: first)
        try harness.session.acquire(wsUrl: url, listener: second)

        harness.sockets[0].fail()

        await waitUntil("both listeners get the failure") { first.errors.count == 1 && second.errors.count == 1 }
        XCTAssertEqual((first.errors.first as? URLError)?.code, .networkConnectionLost)
        XCTAssertEqual(harness.session.connectionCount, 0)

        // A later acquire on the same key opens a new socket rather than joining the dead one.
        let later = RecordingListener()
        try harness.session.acquire(wsUrl: url, listener: later)
        XCTAssertEqual(harness.sockets.count, 2)
        let newSocket = try XCTUnwrap(harness.sockets.dropFirst().first)

        // A stale release from a listener of the dead socket leaves the new one alone.
        harness.session.release(wsUrl: url, listener: first)
        XCTAssertFalse(newSocket.isCancelled)
        harness.session.release(wsUrl: url, listener: later)
        XCTAssertTrue(newSocket.isCancelled)
    }

    // MARK: - Keep-alive

    func testPingsEveryNineMinutesWhileTheSocketHasAListener() async throws {
        let harness = FakeRealtimeHarness()
        let listener = RecordingListener()
        try harness.session.acquire(wsUrl: url, listener: listener)
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

        harness.session.release(wsUrl: url, listener: listener)
    }

    func testOneKeepAlivePerSocketNotPerListener() async throws {
        let harness = FakeRealtimeHarness()
        let first = RecordingListener()
        let second = RecordingListener()
        try harness.session.acquire(wsUrl: url, listener: first)
        try harness.session.acquire(wsUrl: url, listener: second)

        await waitUntil("one keep-alive waits") { harness.clock.pendingDurations.count == 1 }
        harness.clock.advance(by: WebSocketSession.keepAliveInterval)
        await waitUntil("one ping") { harness.sockets[0].pingCount == 1 }
        try await Task.sleep(nanoseconds: 20_000_000)
        XCTAssertEqual(harness.sockets[0].pingCount, 1)

        harness.session.release(wsUrl: url, listener: first)
        harness.session.release(wsUrl: url, listener: second)
    }

    func testKeepAliveStopsWhenTheLastListenerLeaves() async throws {
        let harness = FakeRealtimeHarness()
        let first = RecordingListener()
        let second = RecordingListener()
        try harness.session.acquire(wsUrl: url, listener: first)
        try harness.session.acquire(wsUrl: url, listener: second)
        await waitUntil("the keep-alive waits") { harness.clock.pendingDurations.count == 1 }

        harness.session.release(wsUrl: url, listener: first)
        try await Task.sleep(nanoseconds: 20_000_000)
        XCTAssertEqual(harness.clock.pendingDurations.count, 1, "the keep-alive runs while a listener remains")

        harness.session.release(wsUrl: url, listener: second)
        await waitUntil("the keep-alive stops") { harness.clock.pendingDurations.isEmpty }
        harness.clock.advance(by: WebSocketSession.keepAliveInterval)
        try await Task.sleep(nanoseconds: 20_000_000)
        XCTAssertEqual(harness.sockets[0].pingCount, 0)
    }

    func testKeepAliveStopsWhenTheSocketFails() async throws {
        let harness = FakeRealtimeHarness()
        let listener = RecordingListener()
        try harness.session.acquire(wsUrl: url, listener: listener)
        await waitUntil("the keep-alive waits") { harness.clock.pendingDurations.count == 1 }

        harness.sockets[0].fail()

        await waitUntil("the keep-alive stops") { harness.clock.pendingDurations.isEmpty }
        harness.session.release(wsUrl: url, listener: listener)
    }

    // MARK: - Handshake deadline

    private var handshakeNanoseconds: UInt64 { UInt64(WebSocketSession.handshakeTimeout * 1_000_000_000) }

    func testAHandshakeThatNeverCompletesFailsAfterTheHandshakeTimeout() async throws {
        let harness = FakeRealtimeHarness(completesHandshake: false)
        let listener = RecordingListener()
        try harness.session.acquire(wsUrl: url, listener: listener)
        let deadline = handshakeNanoseconds
        await waitUntil("the handshake deadline waits") { harness.handshakeClock.pendingDurations == [deadline] }

        harness.handshakeClock.advance(by: handshakeNanoseconds - 1)
        try await Task.sleep(nanoseconds: 20_000_000)
        XCTAssertTrue(listener.errors.isEmpty, "no failure before the handshake timeout")
        XCTAssertEqual(harness.session.connectionCount, 1)

        harness.handshakeClock.advance(by: 1)
        await waitUntil("the listener hears the timeout") { !listener.errors.isEmpty }
        XCTAssertEqual((listener.errors.first as? URLError)?.code, .timedOut)
        XCTAssertEqual(harness.session.connectionCount, 0)
        XCTAssertTrue(harness.sockets[0].isCancelled)
        await waitUntil("the keep-alive stops") { harness.clock.pendingDurations.isEmpty }
        try await Task.sleep(nanoseconds: 20_000_000)
        XCTAssertEqual(listener.errors.count, 1, "the timeout is reported once")
    }

    func testACompletedHandshakeCancelsTheDeadline() async throws {
        let harness = FakeRealtimeHarness(completesHandshake: false)
        let listener = RecordingListener()
        try harness.session.acquire(wsUrl: url, listener: listener)
        await waitUntil("the handshake deadline waits") { harness.handshakeClock.pendingDurations.count == 1 }

        harness.sockets[0].completeHandshake()

        await waitUntil("the deadline is cancelled") { harness.handshakeClock.pendingDurations.isEmpty }
        harness.handshakeClock.advance(by: handshakeNanoseconds)
        try await Task.sleep(nanoseconds: 20_000_000)
        XCTAssertTrue(listener.errors.isEmpty)
        XCTAssertEqual(harness.session.connectionCount, 1)
        harness.session.release(wsUrl: url, listener: listener)
    }

    func testAFrameFromTheServerCompletesTheHandshake() async throws {
        let harness = FakeRealtimeHarness(completesHandshake: false)
        let listener = RecordingListener()
        try harness.session.acquire(wsUrl: url, listener: listener)
        await waitUntil("the handshake deadline waits") { harness.handshakeClock.pendingDurations.count == 1 }

        harness.sockets[0].deliver(#"{"type":"subscribe_success","channel":"c"}"#)

        await waitUntil("the deadline is cancelled") { harness.handshakeClock.pendingDurations.isEmpty }
        XCTAssertEqual(harness.session.connectionCount, 1)
        harness.session.release(wsUrl: url, listener: listener)
    }

    func testReleasingBeforeTheHandshakeCompletesStopsTheDeadline() async throws {
        let harness = FakeRealtimeHarness(completesHandshake: false)
        let listener = RecordingListener()
        try harness.session.acquire(wsUrl: url, listener: listener)
        await waitUntil("the handshake deadline waits") { harness.handshakeClock.pendingDurations.count == 1 }

        harness.session.release(wsUrl: url, listener: listener)

        await waitUntil("the deadline is cancelled") { harness.handshakeClock.pendingDurations.isEmpty }
        XCTAssertTrue(listener.errors.isEmpty)
    }

    // MARK: - Task handles

    func testASocketThatFailsAtOnceLeavesNoKeepAliveRunning() async throws {
        // The receive loop can drop the socket before `acquire` returns. The keep-alive must still stop.
        for _ in 0 ..< 200 {
            let clock = ManualClock()
            let handshakeClock = ManualClock()
            let session = WebSocketSession(
                makeSocket: { request in
                    let socket = FakeRealtimeSocket(request: request)
                    socket.fail()
                    return socket
                },
                sleep: { try await clock.sleep($0) },
                handshakeSleep: { try await handshakeClock.sleep($0) }
            )
            let listener = RecordingListener()
            try session.acquire(wsUrl: url, listener: listener)
            await waitUntil("the listener hears the failure") { !listener.errors.isEmpty }
            XCTAssertEqual(session.connectionCount, 0)
            // A sleep that starts after the drop is cancelled at once, so none stays waiting.
            await waitUntil("the keep-alive stops") { clock.pendingDurations.isEmpty }
            await waitUntil("the handshake deadline stops") { handshakeClock.pendingDurations.isEmpty }
        }
    }
}
