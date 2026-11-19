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

/// Parsing of server WebSocket frames. Non-generic and internal so tests can
/// exercise it without a socket.
enum RealtimeFrame: Equatable {
    /// A `message` frame for the channel, with its payload bytes.
    case message(Data)
    /// An `error` frame for the channel (`channel` set) or for the whole socket (`channel` nil).
    case error(channel: String?, code: String?, message: String)

    /// Parses `text` as seen by a subscriber of `channel`. Returns nil for a frame the subscriber ignores: a control
    /// frame such as `subscribe_success`, a message or error frame for another channel, or non-JSON.
    static func parse(_ text: String, channel: String) -> RealtimeFrame? {
        guard let raw = text.data(using: .utf8),
              let json = try? JSONSerialization.jsonObject(with: raw) as? [String: Any],
              let type = json["type"] as? String else {
            return nil
        }
        let frameChannel = json["channel"] as? String
        switch type {
        case "message":
            guard frameChannel == channel, let data = payload(of: json) else { return nil }
            return .message(data)
        case "error":
            // An error frame with no string channel is about the socket, so every subscriber on it gets it.
            if let frameChannel, frameChannel != channel { return nil }
            let serverMessage = (json["message"] as? String).flatMap { $0.isEmpty ? nil : $0 }
            let fallback = frameChannel.map { "The server ended the subscription to \"\($0)\"" }
                ?? "The server reported a connection error"
            return .error(channel: frameChannel, code: json["code"] as? String, message: serverMessage ?? fallback)
        default:
            return nil
        }
    }

    /// True for an error frame that names no channel. It ends every subscription on the socket, so the pool drops
    /// the socket.
    static func isConnectionError(_ text: String) -> Bool {
        guard let raw = text.data(using: .utf8),
              let json = try? JSONSerialization.jsonObject(with: raw) as? [String: Any] else {
            return false
        }
        return json["type"] as? String == "error" && !(json["channel"] is String)
    }

    /// Returns the payload bytes of a `message` frame for `channel`, or nil for
    /// any other frame (control frames such as `subscribe_success`, a different
    /// channel, or non-JSON).
    ///
    /// The AWS server names the payload field `data`; the local mock names it
    /// `payload`. Read `data` first and fall back, as the Kotlin and Dart
    /// clients do. Reading only `payload` drops every message from AWS, which is
    /// why subscribe worked against the mock but not a deployed backend.
    static func payload(from text: String, channel: String) -> Data? {
        guard case .message(let data) = parse(text, channel: channel) else { return nil }
        return data
    }

    private static func payload(of json: [String: Any]) -> Data? {
        guard let payload = json["data"] ?? json["payload"] else { return nil }
        return try? JSONSerialization.data(withJSONObject: payload)
    }
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
///
/// A subscription can end while the app is still iterating: the channel token expires after about an hour, the
/// backend revokes the user's access, or the socket drops. Each of those finishes the stream with a
/// ``RealtimeError``. To keep receiving, call the API method that returned the channel again and subscribe to the
/// new handle:
///
/// ```swift
/// do {
///     for try await position in channel.subscribe() { draw(position) }
/// } catch RealtimeError.subscriptionEnded(_, "token_expired", _, _) {
///     let fresh = try await blocks.api.realtimeGetChannel(channel: "room-1")
///     // subscribe to `fresh`
/// } catch RealtimeError.connectionFailed {
///     // the socket dropped, for example while the app was in the background: get the channel again
/// }
/// ```
///
/// The SDK never repeats that call itself and does not reconnect on its own.
public final class RealtimeChannel<T> {

    private let webSocketSession: WebSocketSession

    /// The channel name to subscribe to.
    public let channel: String

    /// The WebSocket endpoint URL.
    public let wsUrl: String

    /// The authentication token.
    public let token: String

    /// Converts the raw JSON payload bytes from a WebSocket message into
    /// an instance of T. Receiving `Data` lets callers pass straight to
    /// `JSONDecoder` without a redundant `Data → String → Data` round trip.
    let deserializer: (Data) throws -> T

    private var closed = false
    private let lock = NSLock()
    private var activeListeners: [ChannelListener<T>] = []

    /// Runs in `subscribe()` after the listener is registered and before it joins the socket. For tests.
    var afterRegisteringListener: (() -> Void)?

    /// Creates a RealtimeChannel.
    ///
    /// - Parameters:
    ///   - channel: The channel name to subscribe to.
    ///   - wsUrl: The WebSocket endpoint URL.
    ///   - token: The authentication token.
    ///   - deserializer: Function to convert raw payload bytes into instances of T.
    public convenience init(
        channel: String,
        wsUrl: String,
        token: String,
        deserializer: @escaping (Data) throws -> T
    ) {
        self.init(
            channel: channel,
            wsUrl: wsUrl,
            token: token,
            webSocketSession: RealtimeChannelWebSocketSession.shared,
            deserializer: deserializer
        )
    }

    /// Creates a RealtimeChannel on a given socket pool. For tests.
    init(
        channel: String,
        wsUrl: String,
        token: String,
        webSocketSession: WebSocketSession,
        deserializer: @escaping (Data) throws -> T
    ) {
        self.channel = channel
        self.wsUrl = wsUrl
        self.token = token
        self.webSocketSession = webSocketSession
        self.deserializer = deserializer
    }

    /// Hydrates a RealtimeChannel from a JSON descriptor.
    /// Applies localhost rewriting using the provided baseHost.
    ///
    /// Expected JSON shape:
    /// ```json
    /// { "channel": "...", "wsUrl": "wss://...", "connectToken": "...", "token": "..." }
    /// ```
    ///
    /// The descriptor carries two credentials. They are not interchangeable.
    /// `connectToken` authenticates the handshake. It goes on `wsUrl` as a
    /// `token` query parameter, because API Gateway `$connect` reads
    /// `queryStringParameters.token`. It is optional. `token` authenticates the
    /// per-channel subscribe message and stays on the instance.
    ///
    /// - Parameters:
    ///   - json: Dictionary with `channel`, `wsUrl`, and `token` keys, plus an optional `connectToken`.
    ///   - baseHost: Host to replace `localhost` with (for device testing). Pass `nil` to skip.
    ///   - deserializer: Function to convert raw payload bytes into instances of T.
    public static func fromJSON(
        _ json: [String: Any],
        baseHost: String? = nil,
        deserializer: @escaping (Data) throws -> T
    ) -> RealtimeChannel<T> {
        guard let channelName = json["channel"] as? String,
              let wsUrlStr = json["wsUrl"] as? String,
              let tokenValue = json["token"] as? String else {
            fatalError("Invalid RealtimeChannel descriptor: missing channel, wsUrl, or token")
        }

        let connectToken = json["connectToken"] as? String
        return RealtimeChannel(
            channel: channelName,
            wsUrl: resolvedWsUrl(wsUrlStr, connectToken: connectToken, baseHost: baseHost),
            token: tokenValue,
            deserializer: deserializer
        )
    }

    /// The URL to connect to: `wsUrl` with `localhost` rewritten to `baseHost`, then a non-empty `connectToken`
    /// appended as the `token` query parameter.
    private static func resolvedWsUrl(_ wsUrl: String, connectToken: String?, baseHost: String?) -> String {
        var wsUrlStr = wsUrl
        if let host = baseHost {
            wsUrlStr = wsUrlStr.replacingOccurrences(of: "://localhost", with: "://\(host)")
        }

        if let connectToken, !connectToken.isEmpty {
            wsUrlStr = Self.appendingConnectToken(to: wsUrlStr, connectToken)
        }
        return wsUrlStr
    }

    private enum DescriptorKeys: String, CodingKey {
        case blocksType = "__blocks"
        case channel
        case wsUrl
        case connectToken
        case token
    }

    /// Decodes a channel from its `{ "__blocks": "realtime/channel", … }` descriptor, the same way
    /// ``fromJSON(_:baseHost:deserializer:)`` hydrates it with ``BlocksClient/baseHost``. This lets a generated
    /// model hold a channel in a field, an array, a dictionary or an optional.
    ///
    /// Messages decode with a `JSONDecoder` that carries this decoder's `userInfo`. Unlike `fromJSON`, a malformed
    /// descriptor throws a `DecodingError` rather than trapping. That decoder reads dates the way
    /// ``BlocksClient/makeDecoder()`` does (ISO 8601 strings).
    public required convenience init(from decoder: Decoder) throws where T: Decodable {
        let container = try decoder.container(keyedBy: DescriptorKeys.self)
        try TransferableDescriptor.check(container, key: .blocksType, expected: "realtime/channel")
        let wsUrl = try container.decode(String.self, forKey: .wsUrl)
        let connectToken = try container.decodeIfPresent(String.self, forKey: .connectToken)
        let userInfo = decoder.userInfo
        self.init(
            channel: try container.decode(String.self, forKey: .channel),
            wsUrl: Self.resolvedWsUrl(wsUrl, connectToken: connectToken, baseHost: BlocksClient.baseHost),
            token: try container.decode(String.self, forKey: .token)
        ) { data in
            let messageDecoder = BlocksJSONCoding.makeDecoder()
            messageDecoder.userInfo = userInfo
            return try messageDecoder.decode(T.self, from: data)
        }
    }

    /// Always throws `EncodingError.invalidValue`: transferables are read-only. The conformance exists so a
    /// generated `Codable` model that holds a channel compiles.
    public func encode(to encoder: Encoder) throws {
        throw TransferableDescriptor.readOnly(self, tag: "realtime/channel", encoder: encoder)
    }

    /// Appends `connectToken` to `wsUrl` as a `token` query parameter. Keeps any
    /// existing query parameters. Returns `wsUrl` unchanged if it does not parse,
    /// so a bad URL fails at connect time with the URL in the error.
    private static func appendingConnectToken(to wsUrl: String, _ connectToken: String) -> String {
        guard var components = URLComponents(string: wsUrl) else { return wsUrl }
        components.queryItems = (components.queryItems ?? []) + [URLQueryItem(name: "token", value: connectToken)]
        return components.string ?? wsUrl
    }

    /// Returns an `AsyncThrowingStream` that emits typed messages received on this channel.
    ///
    /// Establishes a WebSocket connection, authenticates, and subscribes to
    /// messages on the configured channel. It returns at once and does not wait for the server to confirm the
    /// subscription, so a message published before the server confirms can be missed. A refused subscribe finishes
    /// the stream with `RealtimeError.subscriptionEnded`.
    ///
    /// Subscriptions on the same `wsUrl` share one WebSocket, whatever their channel. When a channel's last
    /// subscription on that socket ends and other channels keep it open, the SDK sends an unsubscribe for the
    /// channel.
    ///
    /// While it has a subscriber, the SDK sends the keep-alive `{"action":"ping"}` every 9 minutes, as the web
    /// client does. The server re-checks each subscription on that ping, and that is how an expired or revoked one is
    /// reported.
    ///
    /// The stream finishes normally only when the app cancels its iteration or calls ``close()``. Otherwise it
    /// finishes throwing:
    /// - `RealtimeError.subscriptionEnded` when the server ends this channel's subscription, with the server's
    ///   `code` (`"token_expired"`, `"access_revoked"`, `"principal_mismatch"`, or `nil` for a refused subscribe);
    /// - `RealtimeError.connectionFailed` when the socket can't open, fails, or is closed by the server or the
    ///   gateway, or when the server sends an error frame that names no channel;
    /// - the deserializer's error, usually a `DecodingError`, when a message doesn't decode;
    /// - `RealtimeError.channelClosed` if called after `close()`.
    public func subscribe() -> AsyncThrowingStream<T, Error> {
        lock.lock()
        if closed {
            lock.unlock()
            return AsyncThrowingStream { $0.finish(throwing: RealtimeError.channelClosed) }
        }
        lock.unlock()

        let channelName = channel
        let channelToken = token
        let wsUrl = wsUrl
        let deserializer = deserializer
        let webSocketSession = webSocketSession

        return AsyncThrowingStream { continuation in
            let listener = ChannelListener(
                channelName: channelName,
                channelToken: channelToken,
                deserializer: deserializer,
                continuation: continuation
            )

            // Set before the listener is registered, so `close()` can't finish the stream before the handler exists.
            // A handler set after the stream finished doesn't run when it finishes.
            continuation.onTermination = { @Sendable _ in
                listener.markTerminated()
                self.lock.lock()
                self.activeListeners.removeAll { $0 === listener }
                self.lock.unlock()
                webSocketSession.release(wsUrl: wsUrl, listener: listener)
            }

            self.lock.lock()
            if self.closed {
                self.lock.unlock()
                continuation.finish(throwing: RealtimeError.channelClosed)
                return
            }
            self.activeListeners.append(listener)
            self.lock.unlock()
            self.afterRegisteringListener?()

            do {
                try webSocketSession.acquire(wsUrl: wsUrl, listener: listener)
            } catch {
                continuation.finish(throwing: error)
                return
            }
            // A stream that ended before acquire released a listener that hadn't joined yet. Release it now.
            if listener.isTerminated {
                webSocketSession.release(wsUrl: wsUrl, listener: listener)
            }
        }
    }

    /// Terminates the WebSocket connection and completes all active streams.
    /// Each active stream finishes normally, without an error.
    /// After calling close, `subscribe()` will return a stream that immediately throws.
    public func close() {
        lock.lock()
        closed = true
        let listeners = activeListeners
        activeListeners.removeAll()
        lock.unlock()

        // Finishing a stream runs its onTermination, which releases the listener from the pool and closes the socket
        // when it was the last one.
        for listener in listeners {
            listener.finish()
        }
    }
}

extension RealtimeChannel: Encodable {}

extension RealtimeChannel: Decodable where T: Decodable {}

// MARK: - ChannelListener

/// Bridges one pooled socket's events into one subscriber's `AsyncThrowingStream`.
private final class ChannelListener<T>: RealtimeSocketListener {
    private let channelName: String
    private let lock = NSLock()
    private var serverEnded = false
    private var terminated = false
    private let channelToken: String
    private let deserializer: (Data) throws -> T
    private let continuation: AsyncThrowingStream<T, Error>.Continuation

    init(
        channelName: String,
        channelToken: String,
        deserializer: @escaping (Data) throws -> T,
        continuation: AsyncThrowingStream<T, Error>.Continuation
    ) {
        self.channelName = channelName
        self.channelToken = channelToken
        self.deserializer = deserializer
        self.continuation = continuation
    }

    var channel: String { channelName }

    var unsubscribesOnLeave: Bool {
        lock.lock()
        defer { lock.unlock() }
        return !serverEnded
    }

    /// Whether the stream has ended and its termination handler ran.
    var isTerminated: Bool {
        lock.lock()
        defer { lock.unlock() }
        return terminated
    }

    /// Records that the stream ended. Called by the termination handler before it releases the listener.
    func markTerminated() {
        lock.lock()
        terminated = true
        lock.unlock()
    }

    /// Ends the stream normally. Used by `RealtimeChannel.close()`.
    func finish() {
        continuation.finish()
    }

    var subscribeFrame: String {
        WebSocketSession.subscribeFrame(channel: channelName, token: channelToken)
    }

    func onMessage(_ text: String) {
        // Message bodies are application data; log their size, not their content.
        logger.debug("WS message: \(text.utf8.count) bytes")
        switch RealtimeFrame.parse(text, channel: channelName) {
        case .message(let data):
            do {
                continuation.yield(try deserializer(data))
            } catch {
                continuation.finish(throwing: error)
            }
        case .error(let channel?, let code, let message):
            logger.debug("Subscription to \(channel) ended: \(code ?? "no code")")
            // The server removed the subscription, so leaving the socket sends no unsubscribe.
            lock.lock()
            serverEnded = true
            lock.unlock()
            continuation.finish(throwing: RealtimeError.subscriptionEnded(
                channel: channel,
                code: code,
                message: message,
                underlyingError: nil
            ))
        case .error(nil, _, let message):
            logger.error("Realtime server error: \(message)")
            continuation.finish(throwing: RealtimeError.connectionFailed(message, nil))
        case nil:
            break
        }
    }

    func onFailure(_ error: Error) {
        if let closed = error as? RealtimeSocketClosed {
            let message = closed.reason.isEmpty
                ? "The server closed the WebSocket (code \(closed.code))"
                : "The server closed the WebSocket (code \(closed.code), reason \"\(closed.reason)\")"
            logger.debug("\(message)")
            continuation.finish(throwing: RealtimeError.connectionFailed(message, nil))
            return
        }
        logger.error("WS failure: \(error.localizedDescription)")
        continuation.finish(throwing: RealtimeError.connectionFailed("WebSocket failure", error))
    }
}
