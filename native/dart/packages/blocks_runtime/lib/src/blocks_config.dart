/// @docImport 'blocks_client.dart';
library;

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
/// constructor that takes the config. Further settings may be added later.
///
/// The class is `final`, so it can't be implemented or extended outside this
/// package. That lets a later release add a value without breaking anyone.
final class BlocksConfig {
  /// The URL the client sends its calls under, the same value as
  /// [BlocksClient.baseUrl].
  final String baseUrl;

  /// Creates a config for [baseUrl].
  const BlocksConfig({required this.baseUrl});

  /// A copy of this config with the given values replaced.
  BlocksConfig copyWith({String? baseUrl}) =>
      BlocksConfig(baseUrl: baseUrl ?? this.baseUrl);

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
      other is BlocksConfig && other.baseUrl == baseUrl;

  @override
  int get hashCode => baseUrl.hashCode;

  @override
  String toString() => 'BlocksConfig(baseUrl: $baseUrl)';
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
