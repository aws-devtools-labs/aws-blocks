//
// Copyright Amazon.com Inc. or its affiliates.
// All Rights Reserved.
//
// SPDX-License-Identifier: Apache-2.0
//

import Foundation

/// Errors specific to the realtime channel.
///
/// A stream from `RealtimeChannel.subscribe()` finishes normally only when the app cancels it or calls `close()`.
/// Every other end finishes it with one of these errors, or with the `DecodingError` of a message that didn't decode.
public enum RealtimeError: BlocksError {
    /// The channel is closed. A channel can close on its own when the server goes away or
    /// the connection drops, so this is a catchable error rather than a programming error.
    case channelClosed
    /// The channel's WebSocket connection couldn't open, failed, or was closed by the server or the gateway
    /// (API Gateway closes a socket after 10 minutes with no traffic, and after 2 hours in any case). Also thrown
    /// when the server sends an error frame that names no channel, which ends every subscription on the socket.
    /// The socket is gone; get the channel again and subscribe to the new handle.
    ///
    /// The underlying error is the platform error when the socket failed. It is `nil` when the server or the gateway
    /// closed the socket (the message carries the close code and reason) or sent an error frame with no channel (the
    /// message is the server's).
    case connectionFailed(String, Error?)
    /// The server ended this channel's subscription with an error frame: it refused the subscribe, or ended the
    /// subscription when it re-checked it on a keep-alive ping. The socket may still serve other channels.
    ///
    /// `code` is the server's string as sent, or `nil` when the frame has none. Known values:
    /// - `"token_expired"`: the channel token expired (it lasts about an hour). Call the API method that returned
    ///   the channel again and subscribe to the new handle. The SDK never repeats that call itself.
    /// - `"access_revoked"`, `"principal_mismatch"`: the user's access was revoked, or the token belongs to another
    ///   user. Don't retry as the same user.
    /// - `nil`: the server refused the subscribe, for example because the token is invalid.
    ///
    /// The server can add codes, so treat an unknown one like `nil`. `message` is the server's text as sent.
    /// `underlyingError` is reserved for a failure the SDK hits while renewing the subscription; it is `nil` today.
    case subscriptionEnded(channel: String, code: String?, message: String, underlyingError: Error?)

    public var message: String {
        switch self {
        case .channelClosed:
            return "RealtimeChannel has been closed"
        case .connectionFailed(let msg, _):
            return msg
        case .subscriptionEnded(_, _, let msg, _):
            return msg
        }
    }

    public var underlyingError: Error? {
        switch self {
        case .connectionFailed(_, let error): return error
        case .subscriptionEnded(_, _, _, let error): return error
        default: return nil
        }
    }
}
