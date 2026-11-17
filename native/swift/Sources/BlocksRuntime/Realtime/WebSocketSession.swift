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
    /// The socket is open, or was already open when the listener joined. Send the subscribe frame here.
    func onOpen(_ socket: RealtimeSocket)
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
/// subscription on it. When the last listener is released, the socket is closed. No `unsubscribe` frame is sent.
class WebSocketSession {

    /// The keep-alive interval, 9 minutes, as the web client sends it. API Gateway closes a socket after 10 minutes
    /// with no traffic.
    static let keepAliveInterval: UInt64 = 9 * 60 * 1_000_000_000

    /// The keep-alive frame. The server's subscription re-check runs only on this JSON message, so a protocol-level
    /// WebSocket ping does not replace it.
    static let pingFrame = #"{"action":"ping"}"#

    // MARK: - ConnectionEntry

    private final class ConnectionEntry {
        let socket: RealtimeSocket
        private var listeners: [RealtimeSocketListener] = []
        private var isOpen = false
        private let lock = NSLock()
        var receiveLoop: Task<Void, Never>?
        var keepAlive: Task<Void, Never>?

        init(socket: RealtimeSocket) {
            self.socket = socket
        }

        /// Adds `listener` and returns whether the socket is already open, in which case the caller calls `onOpen`.
        func add(_ listener: RealtimeSocketListener) -> Bool {
            lock.lock()
            defer { lock.unlock() }
            listeners.append(listener)
            return isOpen
        }

        /// Removes `listener` and returns whether it was present.
        func remove(_ listener: RealtimeSocketListener) -> Bool {
            lock.lock()
            defer { lock.unlock() }
            let before = listeners.count
            listeners.removeAll { $0 === listener }
            return listeners.count != before
        }

        var isEmpty: Bool {
            lock.lock()
            defer { lock.unlock() }
            return listeners.isEmpty
        }

        /// Marks the socket open and returns the listeners to notify.
        func markOpen() -> [RealtimeSocketListener] {
            lock.lock()
            defer { lock.unlock() }
            isOpen = true
            return listeners
        }

        var snapshot: [RealtimeSocketListener] {
            lock.lock()
            defer { lock.unlock() }
            return listeners
        }

        func stop(reason: String) {
            receiveLoop?.cancel()
            keepAlive?.cancel()
            socket.cancel(reason: reason)
        }
    }

    // MARK: - Properties

    private var connections: [String: ConnectionEntry] = [:]
    private let lock = NSLock()
    private let makeSocket: (URLRequest) -> RealtimeSocket
    private let sleep: @Sendable (UInt64) async throws -> Void

    /// - Parameters:
    ///   - session: The `URLSession` that opens sockets.
    convenience init(session: URLSession = BlocksRuntimeSession.shared) {
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
            for listener in entry.markOpen() {
                listener.onOpen(socket)
            }

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
            let socket = entry.socket
            while true {
                do {
                    try await sleep(Self.keepAliveInterval)
                } catch {
                    return
                }
                if Task.isCancelled { return }
                do {
                    try await socket.send(Self.pingFrame)
                } catch {
                    // A failed send means the socket is going away; the receive loop reports it.
                    logger.debug("Keep-alive ping failed: \(error.localizedDescription)")
                }
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
        entry.keepAlive?.cancel()
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
            let open = existing.add(listener)
            lock.unlock()
            if open {
                listener.onOpen(existing.socket)
            }
            return
        }

        // Set User-Agent on the handshake because caller-supplied sessions may omit it.
        var request = URLRequest(url: url)
        request.setValue(blocksUserAgentToken, forHTTPHeaderField: "User-Agent")
        let entry = ConnectionEntry(socket: makeSocket(request))
        _ = entry.add(listener)
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
        guard let entry = connections[connectionKey], entry.remove(listener) else {
            lock.unlock()
            return
        }
        let close = entry.isEmpty
        if close {
            connections.removeValue(forKey: connectionKey)
        }
        lock.unlock()
        if close {
            entry.stop(reason: "All channels released")
        }
    }

    /// The number of pooled sockets. For tests.
    var connectionCount: Int {
        lock.lock()
        defer { lock.unlock() }
        return connections.count
    }
}
