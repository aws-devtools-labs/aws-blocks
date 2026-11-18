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

    func testErrorFrameWithMissingOrEmptyMessageOrNonStringCodeGetsDefaults() async {
        let frames = [
            #"{"type":"error","channel":"c","code":"token_expired"}"#,
            #"{"type":"error","channel":"c","code":"token_expired","message":""}"#,
            #"{"type":"error","channel":"c","code":"token_expired","message":7}"#
        ]
        for frame in frames {
            let harness = FakeRealtimeHarness()
            let recorder = await subscribed(harness.channel("c"), on: harness)
            harness.sockets[0].deliver(frame)
            assertSubscriptionEnded(
                await recorder.ended(),
                channel: "c",
                code: "token_expired",
                message: #"The server ended the subscription to "c""#
            )
        }

        let harness = FakeRealtimeHarness()
        let recorder = await subscribed(harness.channel("c"), on: harness)
        harness.sockets[0].deliver(#"{"type":"error","channel":"c","code":42,"message":"m"}"#)
        assertSubscriptionEnded(await recorder.ended(), channel: "c", code: nil, message: "m")
    }

    func testFramesThatArentJSONObjectsOrLackAStringChannelAreIgnored() async {
        let harness = FakeRealtimeHarness()
        let channel = harness.channel("c")
        let recorder = await subscribed(channel, on: harness)
        let socket = harness.sockets[0]

        for frame in [
            "not json",
            "[1,2]",
            #""a string""#,
            "null",
            #"{"type":"message","data":{"x":1}}"#,
            #"{"type":"message","channel":5,"data":{"x":1}}"#,
            #"{"type":"subscribe_success","channel":"c"}"#,
            #"{"channel":"c","data":{"x":1}}"#
        ] {
            socket.deliver(frame)
        }
        socket.deliver(message("c", x: 2))

        await waitUntil("the message arrives") { recorder.values.count == 1 }
        XCTAssertEqual(recorder.values, [["x": 2]])
        XCTAssertNil(recorder.end)
        channel.close()
    }

    func testHandlesForDifferentChannelsOnOneURLShareOneSocket() async {
        let harness = FakeRealtimeHarness()
        let first = harness.channel("a", token: "token-a")
        let second = harness.channel("b", token: "token-b")
        let firstRecorder = await subscribed(first, on: harness)
        let secondRecorder = await subscribed(second, on: harness)
        XCTAssertEqual(harness.sockets.count, 1)

        harness.sockets[0].deliver(message("b", x: 2))
        harness.sockets[0].deliver(message("a", x: 1))

        await waitUntil("each gets its own channel") {
            firstRecorder.values == [["x": 1]] && secondRecorder.values == [["x": 2]]
        }
        first.close()
        second.close()
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
            assertConnectionFailed(await recorder.ended(), message: "Invalid channel")
        }
        XCTAssertEqual(harness.session.connectionCount, 0, "the socket left the pool")
        XCTAssertTrue(harness.sockets[0].isCancelled)

        let later = await subscribed(harness.channel("a"), on: harness, socket: 1)
        XCTAssertEqual(harness.sockets.count, 2, "a later subscribe opens a new socket")
        later.cancel()
    }

    func testErrorFrameWithoutChannelOrMessageGetsTheDefault() async {
        for frame in [#"{"type":"error"}"#, #"{"type":"error","message":""}"#, #"{"type":"error","channel":3}"#] {
            let harness = FakeRealtimeHarness()
            let recorder = await subscribed(harness.channel("c"), on: harness)
            harness.sockets[0].deliver(frame)
            assertConnectionFailed(await recorder.ended(), message: "The server reported a connection error")
        }
    }

    private func assertConnectionFailed(
        _ end: StreamEnd?,
        message: String,
        file: StaticString = #filePath,
        line: UInt = #line
    ) {
        guard case .threw(let error)? = end,
              case RealtimeError.connectionFailed(let got, let underlying)? = error as? RealtimeError else {
            return XCTFail("Expected connectionFailed, got \(String(describing: end))", file: file, line: line)
        }
        XCTAssertEqual(got, message, file: file, line: line)
        XCTAssertNil(underlying, file: file, line: line)
    }

    func testServerCloseEndsTheStreamWithConnectionFailedCarryingTheCloseCodeAndReason() async {
        let harness = FakeRealtimeHarness()
        let recorder = await subscribed(harness.channel("c"), on: harness)
        harness.sockets[0].fail(RealtimeSocketClosed(code: 1_001, reason: "Going away"))
        assertConnectionFailed(
            await recorder.ended(),
            message: #"The server closed the WebSocket (code 1001, reason "Going away")"#
        )
        XCTAssertEqual(harness.session.connectionCount, 0)

        let noReason = FakeRealtimeHarness()
        let other = await subscribed(noReason.channel("c"), on: noReason)
        noReason.sockets[0].fail(RealtimeSocketClosed(code: 1_006, reason: ""))
        assertConnectionFailed(await other.ended(), message: "The server closed the WebSocket (code 1006)")
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

    func testMessageThatFailsToDecodeEndsOnlyThatSubscriptionWithTheDecodingError() async {
        let harness = FakeRealtimeHarness()
        let broken = harness.channel("a")
        let healthy = harness.channel("b")
        let brokenRecorder = await subscribed(broken, on: harness)
        let healthyRecorder = await subscribed(healthy, on: harness)

        harness.sockets[0].deliver(#"{"type":"message","channel":"a","data":{"x":"not a number"}}"#)

        guard case .threw(let error)? = await brokenRecorder.ended() else {
            return XCTFail("Expected a throw, got \(String(describing: brokenRecorder.end))")
        }
        XCTAssertTrue(error is DecodingError, "got \(error)")
        harness.sockets[0].deliver(message("b", x: 4))
        await waitUntil("b still receives") { healthyRecorder.values == [["x": 4]] }
        XCTAssertFalse(harness.sockets[0].isCancelled)
        healthy.close()
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

    func testCloseDuringSubscribeLeavesNoListenerOnThePool() async {
        // `close()` lands after `subscribe()` registers its listener and before the listener joins the socket.
        let harness = FakeRealtimeHarness()
        let channel = harness.channel("c")
        channel.afterRegisteringListener = { channel.close() }

        // Held for the whole test: releasing the stream would run a late termination handler and hide the leak.
        let stream = channel.subscribe()
        let recorder = StreamRecorder(stream)

        guard case .finished? = await recorder.ended() else {
            return XCTFail("Expected a normal finish, got \(String(describing: recorder.end))")
        }
        await waitUntil("the socket closes") { harness.sockets.first?.isCancelled ?? true }
        XCTAssertEqual(harness.session.connectionCount, 0, "a listener left on the pool keeps the socket open")
        await waitUntil("the keep-alive stops") { harness.clock.pendingDurations.isEmpty }
        withExtendedLifetime(stream) {}
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
        XCTAssertFalse(harness.sockets[0].sent.contains { $0.contains("unsubscribe") }, "no unsubscribe when the socket closes with its last subscriber")
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

    // MARK: - Unsubscribe

    private func unsubscribes(_ socket: FakeRealtimeSocket) -> [String] {
        socket.sent.filter { $0.contains(#""action":"unsubscribe""#) }
    }

    /// Handles and recorders for channels `a` and `b`, subscribed on one socket.
    private struct TwoChannels {
        let first: RealtimeChannel<[String: Int]>
        let firstRecorder: StreamRecorder<[String: Int]>
        let second: RealtimeChannel<[String: Int]>
        let secondRecorder: StreamRecorder<[String: Int]>
    }

    private func twoChannels(_ harness: FakeRealtimeHarness) async -> TwoChannels {
        let first = harness.channel("a")
        let second = harness.channel("b")
        let firstRecorder = await subscribed(first, on: harness)
        let secondRecorder = await subscribed(second, on: harness)
        return TwoChannels(first: first, firstRecorder: firstRecorder, second: second, secondRecorder: secondRecorder)
    }

    func testCancellingAChannelsLastSubscriberOnASharedSocketSendsUnsubscribe() async {
        let harness = FakeRealtimeHarness()
        let pair = await twoChannels(harness)

        pair.firstRecorder.cancel()

        await waitUntil("the unsubscribe is sent") { self.unsubscribes(harness.sockets[0]).count == 1 }
        XCTAssertEqual(unsubscribes(harness.sockets[0]), [#"{"action":"unsubscribe","channel":"a"}"#])
        XCTAssertFalse(harness.sockets[0].isCancelled)
        pair.second.close()
    }

    func testCloseOnAHandleWhoseSocketStaysOpenSendsUnsubscribe() async {
        let harness = FakeRealtimeHarness()
        let pair = await twoChannels(harness)

        pair.first.close()

        await waitUntil("the unsubscribe is sent") { self.unsubscribes(harness.sockets[0]).count == 1 }
        XCTAssertEqual(unsubscribes(harness.sockets[0]), [#"{"action":"unsubscribe","channel":"a"}"#])
        pair.second.close()
        await waitUntil("the socket closes") { harness.sockets[0].isCancelled }
        XCTAssertEqual(unsubscribes(harness.sockets[0]).count, 1, "closing the last subscriber sends no unsubscribe")
    }

    func testDecodeFailureOnASharedSocketSendsUnsubscribe() async {
        let harness = FakeRealtimeHarness()
        let pair = await twoChannels(harness)

        harness.sockets[0].deliver(#"{"type":"message","channel":"a","data":{"x":"not a number"}}"#)

        _ = await pair.firstRecorder.ended()
        await waitUntil("the unsubscribe is sent") { self.unsubscribes(harness.sockets[0]).count == 1 }
        XCTAssertEqual(unsubscribes(harness.sockets[0]), [#"{"action":"unsubscribe","channel":"a"}"#])
        pair.second.close()
    }

    func testNoUnsubscribeWhileAnotherSubscriberStillHasTheChannel() async {
        let harness = FakeRealtimeHarness()
        let channel = harness.channel("a")
        let other = harness.channel("b")
        let first = StreamRecorder(channel.subscribe())
        let second = StreamRecorder(channel.subscribe())
        let otherRecorder = StreamRecorder(other.subscribe())
        await waitUntil("three subscribe frames are sent") {
            harness.sockets.first.map { $0.sent.filter { $0.contains(#""action":"subscribe""#) }.count == 3 } ?? false
        }

        first.cancel()
        try? await Task.sleep(nanoseconds: 50_000_000)
        XCTAssertTrue(unsubscribes(harness.sockets[0]).isEmpty)

        second.cancel()
        await waitUntil("the unsubscribe is sent") { self.unsubscribes(harness.sockets[0]).count == 1 }
        XCTAssertEqual(unsubscribes(harness.sockets[0]), [#"{"action":"unsubscribe","channel":"a"}"#])
        otherRecorder.cancel()
    }

    func testNoUnsubscribeWhenTheServerEndedTheSubscription() async {
        let harness = FakeRealtimeHarness()
        let pair = await twoChannels(harness)

        harness.sockets[0].deliver(#"{"type":"error","channel":"a","code":"token_expired","message":"expired"}"#)
        _ = await pair.firstRecorder.ended()
        harness.sockets[0].deliver(message("b", x: 1))
        await waitUntil("b still receives") { pair.secondRecorder.values == [["x": 1]] }

        XCTAssertTrue(unsubscribes(harness.sockets[0]).isEmpty)
        pair.second.close()
    }

    func testNoUnsubscribeAfterTheSocketFailed() async {
        let harness = FakeRealtimeHarness()
        let pair = await twoChannels(harness)

        harness.sockets[0].fail()
        _ = await pair.firstRecorder.ended()
        _ = await pair.secondRecorder.ended()
        try? await Task.sleep(nanoseconds: 50_000_000)

        XCTAssertTrue(unsubscribes(harness.sockets[0]).isEmpty)
    }

    func testNoUnsubscribeAfterAConnectionErrorFrame() async {
        let harness = FakeRealtimeHarness()
        let pair = await twoChannels(harness)

        harness.sockets[0].deliver(#"{"type":"error","message":"Invalid channel"}"#)
        _ = await pair.firstRecorder.ended()
        _ = await pair.secondRecorder.ended()
        try? await Task.sleep(nanoseconds: 50_000_000)

        XCTAssertTrue(unsubscribes(harness.sockets[0]).isEmpty)
    }

    // MARK: - Frame order and encoding

    /// Leaving a channel and subscribing to it again on a socket that stays open must reach the server as
    /// unsubscribe, then subscribe. The other way round, the server drops the new subscription and the new stream
    /// never receives. Repeated, because the order used to depend on which of two tasks ran first.
    func testUnsubscribeThenResubscribeReachesTheSocketInOrder() async {
        for run in 0 ..< 200 {
            let harness = FakeRealtimeHarness()
            let keeper = harness.channel("b")
            let keeperRecorder = StreamRecorder(keeper.subscribe())
            let leaving = harness.channel("a")
            _ = StreamRecorder(leaving.subscribe())
            await waitUntil("run \(run): the socket is open") { harness.sockets.first?.sent.count == 2 }

            leaving.close()
            let again = harness.channel("a")
            let againRecorder = StreamRecorder(again.subscribe())

            let unsubscribe = #"{"action":"unsubscribe","channel":"a"}"#
            let subscribe = #"{"action":"subscribe","channel":"a","token":"tok"}"#
            await waitUntil("run \(run): the frames are sent") {
                harness.sockets.first.map { $0.sent.filter { $0 == subscribe }.count == 2 } ?? false
            }
            let sent = harness.sockets[0].sent
            guard let unsubscribeIndex = sent.firstIndex(of: unsubscribe),
                  let resubscribeIndex = sent.lastIndex(of: subscribe) else {
                XCTFail("run \(run): expected an unsubscribe and a resubscribe, sent \(sent)")
                return
            }
            XCTAssertLessThan(unsubscribeIndex, resubscribeIndex, "run \(run): sent \(sent)")

            harness.sockets[0].deliver(message("a", x: run))
            await waitUntil("run \(run): the new stream receives") { againRecorder.values == [["x": run]] }
            keeper.close()
            again.close()
            _ = await keeperRecorder.ended()
        }
    }

    /// The keep-alive goes through the same queue as subscribes.
    func testPingIsQueuedAfterAPendingSubscribe() async {
        let harness = FakeRealtimeHarness()
        let channel = harness.channel("c")
        _ = await subscribed(channel, on: harness)
        await waitUntil("the keep-alive waits") { harness.clock.pendingDurations.count == 1 }

        harness.clock.advance(by: WebSocketSession.keepAliveInterval)

        await waitUntil("the ping is sent") { harness.sockets[0].pingCount == 1 }
        XCTAssertEqual(harness.sockets[0].sent.first, #"{"action":"subscribe","channel":"c","token":"tok"}"#)
        channel.close()
    }

    func testFramesEscapeQuotesAndBackslashesInChannelNamesAndTokens() async throws {
        let name = #"we"ird\name"#
        let token = #"t"o\k"#
        let harness = FakeRealtimeHarness()
        let keeper = harness.channel("b")
        let keeperRecorder = StreamRecorder(keeper.subscribe())
        let channel = harness.channel(name, token: token)
        let recorder = StreamRecorder(channel.subscribe())
        await waitUntil("both subscribes are sent") { harness.sockets.first?.sent.count == 2 }

        let subscribe = try XCTUnwrap(harness.sockets[0].sent.last)
        let decoded = try XCTUnwrap(
            JSONSerialization.jsonObject(with: Data(subscribe.utf8)) as? [String: String],
            "not valid JSON: \(subscribe)"
        )
        XCTAssertEqual(decoded, ["action": "subscribe", "channel": name, "token": token])

        // The server's frames for that channel route to it.
        let frame = try XCTUnwrap(String(
            bytes: JSONSerialization.data(withJSONObject: ["type": "message", "channel": name, "data": ["x": 3]]),
            encoding: .utf8
        ))
        harness.sockets[0].deliver(frame)
        await waitUntil("the message arrives") { recorder.values == [["x": 3]] }

        channel.close()
        await waitUntil("the unsubscribe is sent") { harness.sockets[0].sent.count == 3 }
        let unsubscribe = try XCTUnwrap(harness.sockets[0].sent.last)
        XCTAssertEqual(
            try JSONSerialization.jsonObject(with: Data(unsubscribe.utf8)) as? [String: String],
            ["action": "unsubscribe", "channel": name]
        )
        keeper.close()
        _ = await keeperRecorder.ended()
    }

    func testFramesMatchTheWebClientShapeForPlainNames() {
        XCTAssertEqual(
            WebSocketSession.subscribeFrame(channel: "room/1", token: "abc.def"),
            #"{"action":"subscribe","channel":"room/1","token":"abc.def"}"#
        )
        XCTAssertEqual(
            WebSocketSession.unsubscribeFrame(channel: "room/1"),
            #"{"action":"unsubscribe","channel":"room/1"}"#
        )
    }
}
