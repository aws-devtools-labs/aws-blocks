//
// Copyright Amazon.com Inc. or its affiliates.
// All Rights Reserved.
//
// SPDX-License-Identifier: Apache-2.0
//

import Foundation

/// Session for direct-to-AWS transfers (presigned S3, WebSocket), carrying the
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
}
