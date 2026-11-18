//
// Copyright Amazon.com Inc. or its affiliates.
// All Rights Reserved.
//
// SPDX-License-Identifier: Apache-2.0
//

import Foundation

/// Launches an OAuth authorize URL in a browser and returns the redirect
/// callback URL containing the authorization code.
///
/// On iOS and macOS, ``WebAuthenticationSessionLauncher`` opens it in
/// `ASWebAuthenticationSession`. Apps that drive the browser themselves can
/// implement this with their own browser shim.
///
/// A launcher returns the first redirect to `callbackScheme`. When the user closes
/// the browser or backs out of sign-in without a redirect, it throws
/// ``OIDCError/cancelled``, so a caller can tell a dismissal from a failure. When
/// the calling task is cancelled, it closes what it opened and throws
/// `CancellationError`. For any other failure, it throws
/// ``OIDCError/callbackError(_:_:)`` with the original error as the cause:
/// `signIn` rethrows whatever a launcher throws.
public protocol BrowserLauncher: Sendable {
    func launch(authorizeURL: URL, callbackScheme: String) async throws -> URL
}
