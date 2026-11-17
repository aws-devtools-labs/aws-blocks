// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/// Utility for resolving localhost URLs on different platforms.
class BlocksConfig {
  /// Rewrites localhost URLs to use the given [host].
  ///
  /// Useful for Android emulators where localhost maps to the emulator
  /// itself — pass '10.0.2.2' to reach the host machine.
  static String rewriteLocalhost(String url, {String host = 'localhost'}) {
    return url.replaceAll('://localhost', '://$host');
  }
}
