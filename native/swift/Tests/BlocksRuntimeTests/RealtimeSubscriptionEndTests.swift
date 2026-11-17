//
// Copyright Amazon.com Inc. or its affiliates.
// All Rights Reserved.
//
// SPDX-License-Identifier: Apache-2.0
//

import XCTest
@testable import BlocksRuntime

/// How a `RealtimeChannel` stream ends, on a fake socket. The stream finishes normally only on cancel or `close()`;
/// every other end finishes it with a typed error.
final class RealtimeSubscriptionEndTests: XCTestCase {

    private func message(_ channel: String, x value: Int) -> String {
        #"{"type":"message","channel":"\#(channel)","data":{"x":\#(value)}}"#
    }

    /// Subscribes and waits until the subscribe frame is sent.
    private func subscribed(
        _ channel: RealtimeChannel<[String: Int]>,
        on harness: FakeRealtimeHarness,
        socket index: Int = 0
    ) async -> StreamRecorder<[String: Int]> {
        let recorder = StreamRecorder(channel.subscribe())
        let expected = #"{"action":"subscribe","channel":"\#(channel.channel)","token":"\#(channel.token)"}"#
        await waitUntil("the subscribe frame is sent") {
            harness.sockets.count > index && harness.sockets[index].sent.filter { $0 == expected }.count >= 1
        }
        return recorder
    }

    private func assertSubscriptionEnded(
        _ end: StreamEnd?,
        channel: String,
        code: String?,
        message: String,
        file: StaticString = #filePath,
        line: UInt = #line
    ) {
        guard case .threw(let error)? = end,
              case RealtimeError.subscriptionEnded(let gotChannel, let gotCode, let gotMessage, let underlying)? =
              error as? RealtimeError else {
            return XCTFail("Expected subscriptionEnded, got \(String(describing: end))", file: file, line: line)
        }
        XCTAssertEqual(gotChannel, channel, file: file, line: line)
        XCTAssertEqual(gotCode, code, file: file, line: line)
        XCTAssertEqual(gotMessage, message, file: file, line: line)
        XCTAssertNil(underlying, file: file, line: line)
        XCTAssertEqual((error as? RealtimeError)?.message, message, file: file, line: line)
    }

    // MARK: - Messages

    func testDeliversMessagesAndIgnoresControlFramesAndOtherChannels() async {
        let harness = FakeRealtimeHarness()
        let channel = harness.channel("c")
        let recorder = await subscribed(channel, on: harness)
        let socket = harness.sockets[0]

        // subscribe() doesn't wait for the confirmation; it is ignored when it comes.
        socket.deliver(#"{"type":"subscribe_success","channel":"c"}"#)
        socket.deliver(message("other", x: 1))
        socket.deliver(#"{"type":"error","channel":"other","code":"token_expired","message":"m"}"#)
        socket.deliver(message("c", x: 2))

        await waitUntil("the message arrives") { recorder.values.count == 1 }
        XCTAssertEqual(recorder.values, [["x": 2]])
        XCTAssertNil(recorder.end)
        channel.close()
    }

    // MARK: - Error frames for the channel

    func testErrorFrameForTheChannelEndsTheStreamWithSubscriptionEnded() async {
        struct Case {
            let frame: String
            let code: String?
            let message: String
        }
        let cases: [Case] = [
            Case(
                frame: #"{"type":"error","channel":"c","code":"token_expired","message":"Channel token expired"}"#,
                code: "token_expired",
                message: "Channel token expired"
            ),
            Case(
                frame: #"{"type":"error","channel":"c","code":"access_revoked","message":"Access revoked"}"#,
                code: "access_revoked",
                message: "Access revoked"
            ),
            Case(
                frame: #"{"type":"error","channel":"c","code":"principal_mismatch","message":"Wrong user"}"#,
                code: "principal_mismatch",
                message: "Wrong user"
            ),
            // A refused subscribe has no code.
            Case(
                frame: #"{"type":"error","channel":"c","message":"Unauthorized: invalid or expired token"}"#,
                code: nil,
                message: "Unauthorized: invalid or expired token"
            ),
            // A code the server adds later arrives as sent.
            Case(
                frame: #"{"type":"error","channel":"c","code":"some_new_code","message":"New"}"#,
                code: "some_new_code",
                message: "New"
            )
        ]
        for testCase in cases {
            let harness = FakeRealtimeHarness()
            let channel = harness.channel("c")
            let recorder = await subscribed(channel, on: harness)

            harness.sockets[0].deliver(testCase.frame)

            assertSubscriptionEnded(
                await recorder.ended(), channel: "c", code: testCase.code, message: testCase.message
            )
            // The ended subscription leaves the pool; it was the socket's only one, so the socket closes.
            await waitUntil("the socket closes") { harness.sockets[0].isCancelled }
            XCTAssertEqual(harness.session.connectionCount, 0)
        }
    }

    func testErrorFrameWithoutMessageGetsADefault() async {
        let harness = FakeRealtimeHarness()
        let recorder = await subscribed(harness.channel("c"), on: harness)

        harness.sockets[0].deliver(#"{"type":"error","channel":"c","code":"token_expired"}"#)

        assertSubscriptionEnded(await recorder.ended(), channel: "c", code: "token_expired", message: "Subscription ended")
    }

    func testErrorFrameEndsOnlyItsChannelAndTheSocketKeepsServingTheOthers() async {
        let harness = FakeRealtimeHarness()
        let expiring = harness.channel("a")
        let healthy = harness.channel("b")
        let expiringRecorder = await subscribed(expiring, on: harness)
        let healthyRecorder = await subscribed(healthy, on: harness)
        XCTAssertEqual(harness.sockets.count, 1, "both channels share the socket")
        let socket = harness.sockets[0]

        socket.deliver(#"{"type":"error","channel":"a","code":"token_expired","message":"expired"}"#)
        assertSubscriptionEnded(await expiringRecorder.ended(), channel: "a", code: "token_expired", message: "expired")

        socket.deliver(message("b", x: 5))
        await waitUntil("b still receives") { healthyRecorder.values == [["x": 5]] }
        XCTAssertNil(healthyRecorder.end)
        XCTAssertFalse(socket.isCancelled)

        // The keep-alive carries on for the remaining subscription.
        await waitUntil("the keep-alive waits") { harness.clock.pendingDurations.count == 1 }
        harness.clock.advance(by: WebSocketSession.keepAliveInterval)
        await waitUntil("a ping") { socket.pingCount == 1 }
        healthy.close()
    }

    func testEverySubscriberOfTheChannelOnTheSocketGetsTheError() async {
        let harness = FakeRealtimeHarness()
        let channel = harness.channel("c")
        let first = StreamRecorder(channel.subscribe())
        let second = StreamRecorder(channel.subscribe())
        await waitUntil("both subscribe frames are sent") {
            harness.sockets.first.map { $0.sent.filter { $0.contains("subscribe") }.count == 2 } ?? false
        }

        harness.sockets[0].deliver(#"{"type":"error","channel":"c","code":"access_revoked","message":"revoked"}"#)

        assertSubscriptionEnded(await first.ended(), channel: "c", code: "access_revoked", message: "revoked")
        assertSubscriptionEnded(await second.ended(), channel: "c", code: "access_revoked", message: "revoked")
    }

    // MARK: - Error frames for the socket

    func testErrorFrameWithoutChannelEndsEverySubscriptionWithConnectionFailed() async {
        let harness = FakeRealtimeHarness()
        let first = await subscribed(harness.channel("a"), on: harness)
        let second = await subscribed(harness.channel("b"), on: harness)

        harness.sockets[0].deliver(#"{"type":"error","message":"Invalid channel"}"#)

        for recorder in [first, second] {
            guard case .threw(let error)? = await recorder.ended(),
                  case RealtimeError.connectionFailed(let message, let underlying)? = error as? RealtimeError else {
                XCTFail("Expected connectionFailed, got \(String(describing: recorder.end))")
                continue
            }
            XCTAssertEqual(message, "Invalid channel")
            XCTAssertNil(underlying)
        }
        await waitUntil("the socket closes") { harness.sockets[0].isCancelled }
    }

    // MARK: - Socket failure

    func testSocketFailureEndsTheStreamWithConnectionFailedAndTheNextSubscribeOpensANewSocket() async {
        let harness = FakeRealtimeHarness()
        let channel = harness.channel("c")
        let recorder = await subscribed(channel, on: harness)

        harness.sockets[0].fail(URLError(.networkConnectionLost))

        guard case .threw(let error)? = await recorder.ended(),
              case RealtimeError.connectionFailed(_, let underlying)? = error as? RealtimeError else {
            return XCTFail("Expected connectionFailed, got \(String(describing: recorder.end))")
        }
        XCTAssertEqual((underlying as? URLError)?.code, .networkConnectionLost)
        XCTAssertEqual(harness.session.connectionCount, 0, "the dead socket left the pool")

        // A later subscribe on the same handle doesn't join the dead socket.
        let again = await subscribed(channel, on: harness, socket: 1)
        harness.sockets[1].deliver(message("c", x: 9))
        await waitUntil("the new socket delivers") { again.values == [["x": 9]] }
        channel.close()
    }

    func testInvalidURLEndsTheStreamWithConnectionFailed() async {
        let harness = FakeRealtimeHarness()
        let recorder = StreamRecorder(harness.channel("c", wsUrl: "").subscribe())

        guard case .threw(let error)? = await recorder.ended(),
              case RealtimeError.connectionFailed(let message, _)? = error as? RealtimeError else {
            return XCTFail("Expected connectionFailed, got \(String(describing: recorder.end))")
        }
        XCTAssertTrue(message.contains("Invalid WebSocket URL"))
    }

    // MARK: - Decode failure

    func testMessageThatFailsToDecodeEndsTheStreamWithTheDecodingError() async {
        let harness = FakeRealtimeHarness()
        let recorder = await subscribed(harness.channel("c"), on: harness)

        harness.sockets[0].deliver(#"{"type":"message","channel":"c","data":{"x":"not a number"}}"#)

        guard case .threw(let error)? = await recorder.ended() else {
            return XCTFail("Expected a throw, got \(String(describing: recorder.end))")
        }
        XCTAssertTrue(error is DecodingError, "got \(error)")
        await waitUntil("the socket closes") { harness.sockets[0].isCancelled }
    }

    // MARK: - App-initiated ends

    func testCloseFinishesEveryActiveStreamNormallyAndClosesTheSocket() async {
        let harness = FakeRealtimeHarness()
        let channel = harness.channel("c")
        let first = StreamRecorder(channel.subscribe())
        let second = StreamRecorder(channel.subscribe())
        await waitUntil("both subscribe frames are sent") {
            harness.sockets.first.map { $0.sent.filter { $0.contains("subscribe") }.count == 2 } ?? false
        }

        channel.close()

        for recorder in [first, second] {
            guard case .finished? = await recorder.ended() else {
                XCTFail("Expected a normal finish, got \(String(describing: recorder.end))")
                continue
            }
        }
        await waitUntil("the socket closes") { harness.sockets[0].isCancelled }
        XCTAssertEqual(harness.session.connectionCount, 0)
        await waitUntil("the keep-alive stops") { harness.clock.pendingDurations.isEmpty }

        let afterClose = StreamRecorder(channel.subscribe())
        guard case .threw(let error)? = await afterClose.ended(), case RealtimeError.channelClosed? = error as? RealtimeError else {
            return XCTFail("Expected channelClosed, got \(String(describing: afterClose.end))")
        }
    }

    func testCloseLeavesOtherHandlesOnTheSocketOpen() async {
        let harness = FakeRealtimeHarness()
        let closing = harness.channel("a")
        let staying = harness.channel("b")
        let closingRecorder = await subscribed(closing, on: harness)
        let stayingRecorder = await subscribed(staying, on: harness)

        closing.close()

        guard case .finished? = await closingRecorder.ended() else {
            return XCTFail("Expected a normal finish, got \(String(describing: closingRecorder.end))")
        }
        harness.sockets[0].deliver(message("b", x: 3))
        await waitUntil("b still receives") { stayingRecorder.values == [["x": 3]] }
        XCTAssertFalse(harness.sockets[0].isCancelled)
        staying.close()
    }

    func testCancellingTheIterationFinishesNormallyAndReleasesTheSocket() async {
        let harness = FakeRealtimeHarness()
        let recorder = await subscribed(harness.channel("c"), on: harness)

        recorder.cancel()

        await waitUntil("the socket closes") { harness.sockets[0].isCancelled }
        XCTAssertEqual(harness.session.connectionCount, 0)
    }

    // MARK: - Renewal is the app's call

    /// The pattern the docs show: catch `token_expired`, get a fresh handle, subscribe again. The SDK sends nothing
    /// on its own after the error.
    func testAppRenewsByGettingAFreshHandle() async throws {
        let harness = FakeRealtimeHarness()
        let expired = harness.channel("c", token: "old")
        let stream = expired.subscribe()
        await waitUntil("the subscribe frame is sent") { harness.sockets.first?.sent.isEmpty == false }
        let socket = harness.sockets[0]

        socket.deliver(#"{"type":"error","channel":"c","code":"token_expired","message":"expired"}"#)
        var renew = false
        do {
            for try await _ in stream {}
            XCTFail("Expected the stream to throw")
        } catch RealtimeError.subscriptionEnded(_, "token_expired", _, _) {
            renew = true
        }
        XCTAssertTrue(renew)
        await waitUntil("the socket closes") { socket.isCancelled }
        XCTAssertEqual(socket.sent.filter { $0.contains("subscribe") }.count, 1, "the SDK doesn't subscribe again")

        let fresh = harness.channel("c", token: "new")
        let recorder = await subscribed(fresh, on: harness, socket: 1)
        harness.sockets[1].deliver(message("c", x: 1))
        await waitUntil("the fresh handle receives") { recorder.values == [["x": 1]] }
        fresh.close()
    }
}
