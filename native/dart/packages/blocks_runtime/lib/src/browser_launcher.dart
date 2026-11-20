// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import 'oidc_exception.dart';

/// Interface for launching OAuth authorize URLs in a browser.
///
/// Platform implementations (e.g. Flutter) provide concrete launchers
/// that open the system browser and capture the redirect callback.
abstract class BrowserLauncher {
  /// Opens [authorizeUrl] in the system browser and returns the redirect URI
  /// containing the authorization code.
  ///
  /// A launch that ends without a redirect throws [OidcCancelledException]:
  /// when the user closes the browser or dismisses the sign-in, when the
  /// launcher's own timeout passes, or when [cancel] completes first. Its
  /// message says which. A launcher stops waiting for the redirect once it
  /// throws, so a redirect that arrives later is ignored.
  ///
  /// [cancel] is the caller's `cancel` future from `OidcClient.signIn` or
  /// `OidcClient.signInDirect`, or null when the caller passed none. The client
  /// stops waiting and throws [OidcCancelledException] when it completes, even
  /// if the launcher keeps waiting, so a launcher only has to release what it
  /// holds, such as a stream subscription.
  Future<Uri> launch(
    Uri authorizeUrl, {
    required String callbackScheme,
    Future<void>? cancel,
  });
}
