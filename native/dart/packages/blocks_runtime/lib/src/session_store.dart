import 'dart:convert';

import 'token_store.dart';

/// Abstract interface for cookie/token persistence.
abstract class SessionStore {
  /// Returns cookies as a map of name → value.
  Map<String, String> get cookies;

  /// Stores cookies parsed from a Set-Cookie header value.
  void setCookies(String? setCookieHeader);

  /// Returns the Cookie header string for outgoing requests.
  String? get cookieHeader;

  /// Clears all stored cookies (e.g. on sign-out).
  void clear();
}

/// In-memory session store — cookies are lost when the process exits.
class InMemorySessionStore implements SessionStore {
  final Map<String, String> _cookies = {};

  @override
  Map<String, String> get cookies => Map.unmodifiable(_cookies);

  @override
  void setCookies(String? setCookieHeader) {
    if (setCookieHeader == null) return;
    // Multiple Set-Cookie headers are joined with ',' by dart:http.
    // Split on ',' but only where it separates cookies (not within values).
    for (final cookie in setCookieHeader.split(RegExp(r',(?=[^;]*=)'))) {
      final nameValue = cookie.trim().split(';')[0];
      final eqIdx = nameValue.indexOf('=');
      if (eqIdx > 0) {
        _cookies[nameValue.substring(0, eqIdx).trim()] =
            nameValue.substring(eqIdx + 1).trim();
      }
    }
  }

  @override
  String? get cookieHeader {
    if (_cookies.isEmpty) return null;
    return _cookies.entries.map((e) => '${e.key}=${e.value}').join('; ');
  }

  @override
  void clear() => _cookies.clear();
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
  final TokenStore _store;
  final String _storageKey;

  /// In-memory cache; parsing/serialization is delegated to an
  /// [InMemorySessionStore] so cookie logic stays in one place.
  final InMemorySessionStore _cache = InMemorySessionStore();

  PersistentSessionStore({
    required TokenStore store,
    String storageKey = '_session_cookies',
  })  : _store = store,
        _storageKey = storageKey;

  /// Hydrates the in-memory cache from the backing [TokenStore]. Call once at
  /// startup before issuing authenticated requests. Safe to call repeatedly.
  Future<void> load() async {
    final raw = await _store.get(_storageKey);
    if (raw == null || raw.isEmpty) return;
    try {
      final map =
          (jsonDecode(raw) as Map<String, dynamic>).cast<String, String>();
      for (final entry in map.entries) {
        _cache.setCookies('${entry.key}=${entry.value}');
      }
    } catch (_) {
      // Corrupt/incompatible payload — start clean rather than crash.
      await _store.delete(_storageKey);
    }
  }

  @override
  Map<String, String> get cookies => _cache.cookies;

  @override
  String? get cookieHeader => _cache.cookieHeader;

  @override
  void setCookies(String? setCookieHeader) {
    _cache.setCookies(setCookieHeader);
    // Fire-and-forget write-through; the cache already reflects the change for
    // synchronous reads.
    _persist();
  }

  @override
  void clear() {
    _cache.clear();
    _store.delete(_storageKey);
  }

  Future<void> _persist() =>
      _store.set(_storageKey, jsonEncode(_cache.cookies));
}
