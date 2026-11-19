import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:math';

import 'oidc_exception.dart';

/// The host the listener binds and the relay target names. The backend's
/// relay allowlist permits loopback on any port but matches the literal
/// address only: a `localhost` host is rejected.
const _loopbackHost = '127.0.0.1';

/// The path the relay redirect arrives on, as in the Kotlin JVM runtime.
const _callbackPath = '/oidc/callback';

/// The prefix of the path that redirects to the authorize URL once no browser
/// could be opened. The full path adds a random segment, so only someone who
/// was shown the printed URL can use it.
const _startPrefix = '/oidc/start/';

/// Whether this platform signs in through a loopback listener when no
/// launcher is passed: desktop, where no app scheme can be registered.
bool get loopbackSupported =>
    loopbackSupportedOverride ??
    (Platform.isMacOS || Platform.isLinux || Platform.isWindows);

/// Replaces [loopbackSupported] when set. For tests.
bool? loopbackSupportedOverride;

/// [_runOpener], for tests.
Future<void> runOpenerForTest(List<String> command) => _runOpener(command);

/// Receives the relay redirect on a listener bound to `127.0.0.1` for one
/// sign-in attempt (RFC 8252, section 7.3).
///
/// The code arrives over plain loopback HTTP, which is what native apps are
/// expected to do: PKCE protects the code, and the loopback bind keeps the
/// listener off the network.
class LoopbackSession {
  LoopbackSession._(
    this._server,
    this._customOpenUrl,
    this._platformOpen,
    this._printLine,
    this._timeout,
  ) : relayTo = 'http://$_loopbackHost:${_server.port}$_callbackPath' {
    _server.listen(_handle, onError: (Object _) {});
  }

  /// Binds the listener on a port the operating system picks.
  ///
  /// [openUrl] is the app's opener; when it throws, the sign-in fails. Without
  /// one, [platformOpen] opens the browser, and when it fails the session
  /// prints a start URL with [printLine] (stderr by default) and keeps
  /// waiting. [platformOpen] and [printLine] are for tests.
  static Future<LoopbackSession> open({
    Future<void> Function(Uri url)? openUrl,
    Duration timeout = const Duration(minutes: 5),
    Future<void> Function(Uri url) platformOpen = openUrlWithPlatformHandler,
    void Function(String line)? printLine,
  }) async {
    final server = await HttpServer.bind(_loopbackHost, 0);
    return LoopbackSession._(
      server,
      openUrl,
      platformOpen,
      printLine ?? stderr.writeln,
      timeout,
    );
  }

  final HttpServer _server;

  /// The app's opener, or null for [_platformOpen] with the fallback.
  final Future<void> Function(Uri url)? _customOpenUrl;
  final Future<void> Function(Uri url) _platformOpen;
  final void Function(String line) _printLine;
  final Duration _timeout;

  /// The relay target to sign in with: `http://127.0.0.1:<port>/oidc/callback`.
  final String relayTo;

  final _redirect = Completer<Uri>();
  String? _expectedState;

  /// The start path and the authorize URL it redirects to, set only once the
  /// platform handler failed to open a browser. It works for one request.
  String? _startPath;
  Uri? _startTarget;

  /// Opens [authorizeUrl] and returns the redirect whose `state` is
  /// [expectedState].
  ///
  /// The redirect is returned as soon as it arrives, even while the opener is
  /// still running. One deadline covers opening the browser and waiting:
  /// when it passes, this throws [OidcCancelledException]. An app opener that
  /// throws fails the wait at once. Throws [ArgumentError] for an authorize
  /// URL that isn't `https` (or `http` on a loopback host), before anything
  /// opens it. When [cancel] completes before the redirect arrives, this
  /// throws [OidcCancelledException], as the deadline does. Always closes the
  /// listener.
  Future<Uri> awaitRedirect(
    Uri authorizeUrl, {
    required String expectedState,
    Future<void>? cancel,
  }) async {
    try {
      if (!_isWebUrl(authorizeUrl)) {
        throw ArgumentError.value(
          authorizeUrl.scheme,
          'authorizeUrl',
          'must be an https URL, or http on a loopback host',
        );
      }
      _expectedState = expectedState;
      final opened = _open(authorizeUrl);
      return await Future.any([
        _redirect.future,
        opened.then((_) => _redirect.future),
        if (cancel != null)
          cancel.then<Uri>((_) => throw OidcCancelledException()),
      ]).timeout(
        _timeout,
        onTimeout: () => throw OidcCancelledException(
          'Sign-in timed out after ${_timeout.inSeconds}s waiting for a '
          'redirect at $relayTo',
        ),
      );
    } finally {
      await close();
    }
  }

  Future<void> _open(Uri authorizeUrl) async {
    final custom = _customOpenUrl;
    if (custom != null) return custom(authorizeUrl);
    try {
      await _platformOpen(authorizeUrl);
    } on Object {
      // No browser opened, for example on a headless Linux host with no
      // xdg-open. Print a one-time start URL that redirects to the authorize
      // URL, and keep waiting until the deadline.
      final path = '$_startPrefix${_randomSegment()}';
      _startTarget = authorizeUrl;
      _startPath = path;
      _printLine(
        'Could not open a browser to sign in. Open this URL:\n'
        'http://$_loopbackHost:${_server.port}$path',
      );
    }
  }

  /// Closes the listener. Safe to call more than once.
  Future<void> close() => _server.close(force: true);

  Future<void> _handle(HttpRequest request) async {
    final response = request.response
      ..headers.set(HttpHeaders.cacheControlHeader, 'no-store');
    final Uri uri;
    final Map<String, String> query;
    try {
      // Any local process can reach this port, and a query with bad
      // percent-encoding makes these throw.
      uri = request.requestedUri;
      query = uri.queryParameters;
    } on FormatException {
      try {
        response.statusCode = HttpStatus.badRequest;
        await response.close();
      } on Object {
        // The client already went away.
      }
      return;
    }
    final isGet = request.method == 'GET';
    try {
      final startTarget = _startTarget;
      if (isGet && startTarget != null && uri.path == _startPath) {
        _startPath = null;
        _startTarget = null;
        await response.redirect(startTarget);
        return;
      }
      // Browsers request things like /favicon.ico, and any local process can
      // reach this port. Only the relay redirect of this attempt ends the
      // wait, so nothing else can strand it: the backend always sends the
      // issued `state` with a `code` or an `error`.
      final expected = _expectedState;
      final isRedirect =
          isGet &&
          uri.path == _callbackPath &&
          expected != null &&
          _sameState(query['state'], expected) &&
          ((query['code'] ?? '').isNotEmpty || query.containsKey('error'));
      if (!isRedirect || _redirect.isCompleted) {
        response.statusCode = HttpStatus.notFound;
        await response.close();
        return;
      }
      try {
        response.headers.contentType = ContentType.html;
        response.write(
          query.containsKey('error') ? _page('Sign-in failed') : _page(null),
        );
        await response.close();
      } finally {
        // Only after the page is sent: completing the wait closes the
        // listener, which would cut the response short. A failed response
        // still hands the redirect over.
        if (!_redirect.isCompleted) _redirect.complete(uri);
      }
    } on Object {
      // A tab closed mid-response is not a sign-in failure.
    }
  }
}

/// The page the browser shows once the redirect arrived. It's sent before the
/// app checks the code, so it doesn't claim the sign-in worked. It carries no
/// request data, so nothing from the query is echoed into it.
String _page(String? failure) {
  final title = failure ?? 'Return to the app';
  final lead = failure == null ? '' : '$failure. ';
  const head = '<!doctype html><html lang="en"><head><meta charset="utf-8">';
  const tail = 'You can close this window and return to the app.</p></body>';
  return '$head<title>$title</title></head><body><p>$lead$tail</html>';
}

/// Compares [actual] with [expected] in time that doesn't depend on where
/// they differ.
bool _sameState(String? actual, String expected) {
  if (actual == null || actual.length != expected.length) return false;
  var diff = 0;
  for (var i = 0; i < actual.length; i++) {
    diff |= actual.codeUnitAt(i) ^ expected.codeUnitAt(i);
  }
  return diff == 0;
}

/// Whether [url] is safe to hand to the operating system's URL handler, which
/// would also open `file:` paths and launch apps.
bool _isWebUrl(Uri url) =>
    url.scheme == 'https' ||
    (url.scheme == 'http' &&
        const {'127.0.0.1', 'localhost', '::1'}.contains(url.host));

/// A random URL-safe path segment.
String _randomSegment() {
  final random = Random.secure();
  return base64Url
      .encode(List<int>.generate(24, (_) => random.nextInt(256)))
      .replaceAll('=', '');
}

/// The command that opens [url] on the operating system named [os], as
/// `Platform.operatingSystem` names it.
List<String> browserCommand(String os, String url) => switch (os) {
  'macos' => ['open', url],
  // rundll32 rather than `cmd /c start`, which treats `&` in a query as a
  // command separator.
  'windows' => ['rundll32', 'url.dll,FileProtocolHandler', url],
  _ => ['xdg-open', url],
};

/// Opens [url] with the platform's URL handler. The URL is a process
/// argument, never parsed by a shell. Throws when the handler can't run or
/// exits with an error.
///
/// Waits for the handler to exit, not for its output to close: a browser the
/// handler starts can inherit its output and keep it open until it quits. The
/// output is discarded, so it never mixes into the app's own.
Future<void> openUrlWithPlatformHandler(Uri url) =>
    _runOpener(browserCommand(Platform.operatingSystem, url.toString()));

/// Runs [command] and throws when it can't run or exits with an error.
Future<void> _runOpener(List<String> command) async {
  final process = await Process.start(command.first, command.sublist(1));
  unawaited(process.stdout.drain<void>());
  unawaited(process.stderr.drain<void>());
  final exitCode = await process.exitCode;
  if (exitCode != 0) {
    throw ProcessException(
      command.first,
      command.sublist(1),
      'exited with $exitCode',
      exitCode,
    );
  }
}
