//
// Copyright Amazon.com Inc. or its affiliates.
// All Rights Reserved.
//
// SPDX-License-Identifier: Apache-2.0
//

import Foundation

/// Launches an OAuth authorize URL in the system browser and returns the
/// redirect callback URL containing the authorization code.
///
/// On iOS / macOS the typical implementation wraps `ASWebAuthenticationSession`.
/// Apps that drive the browser themselves (e.g. server-rendered hosting) can
/// implement this with their own browser shim.
public protocol BrowserLauncher: Sendable {
    func launch(authorizeURL: URL, callbackScheme: String) async throws -> URL
}
