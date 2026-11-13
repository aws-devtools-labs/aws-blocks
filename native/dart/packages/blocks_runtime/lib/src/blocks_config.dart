/// @docImport 'blocks_client.dart';
library;

import 'timeout_client.dart';

/// Configuration for one [BlocksClient], and for the generated `Blocks` that
/// runs on one: long-lived, and usually the same for every client in a
/// process.
///
/// Vary one value across environments with [copyWith]:
///
/// ```dart
/// const base = BlocksConfig(baseUrl: 'https://api.example.com/aws-blocks/api');
/// final staging = base.copyWith(
///   baseUrl: 'https://staging.example.com/aws-blocks/api',
/// );
/// final blocks = Blocks.fromConfig(staging);
/// ```
///
/// It holds values only. The session store, token store and HTTP client a
/// client uses have state of their own, so they stay arguments of the
/// constructor that takes the config.
///
/// The class is `final`, so it can't be implemented or extended outside this
/// package. That lets a later release add a value without breaking anyone.
final class BlocksConfig {
  /// The URL the client sends its calls under, the same value as
  /// [BlocksClient.baseUrl].
  final String baseUrl;

  /// How long to wait for a connection to the server before the call fails.
  ///
  /// It governs RPC calls only; file transfers and the auth routes keep the
  /// runtime's defaults. It applies only to the default `dart:io` client; on
  /// a client that sends the request body in one piece, such as the browser,
  /// the runtime cannot see the connection, so only [idleTimeout] applies.
  final Duration connectTimeout;

  /// How long a call may go with nothing arriving, neither the response's
  /// headers nor the next chunk of its body, before it fails. This is not a
  /// cap on the whole call: a slow response that keeps arriving is never cut
  /// off.
  ///
  /// It governs RPC calls only; file transfers and the auth routes keep the
  /// runtime's defaults.
  final Duration idleTimeout;

  /// Creates a config for [baseUrl], with every other value at its default.
  const BlocksConfig({
    required this.baseUrl,
    this.connectTimeout = defaultConnectTimeout,
    this.idleTimeout = defaultIdleTimeout,
  });

  /// A copy of this config with the given values replaced.
  BlocksConfig copyWith({
    String? baseUrl,
    Duration? connectTimeout,
    Duration? idleTimeout,
  }) => BlocksConfig(
    baseUrl: baseUrl ?? this.baseUrl,
    connectTimeout: connectTimeout ?? this.connectTimeout,
    idleTimeout: idleTimeout ?? this.idleTimeout,
  );

  /// Rewrites localhost URLs to use the given [host].
  ///
  /// Useful for Android emulators where localhost maps to the emulator
  /// itself — pass '10.0.2.2' to reach the host machine.
  @Deprecated(
    'Use rewriteLocalhost(url, host: ...) from package:blocks_runtime.',
  )
  static String rewriteLocalhost(String url, {String host = 'localhost'}) =>
      _rewriteLocalhost(url, host);

  @override
  bool operator ==(Object other) =>
      other is BlocksConfig &&
      other.baseUrl == baseUrl &&
      other.connectTimeout == connectTimeout &&
      other.idleTimeout == idleTimeout;

  @override
  int get hashCode => Object.hash(baseUrl, connectTimeout, idleTimeout);

  @override
  String toString() =>
      'BlocksConfig(baseUrl: $baseUrl, connectTimeout: $connectTimeout, '
      'idleTimeout: $idleTimeout)';
}

/// Rewrites `localhost` in [url] to [host].
///
/// It matches the literal `://localhost` prefix, so a URL that names
/// `127.0.0.1` or another loopback address is left unchanged.
///
/// Utility for resolving localhost URLs on different platforms. Useful for
/// Android emulators, where localhost is the emulator itself: pass
/// `'10.0.2.2'` to reach the host machine.
String rewriteLocalhost(String url, {String host = 'localhost'}) =>
    _rewriteLocalhost(url, host);

String _rewriteLocalhost(String url, String host) {
  return url.replaceAll('://localhost', '://$host');
}
