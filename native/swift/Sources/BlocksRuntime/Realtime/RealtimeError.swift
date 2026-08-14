//
// Copyright Amazon.com Inc. or its affiliates.
// All Rights Reserved.
//
// SPDX-License-Identifier: Apache-2.0
//

import Foundation

/// Errors specific to the realtime channel.
public enum RealtimeError: BlocksError {
    case channelClosed
    case websocket(String, Error?)

    public var message: String {
        switch self {
        case .channelClosed:
            return "RealtimeChannel has been closed"
        case .websocket(let msg, _):
            return msg
        }
    }

    public var underlyingError: Error? {
        switch self {
        case .websocket(_, let error): return error
        default: return nil
        }
    }
}
