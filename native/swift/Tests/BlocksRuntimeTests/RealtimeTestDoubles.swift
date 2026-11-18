//
// Copyright Amazon.com Inc. or its affiliates.
// All Rights Reserved.
//
// SPDX-License-Identifier: Apache-2.0
//

import Foundation
import XCTest
@testable import BlocksRuntime

/// A socket the test drives: `deliver` and `fail` feed `receive()`, and `sent` records every frame the SDK sends.
final class FakeRealtimeSocket: RealtimeSocket {
    let request: URLRequest
    private let lock = NSLock()
    private var _sent: [String] = []
    private var _cancelled = false
    private var _resumed = false
    private let inbound: AsyncThrowingStream<String, Error>
    private let inboundContinuation: AsyncThrowingStream<String, Error>.Continuation
    private var iterator: AsyncThrowingStream<String, Error>.AsyncIterator

    /// Sends waiting for the handshake to complete. Only used when `completesHandshake` is false.
    private var pendingSends: [CheckedContinuation<Void, Error>] = []
    private var _handshakeCompleted: Bool

    struct Closed: Error {}

    /// - Parameter completesHandshake: False for a server that accepts the connection but never completes the
    ///   handshake: sends wait until `completeHandshake()` or `cancel`.
    init(request: URLRequest, completesHandshake: Bool = true) {
        self.request = request
        self._handshakeCompleted = completesHandshake
        var continuation: AsyncThrowingStream<String, Error>.Continuation!
        self.inbound = AsyncThrowingStream { continuation = $0 }
        self.inboundContinuation = continuation
        self.iterator = inbound.makeAsyncIterator()
    }

    var sent: [String] {
        lock.lock()
        defer { lock.unlock() }
        return _sent
    }

    var isCancelled: Bool {
        lock.lock()
        defer { lock.unlock() }
        return _cancelled
    }

    var isResumed: Bool {
        lock.lock()
        defer { lock.unlock() }
        return _resumed
    }

    var pingCount: Int {
        sent.filter { $0 == WebSocketSession.pingFrame }.count
    }

    /// A frame from the server.
    func deliver(_ text: String) {
        inboundContinuation.yield(text)
    }

    /// The socket fails or the server closes it.
    func fail(_ error: Error = URLError(.networkConnectionLost)) {
        inboundContinuation.finish(throwing: error)
    }

    func resume() {
        lock.lock()
        _resumed = true
        lock.unlock()
    }

    /// Completes the handshake, letting waiting sends through.
    func completeHandshake() {
        let waiting = lock.withLock { () -> [CheckedContinuation<Void, Error>] in
            _handshakeCompleted = true
            defer { pendingSends = [] }
            return pendingSends
        }
        waiting.forEach { $0.resume() }
    }

    func send(_ text: String) async throws {
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            let state = lock.withLock { () -> Bool? in
                if _cancelled { return false }
                if _handshakeCompleted { return true }
                pendingSends.append(continuation)
                return nil
            }
            switch state {
            case true?: continuation.resume()
            case false?: continuation.resume(throwing: Closed())
            case nil: break
            }
        }
        let sent = lock.withLock { () -> Bool in
            if _cancelled { return false }
            _sent.append(text)
            return true
        }
        if !sent { throw Closed() }
    }

    func receive() async throws -> String? {
        // Only the pool's receive loop calls this, one call at a time.
        guard let text = try await iterator.next() else { throw Closed() }
        return text
    }

    func cancel(reason: String) {
        lock.lock()
        _cancelled = true
        let waiting = pendingSends
        pendingSends = []
        lock.unlock()
        waiting.forEach { $0.resume(throwing: Closed()) }
        inboundContinuation.finish(throwing: CancellationError())
    }
}

/// A clock the test advances by hand. `sleep` suspends until `advance` passes its deadline, and throws when the
/// sleeping task is cancelled.
final class ManualClock: @unchecked Sendable {
    private struct Sleeper {
        let id: Int
        let deadline: UInt64
        let duration: UInt64
        let continuation: CheckedContinuation<Void, Error>
    }

    private let lock = NSLock()
    private var now: UInt64 = 0
    private var nextId = 0
    private var sleepers: [Sleeper] = []

    /// The durations of the sleeps currently waiting.
    var pendingDurations: [UInt64] {
        lock.lock()
        defer { lock.unlock() }
        return sleepers.map(\.duration)
    }

    func sleep(_ nanoseconds: UInt64) async throws {
        let id = lock.withLock { () -> Int in
            defer { nextId += 1 }
            return nextId
        }
        try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
                lock.lock()
                if Task.isCancelled {
                    lock.unlock()
                    continuation.resume(throwing: CancellationError())
                    return
                }
                sleepers.append(Sleeper(id: id, deadline: now + nanoseconds, duration: nanoseconds, continuation: continuation))
                lock.unlock()
            }
        } onCancel: {
            lock.lock()
            let index = sleepers.firstIndex { $0.id == id }
            let sleeper = index.map { sleepers.remove(at: $0) }
            lock.unlock()
            sleeper?.continuation.resume(throwing: CancellationError())
        }
    }

    func advance(by nanoseconds: UInt64) {
        lock.lock()
        now += nanoseconds
        let due = sleepers.filter { $0.deadline <= now }
        sleepers.removeAll { $0.deadline <= now }
        lock.unlock()
        for sleeper in due {
            sleeper.continuation.resume()
        }
    }
}

/// A pool on fake sockets and a manual clock.
final class FakeRealtimeHarness {
    /// Drives the keep-alive.
    let clock = ManualClock()
    /// Drives the handshake deadline.
    let handshakeClock = ManualClock()
    private let completesHandshake: Bool
    private let lock = NSLock()
    private var _sockets: [FakeRealtimeSocket] = []
    private(set) lazy var session = WebSocketSession(
        makeSocket: { [unowned self] request in
            let socket = FakeRealtimeSocket(request: request, completesHandshake: completesHandshake)
            lock.lock()
            _sockets.append(socket)
            lock.unlock()
            return socket
        },
        sleep: { [clock] in try await clock.sleep($0) },
        handshakeSleep: { [handshakeClock] in try await handshakeClock.sleep($0) }
    )

    /// - Parameter completesHandshake: False for sockets whose handshake waits for `completeHandshake()`.
    init(completesHandshake: Bool = true) {
        self.completesHandshake = completesHandshake
    }

    var sockets: [FakeRealtimeSocket] {
        lock.lock()
        defer { lock.unlock() }
        return _sockets
    }

    func channel(_ name: String = "c", wsUrl: String = "wss://example.com/rt", token: String = "tok")
        -> RealtimeChannel<[String: Int]> {
        RealtimeChannel(channel: name, wsUrl: wsUrl, token: token, webSocketSession: session) { data in
            try JSONDecoder().decode([String: Int].self, from: data)
        }
    }
}

/// Polls `condition` until it holds, failing the test after `timeout` seconds.
func waitUntil(
    _ description: String,
    timeout: TimeInterval = 2,
    file: StaticString = #filePath,
    line: UInt = #line,
    _ condition: () -> Bool
) async {
    let deadline = Date().addingTimeInterval(timeout)
    while !condition() {
        if Date() > deadline {
            XCTFail("Timed out waiting until \(description)", file: file, line: line)
            return
        }
        try? await Task.sleep(nanoseconds: 2_000_000)
    }
}

/// How a subscription's stream ended.
enum StreamEnd {
    case finished
    case threw(Error)
}

/// Collects a stream's values and how it ended, on its own task.
final class StreamRecorder<T>: @unchecked Sendable {
    private let lock = NSLock()
    private var _values: [T] = []
    private var _end: StreamEnd?
    private var task: Task<Void, Never>?

    init(_ stream: AsyncThrowingStream<T, Error>) {
        self.task = Task { [weak self] in
            do {
                for try await value in stream {
                    self?.append(value)
                }
                self?.setEnd(.finished)
            } catch {
                self?.setEnd(.threw(error))
            }
        }
    }

    private func append(_ value: T) {
        lock.lock()
        _values.append(value)
        lock.unlock()
    }

    private func setEnd(_ end: StreamEnd) {
        lock.lock()
        _end = end
        lock.unlock()
    }

    var values: [T] {
        lock.lock()
        defer { lock.unlock() }
        return _values
    }

    var end: StreamEnd? {
        lock.lock()
        defer { lock.unlock() }
        return _end
    }

    func cancel() {
        task?.cancel()
    }

    /// Waits for the stream to end and returns how.
    func ended(file: StaticString = #filePath, line: UInt = #line) async -> StreamEnd? {
        await waitUntil("the stream ended", file: file, line: line) { end != nil }
        return end
    }
}
