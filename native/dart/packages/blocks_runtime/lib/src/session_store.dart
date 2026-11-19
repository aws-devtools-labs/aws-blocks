// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import 'dart:convert';
import 'dart:developer' as developer;

import 'session_warning.dart';
import 'token_store.dart';

/// Abstract interface for cookie/token persistence.
abstract class SessionStore {
  /// Stores cookies parsed from a Set-Cookie header value.
  ///
  /// [requestUri] is the URL of the request the response answered. It scopes
  /// each cookie to that host, supplies the default `Path`, and is the moment
  /// `Max-Age` counts from. Without it a cookie is not tied to a host.
  ///
  /// A cookie with an empty value (`name=; Path=/`) is treated as a removal:
  /// it replaces the same-named cookies as any other would, and is not
  /// stored. This matches the Swift runtime's cookie jar; it is a convention
  /// of these jars, not an RFC 6265 deletion rule.
  void setCookies(String? setCookieHeader, {Uri? requestUri});

  /// Returns the Cookie header for a request to [requestUri]: only unexpired
  /// cookies whose host and `Path` match it, and `Secure` cookies only over
  /// `https`/`wss`.
  ///
  /// This is what a client sends, so it is asynchronous: a store that
  /// persists its cookies completes it only after it has read them, and the
  /// first request after a restart then carries the session saved earlier.
  /// No caller has to load the store first.
  Future<String?> cookieHeaderFor(Uri requestUri);

  /// Clears all stored cookies (e.g. on sign-out).
  void clear();
}

/// One stored cookie with the attributes that decide where it is sent.
class _StoredCookie {
  _StoredCookie({
    required this.name,
    required this.value,
    required this.host,
    required this.path,
    required this.secure,
    required this.expiresAt,
  });

  /// Reads a persisted record; throws on a record that is not one.
  factory _StoredCookie.fromJson(Map<String, dynamic> json) => _StoredCookie(
    name: json['name'] as String,
    value: json['value'] as String,
    host: json['host'] as String?,
    path: json['path'] as String? ?? '/',
    // [toJson] always writes `secure`, so a record without it did not come
    // from this store; it is read as `Secure` rather than given the weaker
    // default.
    secure: json['secure'] as bool? ?? true,
    expiresAt: json['expiresAt'] as int?,
  );

  final String name;
  final String value;

  /// The host that set the cookie; `null` when it was stored without one.
  ///
  /// A cookie has no host when [setCookies] was called without a
  /// `requestUri`. Such a cookie matches every host until the server sets it
  /// again with a `requestUri`, when the new cookie replaces it with a
  /// host-scoped one.
  final String? host;
  final String path;
  final bool secure;

  /// Milliseconds since the epoch; `null` for a session cookie.
  final int? expiresAt;

  /// What makes two cookies the same cookie rather than two of them.
  String get key => keyOf(host, path, name);

  static String keyOf(String? host, String path, String name) =>
      '${host ?? ''}|$path|$name';

  /// An expiry that has exactly arrived counts as passed, so a `Max-Age=0`
  /// cookie does not linger for the millisecond it was received in.
  bool isExpired(int now) => expiresAt != null && expiresAt! <= now;

  /// Host, `Path` and `Secure` matching, following the rules the Kotlin
  /// runtime applies through Ktor's `Cookie.matches`.
  ///
  /// A request path matches when it equals [path] or continues past it at a
  /// `/` (RFC 6265 section 5.1.4). [Uri.path] is the percent-encoded path —
  /// what the request is sent with — so it is compared with [path] as is.
  bool matches(Uri uri) {
    if (host != null && host!.toLowerCase() != uri.host.toLowerCase()) {
      return false;
    }
    if (secure && uri.scheme != 'https' && uri.scheme != 'wss') return false;
    if (path == '/') return true;
    final requestPath = uri.path.isEmpty ? '/' : uri.path;
    if (requestPath == path) return true;
    if (!requestPath.startsWith(path)) return false;
    return path.endsWith('/') || requestPath[path.length] == '/';
  }

  Map<String, dynamic> toJson() => {
    'name': name,
    'value': value,
    'host': host,
    'path': path,
    'secure': secure,
    'expiresAt': expiresAt,
  };
}

/// In-memory session store — cookies are lost when the process exits.
///
/// The class is `final`: implement [SessionStore] for a store of your own.
final class InMemorySessionStore implements SessionStore {
  /// [clock] returns the current time; tests inject one to control expiry.
  InMemorySessionStore({DateTime Function()? clock})
    : _clock = clock ?? DateTime.now;

  final DateTime Function() _clock;

  /// Keyed by host, path and name, so cookies with the same name set by
  /// different hosts or for different paths are kept apart.
  final Map<String, _StoredCookie> _cookies = {};

  /// Names of the cookies [setCookies] has set or removed. A stored copy of
  /// one of them is older than what this store holds, so [_adopt] skips it.
  final Set<String> _changedNames = {};

  /// Set by [clear]: nothing stored before it is adopted afterwards.
  bool _cleared = false;

  int get _now => _clock().millisecondsSinceEpoch;

  Iterable<_StoredCookie> get _live =>
      _cookies.values.where((c) => !c.isExpired(_now));

  /// The unexpired cookies held now, as a map of name → value, whatever
  /// their host, `Path` or `Secure` flag. For debugging and tests; a request
  /// sends [cookieHeaderFor] instead.
  Map<String, String> get cookies =>
      Map.unmodifiable({for (final c in _live) c.name: c.value});

  @override
  void setCookies(String? setCookieHeader, {Uri? requestUri}) {
    if (setCookieHeader == null) return;
    // Multiple Set-Cookie headers are joined with ',' by dart:http.
    // Split on ',' but only where it separates cookies (not within values).
    // A cookie starts with `name=`, which tells the separator apart from the
    // comma inside an `Expires` date.
    for (final cookie in setCookieHeader.split(RegExp(r',(?=\s*[^;,=\s]+=)'))) {
      final parsed = _parse(cookie, requestUri);
      if (parsed == null) continue;
      _changedNames.add(parsed.name);
      _cookies.remove(parsed.key);
      // As in the Kotlin runtime, a cookie replaces every stored cookie of the
      // same name that would be sent on this request, including one stored
      // without a host because it was set without a `requestUri`.
      if (requestUri != null) {
        _cookies.removeWhere(
          (_, c) => c.name == parsed.name && c.matches(requestUri),
        );
      }
      // An expired cookie only deletes: `Max-Age=0` or a past `Expires` is how
      // a server signs a session out. An empty value also only deletes, as in
      // the Swift runtime's cookie jar.
      if (parsed.value.isNotEmpty && !parsed.isExpired(_now)) {
        _cookies[parsed.key] = parsed;
      }
    }
  }

  /// Cookies with longer paths come first, so a server that reads the first
  /// of several same-named cookies gets the most specific one.
  @override
  Future<String?> cookieHeaderFor(Uri requestUri) =>
      Future<String?>.value(_headerFor(requestUri));

  String? _headerFor(Uri requestUri) => _header(
    _live.where((c) => c.matches(requestUri)).toList()
      ..sort((a, b) => b.path.length.compareTo(a.path.length)),
  );

  @override
  void clear() {
    _cookies.clear();
    _cleared = true;
  }

  /// Takes in a cookie read from storage, unless it has expired or this
  /// store has since changed it: a cookie [setCookies] set or removed, or
  /// anything stored before a [clear], is newer here than in storage. That
  /// keeps a late or repeated [PersistentSessionStore.load] from bringing back
  /// a cookie the server has replaced or removed.
  void _adopt(_StoredCookie cookie) {
    if (_cleared || _changedNames.contains(cookie.name)) return;
    if (_cookies.containsKey(cookie.key) || cookie.isExpired(_now)) return;
    _cookies[cookie.key] = cookie;
  }

  String? _header(Iterable<_StoredCookie> cookies) {
    if (cookies.isEmpty) return null;
    return cookies.map((c) => '${c.name}=${c.value}').join('; ');
  }

  _StoredCookie? _parse(String setCookie, Uri? requestUri) {
    final segments = setCookie.trim().split(';');
    final nameValue = segments.first;
    final eqIdx = nameValue.indexOf('=');
    if (eqIdx <= 0) return null;

    String? path;
    var secure = false;
    int? maxAge;
    int? expires;
    for (final segment in segments.skip(1)) {
      final attrEq = segment.indexOf('=');
      final attrName = (attrEq < 0 ? segment : segment.substring(0, attrEq))
          .trim()
          .toLowerCase();
      final attrValue = attrEq < 0 ? '' : segment.substring(attrEq + 1).trim();
      switch (attrName) {
        case 'path':
          path = attrValue;
        case 'secure':
          secure = true;
        case 'max-age':
          maxAge = int.tryParse(attrValue) ?? maxAge;
        case 'expires':
          expires = _parseCookieDate(attrValue) ?? expires;
      }
    }

    // `Max-Age` takes precedence over `Expires`.
    final expiresAt = maxAge != null ? _now + maxAge * 1000 : expires;
    return _StoredCookie(
      name: nameValue.substring(0, eqIdx).trim(),
      value: nameValue.substring(eqIdx + 1).trim(),
      host: requestUri?.host,
      path: path != null && path.startsWith('/')
          ? path
          : _defaultPath(requestUri),
      secure: secure,
      expiresAt: expiresAt,
    );
  }

  /// The path a cookie gets when it carries no usable `Path`: the directory
  /// of the request path, so it applies to the rest of the site rather than
  /// only the endpoint that set it.
  static String _defaultPath(Uri? requestUri) {
    final requestPath = requestUri?.path ?? '';
    final lastSlash = requestPath.lastIndexOf('/');
    return lastSlash <= 0 ? '/' : requestPath.substring(0, lastSlash);
  }

  static const _months = [
    'jan',
    'feb',
    'mar',
    'apr',
    'may',
    'jun',
    'jul',
    'aug',
    'sep',
    'oct',
    'nov',
    'dec',
  ];

  /// Parses an `Expires` date into milliseconds since the epoch, or `null`
  /// when it cannot be read. Accepts the formats servers send — e.g.
  /// `Wed, 21 Oct 2015 07:28:00 GMT` and `Wednesday, 21-Oct-15 07:28:00 GMT`
  /// — by picking out the time, day, month and year tokens, in the manner of
  /// RFC 6265 section 5.1.1. Always read as UTC.
  static int? _parseCookieDate(String input) {
    (int, int, int)? time;
    int? day;
    int? month;
    int? year;
    for (final token in input.split(RegExp(r'[\s,\-]+'))) {
      final hms = RegExp(r'^(\d{1,2}):(\d{1,2}):(\d{1,2})$').firstMatch(token);
      if (time == null && hms != null) {
        time = (
          int.parse(hms.group(1)!),
          int.parse(hms.group(2)!),
          int.parse(hms.group(3)!),
        );
      } else if (day == null && RegExp(r'^\d{1,2}$').hasMatch(token)) {
        day = int.parse(token);
      } else if (month == null &&
          token.length >= 3 &&
          _months.contains(token.substring(0, 3).toLowerCase())) {
        month = _months.indexOf(token.substring(0, 3).toLowerCase()) + 1;
      } else if (year == null && RegExp(r'^\d{2,4}$').hasMatch(token)) {
        year = int.parse(token);
      }
    }
    if (time == null || day == null || month == null || year == null) {
      return null;
    }
    final (hour, minute, second) = time;
    if (day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) {
      return null;
    }
    if (year < 70) {
      year += 2000;
    } else if (year < 100) {
      year += 1900;
    }
    return DateTime.utc(
      year,
      month,
      day,
      hour,
      minute,
      second,
    ).millisecondsSinceEpoch;
  }
}

/// A [SessionStore] that persists cookies via an injected [TokenStore].
///
/// All cookie logic (parsing Set-Cookie, applying each cookie's attributes,
/// building the Cookie header) is platform-agnostic and lives here. Byte
/// persistence is delegated to the [TokenStore]: the cookie records are
/// serialized as a JSON list and stored under a single key.
///
/// The [SessionStore] interface is synchronous but [TokenStore] I/O is async,
/// so an in-memory cache is the synchronous source of truth; mutations
/// write-through asynchronously. [load] hydrates the cache from the backing
/// store.
///
/// The store reads the backing store itself: [cookieHeaderFor], and every
/// write, wait for the first read to finish, so the first request after a
/// restart sends the saved session without anyone calling [load]. Call [load]
/// yourself only to read [cookies] before the first request. Calling it as
/// well is harmless: a cookie this store has already set or removed is not
/// replaced by the copy in storage.
///
/// The backing store is written only when the stored cookies change: a
/// response without `Set-Cookie`, or one that sets a cookie to the value,
/// attributes and expiry it already has, writes nothing. Writes run one at a
/// time, in order, and each writes the cookies as they are when it runs.
/// [flush] completes once every write queued so far has finished, so a
/// program that is about to exit can keep a cookie it has just received.
///
/// A failed read or write never throws into the app, because it happens
/// outside the call that caused it. It is passed to `onPersistError`; when
/// none is given, it is logged with `dart:developer`'s `log` under the name
/// `blocks_runtime.session` at warning level, and one line naming it is
/// written to standard error (the browser console on the web). Only the first
/// failure is reported until a read or write succeeds again, so a store that
/// keeps failing does not report on every request. A stored value that is not
/// a cookie list is reported the same way, then deleted.
///
/// The cookies stay in memory and keep working for this process. A failed
/// read is not retried on every request: it is tried again when a cookie
/// changes, before that change is written, and on a request made at least
/// 30 seconds after the last failed attempt. That way a store that could not
/// be read at launch (an iOS Keychain item while the device is still locked,
/// for example) is read once it becomes readable, and its session is sent
/// from then on. Until a read succeeds nothing is written, so a session that
/// could not be read is not overwritten; a change made meanwhile is written
/// once a read succeeds. [clear] is the exception: it deletes the stored
/// session at once. A failed write is retried on the next change.
///
/// A Flutter app that depends on `blocks_runtime_flutter` doesn't build one:
/// the plugin registers a store over `FlutterSecureStore` as the default
/// before `main` runs (see `registerDefaultSessionStore`). Pure-Dart code and
/// tests can build one over an [InMemoryTokenStore].
///
/// Use one instance per [storageKey] and [TokenStore]: each instance writes
/// its whole cookie set, so two of them over the same storage overwrite each
/// other's cookies. The default store (see `registerDefaultSessionStore`) is already
/// shared by every client that is not given one.
///
/// The class is `final`, so it can gain members in a later release without
/// breaking anyone: implement [SessionStore] for a store of your own, and in
/// tests use a real instance over an [InMemoryTokenStore] rather than a mock.
final class PersistentSessionStore implements SessionStore {
  /// [onPersistError] receives every error the backing [store] throws while
  /// this store reads or writes it; see the class documentation for what
  /// happens without one.
  PersistentSessionStore({
    required TokenStore store,
    String storageKey = '_session_cookies',
    DateTime Function()? clock,
    void Function(Object error, StackTrace stackTrace)? onPersistError,
  }) : _store = store,
       _storageKey = storageKey,
       _onPersistError = onPersistError,
       _cache = InMemorySessionStore(clock: clock);

  final TokenStore _store;
  final String _storageKey;
  final void Function(Object error, StackTrace stackTrace)? _onPersistError;

  /// In-memory cache; parsing/serialization is delegated to an
  /// [InMemorySessionStore] so cookie logic stays in one place.
  final InMemorySessionStore _cache;

  /// The first successful [load], shared by every caller of [_ensureLoaded];
  /// reset to null when a load fails, so the next caller tries again.
  Future<bool>? _loading;

  /// Whether a load has read the backing store. Nothing is written before.
  bool _loaded = false;

  /// The serialized cookie set the backing store holds, as far as this store
  /// knows: what [load] read, or what the last successful write wrote.
  String? _persisted;

  /// How many times [setCookies] or [clear] has changed the cookies. While it
  /// is zero the cache holds exactly what [load] read.
  int _changes = 0;

  /// The value of [_changes] when a load last failed, or null when none has
  /// failed since the last success. A failed load is tried again once the
  /// cookies have changed since, or once [_loadRetryInterval] has passed
  /// since [_failedLoadTime].
  int? _failedLoadAt;

  /// When the last load failed, in milliseconds since the epoch.
  int _failedLoadTime = 0;

  /// How long a request waits after a failed load before reading again.
  static const _loadRetryInterval = Duration(seconds: 30);

  /// Whether a failure has been reported and nothing has succeeded since.
  bool _failing = false;

  /// The tail of the write queue.
  Future<void> _writes = Future<void>.value();

  /// Hydrates the in-memory cache from the backing [TokenStore]. Call once at
  /// startup before issuing authenticated requests. Safe to call repeatedly.
  ///
  /// The cookies are stored as a JSON list of records carrying each cookie's
  /// host, `Path`, `Secure` flag and expiry. A JSON object of name → value is
  /// the format earlier versions wrote. It recorded no host, `Path`,
  /// `Secure` flag or scheme, so a cookie read from it could not be scoped to
  /// the host that set it. Those cookies are not loaded: the stored map is
  /// deleted and the user signs in again, as in the Swift and Kotlin runtimes.
  Future<void> load() async {
    final raw = await _store.get(_storageKey);
    if (raw == null || raw.isEmpty) return;
    try {
      final decoded = jsonDecode(raw);
      if (decoded is Map) {
        // The legacy name → value map: nothing is adopted (see above). It is
        // removed now rather than on the next save, so it is not read again if
        // no cookie is set before the app exits.
        await _store.delete(_storageKey);
        return;
      }
      final restored = switch (decoded) {
        final List<dynamic> records => [
          for (final record in records)
            _StoredCookie.fromJson(record as Map<String, dynamic>),
        ],
        _ => throw const FormatException('Unrecognized cookie payload'),
      };
      restored.forEach(_cache._adopt);
    } on Object catch (error, stackTrace) {
      // Corrupt or incompatible payload: start clean rather than crash, and say
      // so, because the user is signed out by it.
      _report(error, stackTrace);
      await _store.delete(_storageKey);
    }
  }

  /// Completes when every write to the backing store queued so far has
  /// finished, successfully or not; never throws.
  ///
  /// Writes happen in the background after each response that changes a
  /// cookie. A program that exits right after one, as a command-line tool
  /// calling `exit` does, awaits this first so the new cookie is stored:
  ///
  /// ```dart
  /// final store = client.sessionStore;
  /// if (store is PersistentSessionStore) await store.flush();
  /// exit(0);
  /// ```
  Future<void> flush() => _writes;

  /// The unexpired cookies held in memory now, as a map of name → value. For
  /// debugging and tests. Until the backing store has been read (by [load],
  /// [cookieHeaderFor] or a write), it does not include the saved session.
  Map<String, String> get cookies => _cache.cookies;

  /// Waits for the first read of the backing store (see the class
  /// documentation), then answers from memory. Never throws: when the read
  /// fails, it is reported and the cookies held in memory are used.
  @override
  Future<String?> cookieHeaderFor(Uri requestUri) async {
    await _ensureLoaded();
    return _cache._headerFor(requestUri);
  }

  @override
  void setCookies(String? setCookieHeader, {Uri? requestUri}) {
    // Most responses carry no Set-Cookie; they leave the cookies as they are.
    if (setCookieHeader == null) return;
    _cache.setCookies(setCookieHeader, requestUri: requestUri);
    _changes++;
    // Fire-and-forget write-through; the cache already reflects the change for
    // synchronous reads.
    _persist();
  }

  /// Deletes the stored session too, even while the backing store can't be
  /// read: a sign-out removes it either way, so the delete doesn't wait for
  /// the first read the way a write does.
  @override
  void clear() {
    _cache.clear();
    _changes++;
    _writes = _writes.then((_) => _deleteReportingErrors());
  }

  /// Loads the backing store once, before the first cookie read and the first
  /// write. Completes with whether the store has been read; never throws.
  Future<bool> _ensureLoaded() {
    if (_loaded) return Future<bool>.value(true);
    // A store that could not be read is not read again on every request: a
    // change to the cookies tries it again, and so does a request once the
    // retry interval has passed.
    if (_loading == null &&
        _failedLoadAt == _changes &&
        _cache._now - _failedLoadTime < _loadRetryInterval.inMilliseconds) {
      return Future<bool>.value(false);
    }
    return _loading ??= _loadReportingErrors();
  }

  Future<bool> _loadReportingErrors() async {
    try {
      await load();
      _loaded = true;
      // Once the cookies have changed, what storage holds is no longer known
      // from the cache, so the next write goes ahead.
      _persisted = _changes == 0 ? _serialize() : null;
      _failedLoadAt = null;
      _failing = false;
      // A change made while the store couldn't be read wasn't written; queue
      // it now. When this load runs inside a queued write, the new write runs
      // after that one, and finds nothing left to write.
      if (_changes != 0) _persist();
      return true;
    } on Object catch (error, stackTrace) {
      _loading = null;
      _failedLoadAt = _changes;
      _failedLoadTime = _cache._now;
      _report(error, stackTrace);
      return false;
    }
  }

  String _serialize() => jsonEncode([for (final c in _cache._live) c.toJson()]);

  /// Queues a write of the current cookies behind any write in progress.
  void _persist() {
    // An error here would skip every later write and make [flush] throw.
    _writes = _writes.then((_) => _writeIfChanged()).catchError((_, _) {});
  }

  Future<void> _writeIfChanged() async {
    // Writing before the stored cookies are read would replace them.
    if (!await _ensureLoaded()) return;
    final serialized = _serialize();
    if (serialized == _persisted) return;
    try {
      if (serialized == '[]') {
        await _store.delete(_storageKey);
      } else {
        await _store.set(_storageKey, serialized);
      }
      _persisted = serialized;
      _failing = false;
    } on Object catch (error, stackTrace) {
      // [_persisted] still names what storage holds, so the next change
      // writes again.
      _report(error, stackTrace);
    }
  }

  Future<void> _deleteReportingErrors() async {
    try {
      await _store.delete(_storageKey);
      _persisted = '[]';
      _failing = false;
    } on Object catch (error, stackTrace) {
      _report(error, stackTrace);
    }
  }

  void _report(Object error, StackTrace stackTrace) {
    if (_failing) return;
    _failing = true;
    final onPersistError = _onPersistError;
    if (onPersistError != null) {
      try {
        onPersistError(error, stackTrace);
      } on Object catch (callbackError, callbackStackTrace) {
        // The callback runs outside the app's call stack too, so its own
        // error would be just as uncaught.
        _log(callbackError, callbackStackTrace);
      }
      return;
    }
    _log(error, stackTrace);
  }

  static const _message =
      'Could not read or write the stored session cookies; they are kept in '
      'memory for this process.';

  static void _log(Object error, StackTrace stackTrace) {
    developer.log(
      _message,
      name: 'blocks_runtime.session',
      level: 900,
      error: error,
      stackTrace: stackTrace,
    );
    // Standard error can be a closed pipe, such as a CLI piped into `head`.
    // The warning is best effort and must not throw out of a write.
    try {
      writeSessionWarning('blocks_runtime: $_message ($error)');
    } on Object {
      // Nothing else to report it to.
    }
  }
}
