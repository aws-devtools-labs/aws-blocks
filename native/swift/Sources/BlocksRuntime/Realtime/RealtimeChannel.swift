//
// Copyright Amazon.com Inc. or its affiliates.
// All Rights Reserved.
//
// SPDX-License-Identifier: Apache-2.0
//

import Foundation
import os

private let logger = Logger(subsystem: "com.aws.blocks.swift", category: "RealtimeChannel")

/// Shared state for all RealtimeChannel instances (avoids generic static property limitation).
private enum RealtimeChannelWebSocketSession {
    static let shared = WebSocketSession()
}

/// A live client-side object backed by a WebSocket connection that exposes
/// an `AsyncThrowingStream` for receiving typed messages on a channel.
///
/// Usage:
/// ```swift
/// let channel = RealtimeChannel<CursorPosition>(
///     channel: "cursors",
///     wsUrl: "wss://example.com/ws",
///     token: "auth-token",
///     deserializer: { data in
///         try JSONDecoder().decode(CursorPosition.self, from: data)
///     }
/// )
///
/// for try await position in channel.subscribe() {
///     print("Cursor: \(position)")
/// }
/// ```
public class RealtimeChannel<T> {

    private var webSocketSession: WebSocketSession { RealtimeChannelWebSocketSession.shared }

    /// The channel name to subscribe to.
    public let channel: String

    /// The WebSocket endpoint URL.
    public let wsUrl: String

    /// The authentication token.
    public let token: String

    /// Converts the raw JSON payload bytes from a WebSocket message into
    /// an instance of T. Receiving `Data` lets callers pass straight to
    /// `JSONDecoder` without a redundant `Data → String → Data` round trip.
    private let deserializer: (Data) throws -> T

    private var closed = false
    private let lock = NSLock()
    private var activeListeners: [ChannelWebSocketDelegate] = []

    /// Creates a RealtimeChannel.
    ///
    /// - Parameters:
    ///   - channel: The channel name to subscribe to.
    ///   - wsUrl: The WebSocket endpoint URL.
    ///   - token: The authentication token.
    ///   - deserializer: Function to convert raw payload bytes into instances of T.
    public init(
        channel: String,
        wsUrl: String,
        token: String,
        deserializer: @escaping (Data) throws -> T
    ) {
        self.channel = channel
        self.wsUrl = wsUrl
        self.token = token
        self.deserializer = deserializer
    }

    /// Hydrates a RealtimeChannel from a JSON descriptor.
    /// Applies localhost rewriting using the provided baseHost.
    ///
    /// Expected JSON shape:
    /// ```json
    /// { "channel": "...", "wsUrl": "wss://...", "token": "..." }
    /// ```
    ///
    /// - Parameters:
    ///   - json: Dictionary with `channel`, `wsUrl`, and `token` keys.
    ///   - baseHost: Host to replace `localhost` with (for device testing). Pass `nil` to skip.
    ///   - deserializer: Function to convert raw payload bytes into instances of T.
    public static func fromJSON(
        _ json: [String: Any],
        baseHost: String? = nil,
        deserializer: @escaping (Data) throws -> T
    ) -> RealtimeChannel<T> {
        guard let ch = json["channel"] as? String,
              var wsUrlStr = json["wsUrl"] as? String,
              let tok = json["token"] as? String else {
            fatalError("Invalid RealtimeChannel descriptor: missing channel, wsUrl, or token")
        }

        if let host = baseHost {
            wsUrlStr = wsUrlStr.replacingOccurrences(of: "://localhost", with: "://\(host)")
        }

        return RealtimeChannel(channel: ch, wsUrl: wsUrlStr, token: tok, deserializer: deserializer)
    }

    /// Returns an `AsyncThrowingStream` that emits typed messages received on this channel.
    ///
    /// Establishes a WebSocket connection, authenticates, and subscribes to
    /// messages on the configured channel.
    ///
    /// - Throws: `RealtimeError.channelClosed` if called after `close()`.
    public func subscribe() -> AsyncThrowingStream<T, Error> {
        lock.lock()
        if closed {
            lock.unlock()
            return AsyncThrowingStream { $0.finish(throwing: RealtimeError.channelClosed) }
        }
        lock.unlock()

        let channelName = channel
        let channelToken = token
        let deserializer = deserializer
        let webSocketSession = webSocketSession

        return AsyncThrowingStream { continuation in
            let listener = ChannelWebSocketDelegate(
                channelName: channelName,
                channelToken: channelToken,
                deserializer: deserializer,
                continuation: continuation
            )

            self.lock.lock()
            self.activeListeners.append(listener)
            self.lock.unlock()

            do {
                try webSocketSession.acquire(wsUrl: self.wsUrl, token: self.token, listener: listener)
            } catch {
                continuation.finish(throwing: error)
                return
            }

            continuation.onTermination = { @Sendable _ in
                self.lock.lock()
                self.activeListeners.removeAll { $0 === listener }
                self.lock.unlock()
                webSocketSession.release(wsUrl: self.wsUrl, token: self.token, listener: listener)
            }
        }
    }

    /// Terminates the WebSocket connection and completes all active streams.
    /// After calling close, `subscribe()` will return a stream that immediately throws.
    public func close() {
        lock.lock()
        closed = true
        let listeners = activeListeners
        activeListeners.removeAll()
        lock.unlock()

        for listener in listeners {
            webSocketSession.release(wsUrl: wsUrl, token: token, listener: listener)
        }
    }
}

// MARK: - ChannelWebSocketDelegate

/// Internal listener that bridges WebSocketSession events into an AsyncThrowingStream.
/// Uses closure-based type erasure instead of unsafeBitCast.
private class ChannelWebSocketDelegate: WebSocketDelegate {
    private let channelName: String
    private let channelToken: String
    private let onPayload: (Data) -> Void
    private let onError: (Error) -> Void
    private let onComplete: () -> Void

    init<T>(
        channelName: String,
        channelToken: String,
        deserializer: @escaping (Data) throws -> T,
        continuation: AsyncThrowingStream<T, Error>.Continuation
    ) {
        self.channelName = channelName
        self.channelToken = channelToken
        // Type-erase via closures — safe, no unsafeBitCast
        self.onPayload = { data in
            do {
                let message = try deserializer(data)
                continuation.yield(message)
            } catch {
                continuation.finish(throwing: error)
            }
        }
        self.onError = { error in
            continuation.finish(throwing: error)
        }
        self.onComplete = {
            continuation.finish()
        }
    }

    func onOpen(_ webSocket: URLSessionWebSocketTask) {
        let subscribeMsg = """
        {"action":"subscribe","channel":"\(channelName)","token":"\(channelToken)"}
        """
        logger.debug("WS opened, sending: \(subscribeMsg)")
        webSocket.send(.string(subscribeMsg)) { error in
            if let error {
                logger.error("Failed to send subscribe: \(error.localizedDescription)")
            }
        }
    }

    func onMessage(_ webSocket: URLSessionWebSocketTask, text: String) {
        logger.debug("WS message: \(text)")

        guard let data = text.data(using: .utf8),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            return
        }

        guard let type = json["type"] as? String, type == "message" else { return }
        guard let msgChannel = json["channel"] as? String, msgChannel == channelName else { return }
        guard let payload = json["payload"] else { return }

        do {
            let payloadData = try JSONSerialization.data(withJSONObject: payload)
            onPayload(payloadData)
        } catch {
            onError(error)
        }
    }

    func onFailure(_ webSocket: URLSessionWebSocketTask, error: Error) {
        logger.error("WS failure: \(error.localizedDescription)")
        onError(RealtimeError.websocket("WebSocket failure", error))
    }

    func onClosed(_ webSocket: URLSessionWebSocketTask, code: Int, reason: String) {
        logger.debug("WS closed: \(code) \(reason)")
        onComplete()
    }
}

