//
// Copyright Amazon.com Inc. or its affiliates.
// All Rights Reserved.
//
// SPDX-License-Identifier: Apache-2.0
//

import Foundation

/// Sessions for direct-to-AWS transfers (`shared` for presigned S3, `realtime` for WebSockets), carrying the
/// User-Agent without mutating the host-shared `URLSession.shared`.
enum BlocksRuntimeSession {
    static let shared: URLSession = {
        let config = URLSessionConfiguration.ephemeral
        config.httpCookieAcceptPolicy = .never
        config.httpShouldSetCookies = false
        config.httpCookieStorage = nil
        config.httpAdditionalHeaders = ["User-Agent": blocksUserAgentToken]
        return URLSession(configuration: config)
    }()

    /// Session for realtime WebSockets: `shared`'s settings, with a request timeout longer than the 9-minute
    /// keep-alive ping, so the 60-second default can't apply to a subscribed socket. The handshake request doesn't
    /// set a timeout of its own, since that would replace this one for the socket's whole life. The pool bounds the
    /// handshake with its own deadline (`WebSocketSession.handshakeTimeout`).
    static let realtime: URLSession = {
        let config = URLSessionConfiguration.ephemeral
        config.httpCookieAcceptPolicy = .never
        config.httpShouldSetCookies = false
        config.httpCookieStorage = nil
        config.httpAdditionalHeaders = ["User-Agent": blocksUserAgentToken]
        config.timeoutIntervalForRequest = WebSocketSession.requestTimeout
        return URLSession(configuration: config)
    }()
}
