import 'dart:convert';

import 'token_store.dart';

/// Abstract interface for cookie/token persistence.
abstract class SessionStore {
  /// Returns cookies as a map of name → value.
  Map<String, String> get cookies;

  /// Stores cookies parsed from a Set-Cookie header value.
  ///
  /// [requestUri] is the URL of the request the response answered. It scopes
  /// each cookie to that host, supplies the default `Path`, and is the moment
  /// `Max-Age` counts from. Without it a cookie is not tied to a host.
  void setCookies(String? setCookieHeader, {Uri? requestUri});

  /// Returns the Cookie header string for outgoing requests.
  ///
  /// Every unexpired cookie is included regardless of host, `Path` or
  /// `Secure`; use [cookieHeaderFor] to build the header for a specific
  /// request.
  String? get cookieHeader;

  /// Returns the Cookie header for a request to [requestUri]: only unexpired
  /// cookies whose host and `Path` match it, and `Secure` cookies only over
  /// `https`/`wss`.
  String? cookieHeaderFor(Uri requestUri);

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
    secure: json['secure'] as bool? ?? false,
    expiresAt: json['expiresAt'] as int?,
  );

  final String name;
  final String value;

  /// The host that set the cookie; `null` when it was stored without one.
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
  bool matches(Uri uri) {
    if (host != null && host!.toLowerCase() != uri.host.toLowerCase()) {
      return false;
    }
    if (secure && uri.scheme != 'https' && uri.scheme != 'wss') return false;
    if (path == '/') return true;
    final requestPath = _withTrailingSlash(uri.path.isEmpty ? '/' : uri.path);
    return requestPath.startsWith(_withTrailingSlash(path));
  }

  Map<String, dynamic> toJson() => {
    'name': name,
    'value': value,
    'host': host,
    'path': path,
    'secure': secure,
    'expiresAt': expiresAt,
  };

  static String _withTrailingSlash(String path) =>
      path.endsWith('/') ? path : '$path/';
}

/// In-memory session store — cookies are lost when the process exits.
class InMemorySessionStore implements SessionStore {
  /// [clock] returns the current time; tests inject one to control expiry.
  InMemorySessionStore({DateTime Function()? clock})
    : _clock = clock ?? DateTime.now;

  final DateTime Function() _clock;

  /// Keyed by host, path and name, so cookies with the same name set by
  /// different hosts or for different paths are kept apart.
  final Map<String, _StoredCookie> _cookies = {};

  int get _now => _clock().millisecondsSinceEpoch;

  Iterable<_StoredCookie> get _live =>
      _cookies.values.where((c) => !c.isExpired(_now));

  @override
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
      _cookies.remove(parsed.key);
      // As in the Kotlin runtime, a cookie replaces every stored cookie of the
      // same name that would be sent on this request, including one persisted
      // by an earlier version of this store without a host.
      if (requestUri != null) {
        _cookies.removeWhere(
          (_, c) => c.name == parsed.name && c.matches(requestUri),
        );
      }
      // An expired cookie only deletes: `Max-Age=0` or a past `Expires` is how
      // a server signs a session out.
      if (!parsed.isExpired(_now)) _cookies[parsed.key] = parsed;
    }
  }

  @override
  String? get cookieHeader => _header(_live);

  @override
  String? cookieHeaderFor(Uri requestUri) =>
      _header(_live.where((c) => c.matches(requestUri)));

  @override
  void clear() => _cookies.clear();

  void _adopt(_StoredCookie cookie) {
    if (!cookie.isExpired(_now)) _cookies[cookie.key] = cookie;
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
/// All cookie logic (parsing Set-Cookie, the name→value map, building the
/// Cookie header) is platform-agnostic and lives here. Byte persistence is
/// delegated to the [TokenStore]: the cookie map is serialized to JSON and
/// stored under a single key.
///
/// The [SessionStore] interface is synchronous but [TokenStore] I/O is async,
/// so an in-memory cache is the synchronous source of truth; mutations
/// write-through asynchronously. Call [load] once at startup (before the first
/// request) to hydrate the cache from the backing store.
///
/// Flutter apps reuse the existing secure storage with zero new code:
/// ```dart
/// final session = PersistentSessionStore(store: FlutterSecureStore());
/// await session.load();
/// ```
/// Pure-Dart / tests inject an [InMemoryTokenStore].
class PersistentSessionStore implements SessionStore {
  PersistentSessionStore({
    required TokenStore store,
    String storageKey = '_session_cookies',
    DateTime Function()? clock,
  }) : _store = store,
       _storageKey = storageKey,
       _cache = InMemorySessionStore(clock: clock);

  final TokenStore _store;
  final String _storageKey;

  /// In-memory cache; parsing/serialization is delegated to an
  /// [InMemorySessionStore] so cookie logic stays in one place.
  final InMemorySessionStore _cache;

  /// Hydrates the in-memory cache from the backing [TokenStore]. Call once at
  /// startup before issuing authenticated requests. Safe to call repeatedly.
  ///
  /// The cookies are stored as a JSON list of records carrying each cookie's
  /// host, `Path`, `Secure` flag and expiry. A JSON object of name → value is
  /// the format earlier versions wrote; those cookies are kept, with no host,
  /// `Path=/`, no `Secure` and no expiry — what those versions sent — until
  /// the server sets them again.
  Future<void> load() async {
    final raw = await _store.get(_storageKey);
    if (raw == null || raw.isEmpty) return;
    try {
      final decoded = jsonDecode(raw);
      final restored = switch (decoded) {
        final List<dynamic> records => [
          for (final record in records)
            _StoredCookie.fromJson(record as Map<String, dynamic>),
        ],
        final Map<String, dynamic> legacy => [
          for (final entry in legacy.entries)
            _StoredCookie(
              name: entry.key,
              value: entry.value as String,
              host: null,
              path: '/',
              secure: false,
              expiresAt: null,
            ),
        ],
        _ => throw const FormatException('Unrecognized cookie payload'),
      };
      restored.forEach(_cache._adopt);
    } on Object catch (_) {
      // Corrupt/incompatible payload — start clean rather than crash.
      await _store.delete(_storageKey);
    }
  }

  @override
  Map<String, String> get cookies => _cache.cookies;

  @override
  String? get cookieHeader => _cache.cookieHeader;

  @override
  String? cookieHeaderFor(Uri requestUri) => _cache.cookieHeaderFor(requestUri);

  @override
  void setCookies(String? setCookieHeader, {Uri? requestUri}) {
    _cache.setCookies(setCookieHeader, requestUri: requestUri);
    // Fire-and-forget write-through; the cache already reflects the change for
    // synchronous reads.
    _persist();
  }

  @override
  void clear() {
    _cache.clear();
    _store.delete(_storageKey);
  }

  Future<void> _persist() => _store.set(
    _storageKey,
    jsonEncode([for (final c in _cache._live) c.toJson()]),
  );
}
