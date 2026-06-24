//
// Copyright Amazon.com Inc. or its affiliates.
// All Rights Reserved.
//
// SPDX-License-Identifier: Apache-2.0
//

import Foundation

/// Supplies bearer-token authentication for `BlocksClient`.
public protocol AuthProvider: AnyObject, Sendable {
    /// Returns the current access token, or `nil` if not authenticated.
    func getAccessToken() async -> String?

    /// Invoked on a 401 response — should attempt to refresh tokens.
    func onAuthFailure() async
}
