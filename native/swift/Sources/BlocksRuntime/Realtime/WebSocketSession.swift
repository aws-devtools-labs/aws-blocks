//
// Copyright Amazon.com Inc. or its affiliates.
// All Rights Reserved.
//
// SPDX-License-Identifier: Apache-2.0
//

import Foundation
import os

private let logger = Logger(subsystem: "com.aws.blocks.swift", category: "WebSocketSession")

/// A managed WebSocket wrapper that tracks its connection key for session release.
@available(*, deprecated, message: "Not used by RealtimeChannel. It will be removed in a future release.")
public class WebSocketConnection {
    public let task: URLSessionWebSocketTask
    public let key: String

    init(task: URLSessionWebSocketTask, key: String) {
        self.task = task
        self.key = key
    }
}

/// Callback interface for WebSocket events.
@available(*, deprecated, message: "Not used by RealtimeChannel. It will be removed in a future release.")
public protocol WebSocketDelegate: AnyObject {
    func onOpen(_ webSocket: URLSessionWebSocketTask)
    func onMessage(_ webSocket: URLSessionWebSocketTask, text: String)
    func onFailure(_ webSocket: URLSessionWebSocketTask, error: Error)
    func onClosed(_ webSocket: URLSessionWebSocketTask, code: Int, reason: String)
}

// MARK: - Socket abstraction

/// The socket operations the pool uses. `URLSessionWebSocketTask` backs it in the app; tests pass a fake.
protocol RealtimeSocket: AnyObject {
    func resume()
    /// Sends a text frame.
    func send(_ text: String) async throws
    /// Waits for the next frame. Returns `nil` for a frame that carries no text. Throws `RealtimeSocketClosed` when
    /// the other side closes the socket with a close frame, and the platform error when the socket fails.
    func receive() async throws -> String?
    /// Closes the socket from this side.
    func cancel(reason: String)
}

/// The server or the gateway closed the socket with a close frame.
struct RealtimeSocketClosed: Error {
    let code: Int
    let reason: String
}

/// Receives the events of one pooled socket.
protocol RealtimeSocketListener: AnyObject {
    /// The channel this listener subscribes to.
    var channel: String { get }
    /// Whether leaving the socket should unsubscribe the channel. False once the server has ended the subscription
    /// with an error frame, since the server already removed it.
    var unsubscribesOnLeave: Bool { get }
    /// The frame that subscribes this listener's channel. The pool queues it when the socket opens, or when the
    /// listener joins a socket that is already open.
    var subscribeFrame: String { get }
    /// A text frame arrived. Every listener on the socket gets every frame.
    func onMessage(_ text: String)
    /// The socket failed (the platform error) or was closed by the other side (`RealtimeSocketClosed`). The pool has
    /// already dropped it.
    func onFailure(_ error: Error)
}

/// `RealtimeSocket` over `URLSessionWebSocketTask`.
final class URLSessionRealtimeSocket: RealtimeSocket {
    let task: URLSessionWebSocketTask

    init(task: URLSessionWebSocketTask) {
        self.task = task
    }

    func resume() {
        task.resume()
    }

    func send(_ text: String) async throws {
        try await task.send(.string(text))
    }

    func receive() async throws -> String? {
        let message: URLSessionWebSocketTask.Message
        do {
            message = try await task.receive()
        } catch {
            // After a close frame, receive() fails with a generic socket error; the task holds the close code.
            if task.closeCode != .invalid {
                let reason = task.closeReason.flatMap { String(data: $0, encoding: .utf8) } ?? ""
                throw RealtimeSocketClosed(code: task.closeCode.rawValue, reason: reason)
            }
            throw error
        }
        switch message {
        case .string(let text):
            return text
        case .data(let data):
            return String(data: data, encoding: .utf8)
        @unknown default:
            return nil
        }
    }

    func cancel(reason: String) {
        task.cancel(with: .normalClosure, reason: Data(reason.utf8))
    }
}

/// Reference-counted pool that shares one WebSocket per `wsUrl` (which carries the connect token), with one reader
/// that dispatches every frame to every registered listener. Each listener picks out its own channel's frames.
/// Subscriptions to different channels, or several to one channel, share the socket.
///
/// While a socket has a listener, the pool sends the JSON keep-alive `{"action":"ping"}` every
/// ``keepAliveInterval``. The server re-checks the socket's subscriptions only on that message, and ends an expired
/// or revoked one with an error frame. A socket that fails or closes is dropped from the pool, so the next
/// `acquire` opens a new one. So is a socket that gets an error frame naming no channel, which ends every
/// subscription on it. When the last listener is released, the socket is closed. When a channel's last listener
/// leaves a socket that stays open for other channels, the pool sends `{"action":"unsubscribe","channel":…}`, unless
/// the server already ended that subscription with an error frame.
class WebSocketSession {

    /// The keep-alive interval, 9 minutes, as the web client sends it. API Gateway closes a socket after 10 minutes
    /// with no traffic.
    static let keepAliveInterval: UInt64 = 9 * 60 * 1_000_000_000

    /// The realtime `URLSession`'s `timeoutIntervalForRequest`: 10 minutes, longer than the keep-alive ping. On
    /// macOS, neither this nor the handshake timeout drops an open socket that is idle, so this is a defensive
    /// setting: no timeout shorter than the ping should be able to apply to a subscribed socket.
    static let requestTimeout: TimeInterval = 10 * 60

    /// The handshake `URLRequest`'s `timeoutInterval`, which bounds how long opening a socket can take. A request's
    /// own timeout overrides the session's, so a server that never completes the handshake fails after this rather
    /// than after ``requestTimeout``. It is not 60 seconds because `URLRequest` treats exactly 60, its default, as
    /// unset, and the session's 10 minutes would apply instead.
    static let handshakeTimeout: TimeInterval = 30

    /// The keep-alive frame. The server's subscription re-check runs only on this JSON message, so a protocol-level
    /// WebSocket ping does not replace it.
    static let pingFrame = #"{"action":"ping"}"#

    // MARK: - ConnectionEntry

    private final class ConnectionEntry {
        let socket: RealtimeSocket
        private var listeners: [RealtimeSocketListener] = []
        private var isOpen = false
        private let lock = NSLock()
        /// Every outgoing frame for the socket, in the order it must reach the server. One writer drains it, so an
        /// unsubscribe queued before a subscribe for the same channel is always sent first.
        private let outbox: AsyncStream<String>.Continuation
        private let writer: Task<Void, Never>
        var receiveLoop: Task<Void, Never>?
        var keepAlive: Task<Void, Never>?

        init(socket: RealtimeSocket) {
            self.socket = socket
            var continuation: AsyncStream<String>.Continuation!
            let frames = AsyncStream<String> { continuation = $0 }
            self.outbox = continuation
            self.writer = Task {
                for await frame in frames {
                    do {
                        try await socket.send(frame)
                    } catch {
                        // A failed send means the socket is going away; the receive loop reports it.
                        logger.debug("Realtime send failed: \(error.localizedDescription)")
                    }
                }
            }
        }

        /// Queues a frame. Frames queued after `stop` are dropped.
        func enqueue(_ frame: String) {
            outbox.yield(frame)
        }

        /// Adds `listener`, and queues its subscribe if the socket is already open.
        func add(_ listener: RealtimeSocketListener) {
            lock.lock()
            defer { lock.unlock() }
            listeners.append(listener)
            if isOpen {
                enqueue(listener.subscribeFrame)
            }
        }

        /// Removes `listener`. Returns nil if it wasn't present, otherwise whether no listeners remain. When others
        /// remain, queues an unsubscribe for its channel if the socket is open, no remaining listener has the
        /// channel, and the server hasn't already ended the subscription.
        ///
        /// Queuing under the entry lock orders the unsubscribe against every subscribe queued by `add` and `markOpen`.
        func remove(_ listener: RealtimeSocketListener) -> Bool? {
            lock.lock()
            defer { lock.unlock() }
            let before = listeners.count
            listeners.removeAll { $0 === listener }
            guard listeners.count != before else { return nil }
            if listeners.isEmpty { return true }
            if isOpen, listener.unsubscribesOnLeave, !listeners.contains(where: { $0.channel == listener.channel }) {
                enqueue(WebSocketSession.unsubscribeFrame(channel: listener.channel))
            }
            return false
        }

        /// Marks the socket open and queues a subscribe for every listener.
        func markOpen() {
            lock.lock()
            defer { lock.unlock() }
            isOpen = true
            for listener in listeners {
                enqueue(listener.subscribeFrame)
            }
        }

        var snapshot: [RealtimeSocketListener] {
            lock.lock()
            defer { lock.unlock() }
            return listeners
        }

        /// Stops the keep-alive and the writer and closes the socket. Called once the socket has left the pool.
        func stop(reason: String) {
            receiveLoop?.cancel()
            stopSending()
            socket.cancel(reason: reason)
        }

        /// Stops the keep-alive and the writer. Frames still queued are dropped.
        func stopSending() {
            keepAlive?.cancel()
            outbox.finish()
            writer.cancel()
        }
    }

    // MARK: - Properties

    private var connections: [String: ConnectionEntry] = [:]
    private let lock = NSLock()
    private let makeSocket: (URLRequest) -> RealtimeSocket
    private let sleep: @Sendable (UInt64) async throws -> Void

    /// - Parameters:
    ///   - session: The `URLSession` that opens sockets.
    convenience init(session: URLSession = BlocksRuntimeSession.realtime) {
        self.init(
            makeSocket: { URLSessionRealtimeSocket(task: session.webSocketTask(with: $0)) },
            sleep: { try await Task.sleep(nanoseconds: $0) }
        )
    }

    /// - Parameters:
    ///   - makeSocket: Opens a socket for a handshake request. Tests pass a fake.
    ///   - sleep: Waits for a number of nanoseconds and throws when cancelled. Tests pass a manual clock.
    init(
        makeSocket: @escaping (URLRequest) -> RealtimeSocket,
        sleep: @escaping @Sendable (UInt64) async throws -> Void
    ) {
        self.makeSocket = makeSocket
        self.sleep = sleep
    }

    // MARK: - Receive loop and keep-alive

    private func start(_ entry: ConnectionEntry, key: String) {
        let sleep = sleep
        entry.receiveLoop = Task { [weak self] in
            let socket = entry.socket
            entry.markOpen()

            while !Task.isCancelled {
                do {
                    guard let text = try await socket.receive() else { continue }
                    let endsSocket = RealtimeFrame.isConnectionError(text)
                    if endsSocket {
                        // Drop it before telling listeners, so a subscribe made in response opens a new socket.
                        self?.drop(entry, key: key, reason: "Server reported a connection error")
                    }
                    for listener in entry.snapshot {
                        listener.onMessage(text)
                    }
                    if endsSocket { return }
                } catch {
                    if Task.isCancelled { return }
                    // Drop the dead socket before telling listeners, so a subscribe made in response opens a new one.
                    self?.drop(entry, key: key, reason: "Connection failed")
                    for listener in entry.snapshot {
                        listener.onFailure(error)
                    }
                    return
                }
            }
        }
        entry.keepAlive = Task {
            while true {
                do {
                    try await sleep(Self.keepAliveInterval)
                } catch {
                    return
                }
                if Task.isCancelled { return }
                entry.enqueue(Self.pingFrame)
            }
        }
    }

    /// Removes `entry` from the pool if it is still the pooled socket for `key`, and stops it.
    private func drop(_ entry: ConnectionEntry, key: String, reason: String) {
        lock.lock()
        if connections[key] === entry {
            connections.removeValue(forKey: key)
        }
        lock.unlock()
        entry.stopSending()
        entry.socket.cancel(reason: reason)
    }

    // MARK: - API

    /// Adds `listener` to the pooled socket for `wsUrl`, opening one if none is pooled.
    ///
    /// - Throws: `RealtimeError.connectionFailed` if `wsUrl` is not a URL.
    func acquire(wsUrl: String, listener: RealtimeSocketListener) throws {
        guard let url = URL(string: wsUrl) else {
            throw RealtimeError.connectionFailed("Invalid WebSocket URL: \(wsUrl)", nil)
        }

        let connectionKey = wsUrl
        lock.lock()
        if let existing = connections[connectionKey] {
            // Join under the pool lock, so a concurrent release can't close the socket between lookup and join.
            existing.add(listener)
            lock.unlock()
            return
        }

        // Set User-Agent on the handshake because caller-supplied sessions may omit it.
        var request = URLRequest(url: url, timeoutInterval: Self.handshakeTimeout)
        request.setValue(blocksUserAgentToken, forHTTPHeaderField: "User-Agent")
        let entry = ConnectionEntry(socket: makeSocket(request))
        entry.add(listener)
        connections[connectionKey] = entry
        lock.unlock()

        entry.socket.resume()
        start(entry, key: connectionKey)
    }

    /// Removes `listener` from the pooled socket it joined. Closes that socket, and stops its keep-alive, when no
    /// listeners remain. A listener whose socket was already dropped is a no-op.
    func release(wsUrl: String, listener: RealtimeSocketListener) {
        let connectionKey = wsUrl
        lock.lock()
        // `remove` queues the unsubscribe, if one is due, while the pool lock is held, so a subscribe that a later
        // `acquire` queues for the same channel always follows it on the socket.
        guard let entry = connections[connectionKey], let close = entry.remove(listener) else {
            lock.unlock()
            return
        }
        if close {
            connections.removeValue(forKey: connectionKey)
        }
        lock.unlock()
        if close {
            entry.stop(reason: "All channels released")
        }
    }

    /// The frame that ends a channel's subscription on a socket, as the web client sends it.
    static func unsubscribeFrame(channel: String) -> String {
        frame(["action": "unsubscribe", "channel": channel])
    }

    /// The frame that subscribes `channel` with its channel token, as the web client sends it.
    static func subscribeFrame(channel: String, token: String) -> String {
        frame(["action": "subscribe", "channel": channel, "token": token])
    }

    /// Encodes a client frame as JSON, so a `"` or `\` in a channel name or token is escaped. Keys are sorted, which
    /// matches the web client's order (`action`, `channel`, `token`).
    private static func frame(_ fields: [String: String]) -> String {
        // A dictionary of strings always serializes to UTF-8.
        guard let data = try? JSONSerialization.data(withJSONObject: fields, options: [.sortedKeys, .withoutEscapingSlashes]),
              let text = String(bytes: data, encoding: .utf8) else {
            return "{}"
        }
        return text
    }

    /// The number of pooled sockets. For tests.
    var connectionCount: Int {
        lock.lock()
        defer { lock.unlock() }
        return connections.count
    }
}
