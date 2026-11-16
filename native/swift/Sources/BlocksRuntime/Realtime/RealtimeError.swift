//
// Copyright Amazon.com Inc. or its affiliates.
// All Rights Reserved.
//
// SPDX-License-Identifier: Apache-2.0
//

import Foundation

/// Errors specific to the realtime channel.
public enum RealtimeError: BlocksError {
    /// The channel is closed. A channel can close on its own when the server goes away or
    /// the connection drops, so this is a catchable error rather than a programming error.
    case channelClosed
    /// The channel's WebSocket connection failed.
    case connectionFailed(String, Error?)

    public var message: String {
        switch self {
        case .channelClosed:
            return "RealtimeChannel has been closed"
        case .connectionFailed(let msg, _):
            return msg
        }
    }

    public var underlyingError: Error? {
        switch self {
        case .connectionFailed(_, let error): return error
        default: return nil
        }
    }
}
