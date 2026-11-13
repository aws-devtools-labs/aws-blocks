/// No loopback listener without `dart:io`: a browser app redirects to its own
/// origin instead.
bool get loopbackSupported => loopbackSupportedOverride ?? false;

/// Replaces [loopbackSupported] when set. For tests.
bool? loopbackSupportedOverride;

/// Never constructed: [loopbackSupported] is false.
abstract class LoopbackSession {
  static Future<LoopbackSession> open({
    Future<void> Function(Uri url)? openUrl,
    Duration timeout = const Duration(minutes: 5),
    Future<void> Function(Uri url)? platformOpen,
    void Function(String line)? printLine,
  }) => throw UnsupportedError('No loopback sign-in on this platform');

  String get relayTo;

  Future<Uri> awaitRedirect(
    Uri authorizeUrl, {
    required String expectedState,
    Future<void>? cancel,
  });

  Future<void> close();
}
