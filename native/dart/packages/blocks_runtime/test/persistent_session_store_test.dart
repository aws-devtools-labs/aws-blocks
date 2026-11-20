// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import 'dart:convert';

import 'package:blocks_runtime/blocks_runtime.dart';
import 'package:test/test.dart';

void main() async {
  group('PersistentSessionStore', () {
    test('implements SessionStore', () async {
      expect(
        PersistentSessionStore(store: InMemoryTokenStore()),
        isA<SessionStore>(),
      );
    });

    test('parses Set-Cookie and builds the Cookie header', () async {
      final store = PersistentSessionStore(store: InMemoryTokenStore());
      store.setCookies('blocks_session=abc; Path=/; HttpOnly');
      expect(store.cookies['blocks_session'], 'abc');
      expect(
        await store.cookieHeaderFor(Uri.parse('https://example.com/')),
        'blocks_session=abc',
      );
    });

    test('write-through persists the cookie map to the TokenStore', () async {
      final token = InMemoryTokenStore();
      final store = PersistentSessionStore(store: token, storageKey: 'k');

      store.setCookies('blocks_session=abc; Path=/');
      // Allow the fire-and-forget write-through to complete.
      await Future<void>.delayed(Duration.zero);

      final raw = await token.get('k');
      expect(raw, isNotNull);
      final records = (jsonDecode(raw!) as List<dynamic>)
          .cast<Map<String, dynamic>>();
      expect(records.single['name'], 'blocks_session');
      expect(records.single['value'], 'abc');
      expect(records.single['path'], '/');
    });

    test(
      'load does not adopt cookies persisted as a name → value map',
      () async {
        final token = InMemoryTokenStore();
        await token.set('k', jsonEncode({'blocks_session': 'old'}));

        final store = PersistentSessionStore(store: token, storageKey: 'k');
        await store.load();

        expect(store.cookies, isEmpty);
        for (final url in [
          'http://localhost:3001/cdk-blocks/api',
          'https://localhost:3001/cdk-blocks/api',
          'https://other.example.com/',
          'wss://other.example.com/realtime',
        ]) {
          expect(
            await store.cookieHeaderFor(Uri.parse(url)),
            isNull,
            reason: url,
          );
        }
        // The legacy map is removed from the backing store on load.
        expect(await token.get('k'), isNull);

        // A later save writes only the new record, not the legacy cookie.
        store.setCookies(
          'other=1',
          requestUri: Uri.parse('https://localhost:3001/cdk-blocks/api'),
        );
        await store.flush();
        final records = (jsonDecode((await token.get('k'))!) as List<dynamic>)
            .cast<Map<String, dynamic>>();
        expect(records.map((r) => r['name']), ['other']);

        // A fresh store reading it back finds no legacy cookie either.
        final reader = PersistentSessionStore(store: token, storageKey: 'k');
        await reader.load();
        expect(reader.cookies, {'other': '1'});
      },
    );

    test('load reads a record without a secure field as Secure', () async {
      final token = InMemoryTokenStore();
      await token.set(
        'k',
        jsonEncode([
          {'name': 'a', 'value': '1', 'host': 'example.com', 'path': '/'},
        ]),
      );

      final store = PersistentSessionStore(store: token, storageKey: 'k');
      await store.load();
      expect(
        await store.cookieHeaderFor(Uri.parse('http://example.com/')),
        isNull,
      );
      expect(
        await store.cookieHeaderFor(Uri.parse('https://example.com/')),
        'a=1',
      );
    });

    test('attributes survive persistence', () async {
      final token = InMemoryTokenStore();
      final writer = PersistentSessionStore(store: token, storageKey: 'k');
      writer.setCookies(
        'a=1; Path=/app; Secure; Max-Age=3600',
        requestUri: Uri.parse('https://example.com/app/api'),
      );
      await Future<void>.delayed(Duration.zero);

      final reader = PersistentSessionStore(store: token, storageKey: 'k');
      await reader.load();
      expect(
        await reader.cookieHeaderFor(Uri.parse('https://example.com/app')),
        'a=1',
      );
      expect(
        await reader.cookieHeaderFor(Uri.parse('http://example.com/app')),
        isNull,
      );
      expect(
        await reader.cookieHeaderFor(Uri.parse('https://example.com/other')),
        isNull,
      );
      expect(
        await reader.cookieHeaderFor(Uri.parse('https://other.com/app')),
        isNull,
      );
    });

    test('load drops cookies that expired while persisted', () async {
      final token = InMemoryTokenStore();
      var now = DateTime.utc(2030);
      final writer = PersistentSessionStore(
        store: token,
        storageKey: 'k',
        clock: () => now,
      );
      writer.setCookies('a=1; Max-Age=60');
      await Future<void>.delayed(Duration.zero);

      now = now.add(const Duration(minutes: 2));
      final reader = PersistentSessionStore(
        store: token,
        storageKey: 'k',
        clock: () => now,
      );
      await reader.load();
      expect(reader.cookies, isEmpty);
    });

    test('load hydrates the cache from the TokenStore (round-trip)', () async {
      final token = InMemoryTokenStore();

      // Persist via one instance...
      final writer = PersistentSessionStore(store: token, storageKey: 'k');
      writer.setCookies('blocks_session=persisted; Path=/');
      await Future<void>.delayed(Duration.zero);

      // ...then a fresh instance (e.g. after app restart) loads it.
      final reader = PersistentSessionStore(store: token, storageKey: 'k');
      expect(reader.cookies, isEmpty); // not yet loaded
      await reader.load();
      expect(reader.cookies['blocks_session'], 'persisted');
      expect(
        await reader.cookieHeaderFor(Uri.parse('https://example.com/')),
        'blocks_session=persisted',
      );
    });

    test('load is a no-op when nothing is stored', () async {
      final store = PersistentSessionStore(store: InMemoryTokenStore());
      await store.load();
      expect(store.cookies, isEmpty);
    });

    test('load tolerates a corrupt payload by clearing it', () async {
      final token = InMemoryTokenStore();
      await token.set('k', 'not-json{');
      final store = PersistentSessionStore(store: token, storageKey: 'k');
      await store.load();
      expect(store.cookies, isEmpty);
      expect(await token.get('k'), isNull);
    });

    test('clear wipes the cache and the backing store', () async {
      final token = InMemoryTokenStore();
      final store = PersistentSessionStore(store: token, storageKey: 'k');
      store.setCookies('blocks_session=abc');
      await Future<void>.delayed(Duration.zero);
      expect(await token.get('k'), isNotNull);

      store.clear();
      expect(store.cookies, isEmpty);
      await Future<void>.delayed(Duration.zero);
      expect(await token.get('k'), isNull);
    });

    test('multiple cookies round-trip through persistence', () async {
      final token = InMemoryTokenStore();
      final writer = PersistentSessionStore(store: token, storageKey: 'k');
      writer.setCookies('a=1; Path=/');
      writer.setCookies('b=2; Path=/');
      await Future<void>.delayed(Duration.zero);

      final reader = PersistentSessionStore(store: token, storageKey: 'k');
      await reader.load();
      expect(reader.cookies, {'a': '1', 'b': '2'});
    });
  });

  group('PersistentSessionStore while storage is unreadable', () {
    final api = Uri.parse('https://example.com/cdk-blocks/api');

    /// Storage holding a session cookie with [value], then locked.
    Future<_LockableTokenStore> locked(String value) async {
      final token = _LockableTokenStore()..unreadable = false;
      final writer = PersistentSessionStore(store: token, storageKey: 'k')
        ..setCookies('session=$value; Path=/', requestUri: api);
      await writer.flush();
      expect(await token.get('k'), contains(value));
      return token..unreadable = true;
    }

    test('sign-out still deletes the stored session', () async {
      final token = await locked('secret');
      final store = PersistentSessionStore(
        store: token,
        storageKey: 'k',
        onPersistError: (_, _) {},
      )..clear();
      await store.flush();

      token.unreadable = false;
      expect(await token.get('k'), isNull);
    });

    test('a change is written once a later read succeeds', () async {
      final token = await locked('old');
      var now = DateTime.utc(2030);
      final store =
          PersistentSessionStore(
              store: token,
              storageKey: 'k',
              clock: () => now,
              onPersistError: (_, _) {},
            )
            // The backend rotates the session while storage can't be read.
            ..setCookies('session=rotated; Path=/', requestUri: api);
      await store.flush();

      // Storage becomes readable; a request after the retry interval reads it.
      token.unreadable = false;
      now = now.add(const Duration(seconds: 31));
      expect(await store.cookieHeaderFor(api), 'session=rotated');
      await store.flush();

      final records = (jsonDecode((await token.get('k'))!) as List<dynamic>)
          .cast<Map<String, dynamic>>();
      expect(records.map((r) => r['value']), ['rotated']);
    });

    test(
      'flush settles when the read succeeds inside a queued write',
      () async {
        final token = await locked('old');
        final store = PersistentSessionStore(
          store: token,
          storageKey: 'k',
          onPersistError: (_, _) {},
        )..setCookies('session=rotated; Path=/', requestUri: api);
        await store.flush();

        // The next change reads storage from inside its own write, which queues
        // the skipped write behind it.
        token.unreadable = false;
        store.setCookies('other=1; Path=/', requestUri: api);
        await store.flush().timeout(const Duration(seconds: 5));

        final records = (jsonDecode((await token.get('k'))!) as List<dynamic>)
            .cast<Map<String, dynamic>>();
        expect(records.map((r) => '${r['name']}=${r['value']}'), {
          'session=rotated',
          'other=1',
        });
      },
    );
  });

  group('cookie attributes', () {
    final now = DateTime.utc(2030, 1, 1, 12);
    InMemorySessionStore store() => InMemorySessionStore(clock: () => now);
    final api = Uri.parse('https://example.com/cdk-blocks/api');

    test('a Secure cookie is sent over https but not http', () async {
      final s = store()..setCookies('a=1; Path=/; Secure', requestUri: api);
      expect(
        await s.cookieHeaderFor(Uri.parse('https://example.com/x')),
        'a=1',
      );
      expect(
        await s.cookieHeaderFor(Uri.parse('http://example.com/x')),
        isNull,
      );
    });

    test('a cookie is only sent to paths under its Path', () async {
      final s = store()..setCookies('a=1; Path=/foo', requestUri: api);
      expect(
        await s.cookieHeaderFor(Uri.parse('https://example.com/foo')),
        'a=1',
      );
      expect(
        await s.cookieHeaderFor(Uri.parse('https://example.com/foo/b')),
        'a=1',
      );
      expect(
        await s.cookieHeaderFor(Uri.parse('https://example.com/bar')),
        isNull,
      );
      expect(
        await s.cookieHeaderFor(Uri.parse('https://example.com/foobar')),
        isNull,
      );
    });

    test(
      'a Path with a trailing slash is not sent to the path without it',
      () async {
        final s = store()..setCookies('a=1; Path=/admin/', requestUri: api);
        expect(
          await s.cookieHeaderFor(Uri.parse('https://example.com/admin/')),
          'a=1',
        );
        expect(
          await s.cookieHeaderFor(Uri.parse('https://example.com/admin/users')),
          'a=1',
        );
        expect(
          await s.cookieHeaderFor(Uri.parse('https://example.com/admin')),
          isNull,
        );
      },
    );

    test(
      'paths are compared in the encoded form the request is sent with',
      () async {
        final s = store()..setCookies('a=1; Path=/foo%2Fbar', requestUri: api);
        expect(
          await s.cookieHeaderFor(Uri.parse('https://example.com/foo%2Fbar')),
          'a=1',
        );
        expect(
          await s.cookieHeaderFor(Uri.parse('https://example.com/foo')),
          isNull,
        );
        // `%76` is an escaped unreserved character, which `Uri` normalizes to
        // `v`; the request goes out as `/private`, so the cookie applies.
        final p = store()..setCookies('b=2; Path=/private', requestUri: api);
        final normalized = Uri.parse('https://example.com/pri%76ate');
        expect(normalized.path, '/private');
        expect(await p.cookieHeaderFor(normalized), 'b=2');
      },
    );

    test(
      'without a Path the cookie applies to the request directory',
      () async {
        final s = store()..setCookies('a=1', requestUri: api);
        expect(
          await s.cookieHeaderFor(
            Uri.parse('https://example.com/cdk-blocks/other'),
          ),
          'a=1',
        );
        expect(
          await s.cookieHeaderFor(Uri.parse('https://example.com/auth')),
          isNull,
        );
      },
    );

    test('a cookie is only sent to the host that set it', () async {
      final s = store()..setCookies('a=1; Path=/', requestUri: api);
      expect(await s.cookieHeaderFor(Uri.parse('https://other.com/')), isNull);
      expect(
        await s.cookieHeaderFor(Uri.parse('https://sub.example.com/')),
        isNull,
      );
    });

    test('Max-Age=0 deletes a stored cookie', () async {
      final s = store()
        ..setCookies('a=1; Path=/', requestUri: api)
        ..setCookies('a=; Max-Age=0; Path=/', requestUri: api);
      expect(s.cookies, isEmpty);
      expect(await s.cookieHeaderFor(api), isNull);
    });

    test('an empty value deletes a stored cookie', () async {
      final s = store()
        ..setCookies('a=1; Path=/', requestUri: api)
        ..setCookies('a=; Path=/', requestUri: api);
      expect(s.cookies, isEmpty);
      expect(await s.cookieHeaderFor(api), isNull);
    });

    test('an empty value is not stored', () async {
      final s = store()..setCookies('a=; Path=/', requestUri: api);
      expect(s.cookies, isEmpty);
      expect(await s.cookieHeaderFor(api), isNull);
    });

    test('a past Expires deletes a stored cookie', () async {
      final s = store()
        ..setCookies('a=1; Path=/', requestUri: api)
        ..setCookies(
          'a=; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Path=/',
          requestUri: api,
        );
      expect(await s.cookieHeaderFor(api), isNull);
    });

    test('a cookie expires once its Max-Age has passed', () async {
      var clock = now;
      final s = InMemorySessionStore(clock: () => clock)
        ..setCookies('a=1; Max-Age=60; Path=/', requestUri: api);
      expect(await s.cookieHeaderFor(api), 'a=1');
      clock = now.add(const Duration(seconds: 59));
      expect(await s.cookieHeaderFor(api), 'a=1');
      clock = now.add(const Duration(seconds: 60));
      expect(await s.cookieHeaderFor(api), isNull);
    });

    test('a future Expires is kept until it passes', () async {
      var clock = now;
      final s = InMemorySessionStore(clock: () => clock)
        ..setCookies(
          'a=1; Expires=Wed, 01-Jan-30 12:00:30 GMT; Path=/',
          requestUri: api,
        );
      expect(await s.cookieHeaderFor(api), 'a=1');
      clock = now.add(const Duration(seconds: 30));
      expect(await s.cookieHeaderFor(api), isNull);
    });

    test('an Expires date does not split a joined Set-Cookie header', () async {
      final s = store()
        ..setCookies('a=1; Path=/', requestUri: api)
        ..setCookies(
          'a=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT, '
          'c=3; Path=/; Expires=Wed, 01 Jan 2031 00:00:00 GMT, d=4; Path=/',
          requestUri: api,
        );
      expect(s.cookies, {'c': '3', 'd': '4'});
      expect(await s.cookieHeaderFor(api), 'c=3; d=4');
    });

    test('Max-Age takes precedence over Expires', () async {
      final s = store()
        ..setCookies(
          'a=1; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Max-Age=60; Path=/',
          requestUri: api,
        );
      expect(await s.cookieHeaderFor(api), 'a=1');
    });

    test(
      'same-named cookies from different hosts or paths are kept apart',
      () async {
        final s = store()
          ..setCookies('a=3; Path=/foo', requestUri: api)
          ..setCookies('a=1; Path=/', requestUri: api)
          ..setCookies(
            'a=2; Path=/',
            requestUri: Uri.parse('https://other.com/'),
          );
        expect(
          await s.cookieHeaderFor(Uri.parse('https://example.com/')),
          'a=1',
        );
        expect(await s.cookieHeaderFor(Uri.parse('https://other.com/')), 'a=2');
        expect(
          await s.cookieHeaderFor(Uri.parse('https://example.com/foo')),
          'a=3; a=1',
        );
      },
    );

    test('the most specific path is listed first', () async {
      final s = store()
        ..setCookies('a=api; Path=/cdk-blocks/api', requestUri: api)
        ..setCookies(
          'a=root; Path=/',
          requestUri: Uri.parse('https://example.com/other'),
        );
      expect(await s.cookieHeaderFor(api), 'a=api; a=root');
    });

    test(
      'a cookie replaces same-named cookies that match the request',
      () async {
        final s = store()
          ..setCookies('a=1', requestUri: api)
          ..setCookies('a=2; Path=/', requestUri: api);
        expect(
          await s.cookieHeaderFor(
            Uri.parse('https://example.com/cdk-blocks/x'),
          ),
          'a=2',
        );
      },
    );
  });
}

/// An [InMemoryTokenStore] whose reads throw while [unreadable] is set, as an
/// iOS Keychain item does while the device is locked.
class _LockableTokenStore extends InMemoryTokenStore {
  bool unreadable = true;

  @override
  Future<String?> get(String key) {
    if (unreadable) throw StateError('locked');
    return super.get(key);
  }
}
