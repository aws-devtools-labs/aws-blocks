// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/// Interface for launching OAuth authorize URLs in a browser.
///
/// Platform implementations (e.g. Flutter) provide concrete launchers
/// that open the system browser and capture the redirect callback.
abstract class BrowserLauncher {
  /// Opens [authorizeUrl] in the system browser and returns the redirect URI
  /// containing the authorization code.
  Future<Uri> launch(Uri authorizeUrl, {required String callbackScheme});
}
