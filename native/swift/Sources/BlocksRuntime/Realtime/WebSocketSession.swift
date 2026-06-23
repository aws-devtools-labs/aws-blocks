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
public class WebSocketConnection {
    public let task: URLSessionWebSocketTask
    public let key: String

    init(task: URLSessionWebSocketTask, key: String) {
        self.task = task
        self.key = key
    }
}

/// Callback interface for WebSocket events.
public protocol WebSocketDelegate: AnyObject {
    func onOpen(_ webSocket: URLSessionWebSocketTask)
    func onMessage(_ webSocket: URLSessionWebSocketTask, text: String)
    func onFailure(_ webSocket: URLSessionWebSocketTask, error: Error)
    func onClosed(_ webSocket: URLSessionWebSocketTask, code: Int, reason: String)
}

/// Reference-counted session that shares a single WebSocket connection
/// per unique `wsUrl+token` combination, dispatching events to all
/// registered delegates.
///
/// When the last delegate is removed, the underlying WebSocket is closed.
class WebSocketSession {

    // MARK: - DispatchingListener

    private class DispatchingListener {
        private var listeners: [WebSocketDelegate] = []
        private var openWebSocket: URLSessionWebSocketTask?
        private let lock = NSLock()

        func add(_ listener: WebSocketDelegate) {
            lock.lock()
            listeners.append(listener)
            let ws = openWebSocket
            lock.unlock()

            if let ws {
                listener.onOpen(ws)
            }
        }

        func remove(_ listener: WebSocketDelegate) {
            lock.lock()
            listeners.removeAll { $0 === listener }
            lock.unlock()
        }

        func listenerCount() -> Int {
            lock.lock()
            defer { lock.unlock() }
            return listeners.count
        }

        func dispatchOpen(_ webSocket: URLSessionWebSocketTask) {
            lock.lock()
            openWebSocket = webSocket
            let snapshot = listeners
            lock.unlock()
            for l in snapshot {
                l.onOpen(webSocket)
            }
        }

        func dispatchMessage(_ webSocket: URLSessionWebSocketTask, text: String) {
            lock.lock()
            let snapshot = listeners
            lock.unlock()
            for l in snapshot {
                l.onMessage(webSocket, text: text)
            }
        }

        func dispatchFailure(_ webSocket: URLSessionWebSocketTask, error: Error) {
            lock.lock()
            let snapshot = listeners
            lock.unlock()
            for l in snapshot {
                l.onFailure(webSocket, error: error)
            }
        }

        func dispatchClosed(_ webSocket: URLSessionWebSocketTask, code: Int, reason: String) {
            lock.lock()
            openWebSocket = nil
            let snapshot = listeners
            lock.unlock()
            for l in snapshot {
                l.onClosed(webSocket, code: code, reason: reason)
            }
        }
    }

    // MARK: - ConnectionEntry

    private class ConnectionEntry {
        let task: URLSessionWebSocketTask
        let dispatcher: DispatchingListener
        var receiveLoop: Task<Void, Never>?

        init(task: URLSessionWebSocketTask, dispatcher: DispatchingListener) {
            self.task = task
            self.dispatcher = dispatcher
        }
    }

    // MARK: - Properties

    private var connections: [String: ConnectionEntry] = [:]
    private let lock = NSLock()
    private let session: URLSession

    init(session: URLSession = .shared) {
        self.session = session
    }

    private func key(_ wsUrl: String, _ token: String) -> String {
        "\(wsUrl)|\(token)"
    }

    // MARK: - Receive loop

    private func startReceiveLoop(entry: ConnectionEntry) {
        entry.receiveLoop = Task {
            let ws = entry.task

            // Notify delegates that connection is open
            entry.dispatcher.dispatchOpen(ws)

            while !Task.isCancelled {
                do {
                    let message = try await ws.receive()
                    switch message {
                    case .string(let text):
                        entry.dispatcher.dispatchMessage(ws, text: text)
                    case .data(let data):
                        if let text = String(data: data, encoding: .utf8) {
                            entry.dispatcher.dispatchMessage(ws, text: text)
                        }
                    @unknown default:
                        break
                    }
                } catch {
                    if !Task.isCancelled {
                        entry.dispatcher.dispatchFailure(ws, error: error)
                    }
                    break
                }
            }
        }
    }

    // MARK: - Public API

    /// Acquires a shared WebSocket connection for the given endpoint and token.
    /// If a connection already exists, adds the delegate to receive dispatched events.
    /// Otherwise, creates a new WebSocket connection.
    @discardableResult
    func acquire(wsUrl: String, token: String, listener: WebSocketDelegate) throws -> WebSocketConnection {
        guard let url = URL(string: wsUrl) else {
            throw RealtimeError.websocket("Invalid WebSocket URL: \(wsUrl)", nil)
        }

        lock.lock()
        let k = key(wsUrl, token)

        if let existing = connections[k] {
            existing.dispatcher.add(listener)
            lock.unlock()
            return WebSocketConnection(task: existing.task, key: k)
        }

        let dispatcher = DispatchingListener()
        dispatcher.add(listener)

        let wsTask = session.webSocketTask(with: url)
        let entry = ConnectionEntry(task: wsTask, dispatcher: dispatcher)
        connections[k] = entry
        lock.unlock()

        wsTask.resume()
        startReceiveLoop(entry: entry)

        return WebSocketConnection(task: wsTask, key: k)
    }

    /// Removes a delegate from the connection identified by the given endpoint and token.
    /// Closes the WebSocket when no delegates remain.
    func release(wsUrl: String, token: String, listener: WebSocketDelegate) {
        lock.lock()
        let k = key(wsUrl, token)
        guard let entry = connections[k] else {
            lock.unlock()
            return
        }
        entry.dispatcher.remove(listener)
        if entry.dispatcher.listenerCount() <= 0 {
            entry.receiveLoop?.cancel()
            entry.task.cancel(with: .normalClosure, reason: "All channels released".data(using: .utf8))
            connections.removeValue(forKey: k)
        }
        lock.unlock()
    }
}
