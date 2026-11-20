// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import 'dart:async';
import 'dart:convert';

import 'package:blocks_runtime/blocks_runtime.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:test/test.dart';

/// A [TokenStore] that counts its writes and can be told to fail.
class _RecordingTokenStore implements TokenStore {
  final values = <String, String>{};
  final writes = <String>[];
  var reads = 0;
  Duration writeDelay = Duration.zero;
  Error? failReads;
  Error? failWrites;

  @override
  Future<String?> get(String key) async {
    reads++;
    final failure = failReads;
    if (failure != null) throw failure;
    return values[key];
  }

  @override
  Future<void> set(String key, String value) async {
    if (writeDelay > Duration.zero) await Future<void>.delayed(writeDelay);
    final failure = failWrites;
    if (failure != null) throw failure;
    writes.add('set $key');
    values[key] = value;
  }

  @override
  Future<void> delete(String key) async {
    final failure = failWrites;
    if (failure != null) throw failure;
    writes.add('delete $key');
    values.remove(key);
  }
}

/// A [SessionStore] written by an app: it delegates to an in-memory store.
class _OwnStore implements SessionStore {
  final _inner = InMemorySessionStore();
  var setCalls = 0;

  @override
  Future<String?> cookieHeaderFor(Uri requestUri) =>
      _inner.cookieHeaderFor(requestUri);

  @override
  void setCookies(String? setCookieHeader, {Uri? requestUri}) {
    setCalls++;
    _inner.setCookies(setCookieHeader, requestUri: requestUri);
  }

  @override
  void clear() => _inner.clear();
}

/// Lets queued write-throughs finish. They only await microtasks here.
Future<void> _settle() => Future<void>.delayed(Duration.zero);

final _api = Uri.parse('https://api.example.com/cdk-blocks/api');

/// A JSON-RPC result, with [setCookie] as its `Set-Cookie` header if given.
http.Response _rpc(Object? result, {String? setCookie}) => http.Response(
  jsonEncode({'jsonrpc': '2.0', 'result': result, 'id': 1}),
  200,
  headers: {'content-type': 'application/json', 'set-cookie': ?setCookie},
);

void main() {
  group('PersistentSessionStore writes', () {
    test('a response without Set-Cookie writes nothing', () async {
      final storage = _RecordingTokenStore();
      final store = PersistentSessionStore(store: storage, storageKey: 'k')
        ..setCookies('session=abc; Path=/', requestUri: _api);
      await _settle();
      expect(storage.writes, ['set k']);

      for (var i = 0; i < 5; i++) {
        store.setCookies(null, requestUri: _api);
      }
      await _settle();
      expect(storage.writes, ['set k']);
    });

    test('the same cookie set again writes nothing', () async {
      final storage = _RecordingTokenStore();
      final store = PersistentSessionStore(store: storage, storageKey: 'k')
        ..setCookies('session=abc; Path=/; HttpOnly', requestUri: _api);
      await _settle();
      store.setCookies('session=abc; Path=/; HttpOnly', requestUri: _api);
      await _settle();
      expect(storage.writes, ['set k']);
    });

    test('a changed value or a new cookie is written', () async {
      final storage = _RecordingTokenStore();
      final store = PersistentSessionStore(store: storage, storageKey: 'k')
        ..setCookies('session=abc; Path=/', requestUri: _api);
      await _settle();
      store.setCookies('session=def; Path=/', requestUri: _api);
      await _settle();
      store.setCookies('other=1; Path=/', requestUri: _api);
      await _settle();
      expect(storage.writes, ['set k', 'set k', 'set k']);
      final names = [
        for (final r in jsonDecode(storage.values['k']!) as List<dynamic>)
          (r as Map<String, dynamic>)['name'],
      ];
      expect(names, unorderedEquals(['session', 'other']));
    });

    test('changes made before a write runs are written once', () async {
      final storage = _RecordingTokenStore();
      final store = PersistentSessionStore(store: storage, storageKey: 'k')
        ..setCookies('a=1; Path=/', requestUri: _api)
        ..setCookies('b=2; Path=/', requestUri: _api)
        ..setCookies('c=3; Path=/', requestUri: _api);
      await _settle();
      expect(storage.writes, ['set k']);
      expect(store.cookies, {'a': '1', 'b': '2', 'c': '3'});
      expect(jsonDecode(storage.values['k']!), hasLength(3));
    });

    test('removing the last cookie deletes the stored entry', () async {
      final storage = _RecordingTokenStore();
      final store = PersistentSessionStore(store: storage, storageKey: 'k')
        ..setCookies('session=abc; Path=/', requestUri: _api);
      await _settle();
      store.setCookies('session=; Max-Age=0; Path=/', requestUri: _api);
      await _settle();
      expect(storage.writes, ['set k', 'delete k']);
      expect(storage.values, isEmpty);
    });

    test('a write before load does not replace the stored cookies', () async {
      final storage = _RecordingTokenStore();
      PersistentSessionStore(
        store: storage,
        storageKey: 'k',
      ).setCookies('kept=1; Path=/', requestUri: _api);
      await _settle();

      // A new process sets a cookie before anything loaded the store.
      PersistentSessionStore(
        store: storage,
        storageKey: 'k',
      ).setCookies('added=2; Path=/', requestUri: _api);
      await _settle();

      final reader = PersistentSessionStore(store: storage, storageKey: 'k');
      await reader.load();
      expect(reader.cookies, {'kept': '1', 'added': '2'});
    });

    test('load does not bring back a cookie this store removed', () async {
      final storage = _RecordingTokenStore();
      PersistentSessionStore(
        store: storage,
        storageKey: 'k',
      ).setCookies('session=abc; Path=/', requestUri: _api);
      await _settle();

      final store = PersistentSessionStore(store: storage, storageKey: 'k')
        ..setCookies('session=; Max-Age=0; Path=/', requestUri: _api);
      // The app calls load itself after the server removed the cookie, and
      // before the removal reached storage.
      await store.load();
      expect(store.cookies, isEmpty);
      await _settle();
      expect(storage.values, isEmpty);
    });
  });

  group('PersistentSessionStore errors', () {
    test('a failed write is reported, not thrown, and retried', () async {
      final storage = _RecordingTokenStore()
        ..failWrites = StateError('disk full');
      final reported = <Object>[];
      final store = PersistentSessionStore(
        store: storage,
        storageKey: 'k',
        onPersistError: (error, _) => reported.add(error),
      )..setCookies('session=abc; Path=/', requestUri: _api);
      await _settle();

      expect(reported, [isA<StateError>()]);
      // The session keeps working from memory.
      expect(await store.cookieHeaderFor(_api), 'session=abc');

      // The same cookie again is still a change from what storage holds.
      storage.failWrites = null;
      store.setCookies('session=abc; Path=/', requestUri: _api);
      await _settle();
      expect(storage.writes, ['set k']);
      expect(storage.values['k'], contains('"session"'));
    });

    test('a failed write without a callback does not crash', () async {
      // An error that escaped would fail this test as uncaught.
      final storage = _RecordingTokenStore()
        ..failWrites = StateError('disk full');
      PersistentSessionStore(
        store: storage,
        storageKey: 'k',
      ).setCookies('session=abc; Path=/', requestUri: _api);
      final cleared = PersistentSessionStore(store: storage, storageKey: 'j')
        ..setCookies('session=abc; Path=/', requestUri: _api)
        ..clear();
      await _settle();
      expect(cleared.cookies, isEmpty);
    });

    test('a throwing callback does not crash', () async {
      final storage = _RecordingTokenStore()
        ..failWrites = StateError('disk full');
      PersistentSessionStore(
        store: storage,
        storageKey: 'k',
        onPersistError: (_, _) => throw StateError('callback'),
      ).setCookies('session=abc; Path=/', requestUri: _api);
      await _settle();
    });

    test('an unreadable store blocks writes, keeps requests going, is reported '
        'once, and is read again when a cookie changes', () async {
      final storage = _RecordingTokenStore();
      // Stored by an earlier run, unreadable for now (a locked Keychain).
      PersistentSessionStore(
        store: storage,
        storageKey: 'k',
      ).setCookies('earlier=1; Path=/', requestUri: _api);
      await _settle();
      storage
        ..writes.clear()
        ..reads = 0
        ..failReads = StateError('locked');

      final reported = <Object>[];
      final store = PersistentSessionStore(
        store: storage,
        storageKey: 'k',
        onPersistError: (error, _) => reported.add(error),
      );
      final cookies = <String?>[];
      String? setCookie;
      final client = BlocksClient(
        baseUrl: _api.toString(),
        sessionStore: store,
        client: MockClient((request) async {
          cookies.add(request.headers['cookie']);
          return _rpc('ok', setCookie: setCookie);
        }),
      );

      for (var i = 0; i < 5; i++) {
        expect(await client.call('api.ping', const []), 'ok');
      }
      await _settle();
      expect(storage.reads, 1, reason: 'not read again on every request');
      expect(reported, hasLength(1));
      expect(cookies, everyElement(isNull));

      // A cookie change tries the read again, still failing: not written,
      // not reported a second time.
      setCookie = 'fresh=2; Path=/';
      await client.call('api.ping', const []);
      await _settle();
      expect(storage.reads, 2);
      expect(storage.writes, isEmpty, reason: 'unread, so not overwritten');
      expect(reported, hasLength(1));

      // Once readable, the next change reads the earlier cookie back and
      // writes both.
      storage.failReads = null;
      setCookie = 'fresh=3; Path=/';
      await client.call('api.ping', const []);
      await _settle();
      setCookie = null;
      await client.call('api.ping', const []);
      expect(cookies.last, contains('earlier=1'));
      expect(cookies.last, contains('fresh=3'));
      final restored = PersistentSessionStore(store: storage, storageKey: 'k');
      await restored.load();
      expect(restored.cookies, {'earlier': '1', 'fresh': '3'});
    });

    test(
      'after a failed first read, a request 30 seconds later reads again and '
      'sends the session; requests before that do not touch storage',
      () async {
        final storage = _RecordingTokenStore();
        PersistentSessionStore(
          store: storage,
          storageKey: 'k',
        ).setCookies('blocks_session=s1; Path=/', requestUri: _api);
        await _settle();
        storage
          ..reads = 0
          // The app started while the device was locked.
          ..failReads = StateError('locked');

        var now = DateTime.utc(2030);
        final reported = <Object>[];
        final store = PersistentSessionStore(
          store: storage,
          storageKey: 'k',
          clock: () => now,
          onPersistError: (error, _) => reported.add(error),
        );
        expect(await store.cookieHeaderFor(_api), isNull);
        expect(storage.reads, 1);

        // The device is unlocked; requests inside the backoff still do not
        // read.
        storage.failReads = null;
        for (var i = 0; i < 10; i++) {
          now = now.add(const Duration(seconds: 2));
          expect(await store.cookieHeaderFor(_api), isNull);
        }
        expect(storage.reads, 1, reason: 'no read inside the 30 s backoff');

        now = now.add(const Duration(seconds: 11));
        expect(await store.cookieHeaderFor(_api), 'blocks_session=s1');
        expect(storage.reads, 2);
        expect(reported, hasLength(1));
      },
    );

    test(
      'a read that keeps failing is tried at most every 30 seconds',
      () async {
        final storage = _RecordingTokenStore()
          ..failReads = StateError('locked');
        var now = DateTime.utc(2030);
        final reported = <Object>[];
        final store = PersistentSessionStore(
          store: storage,
          storageKey: 'k',
          clock: () => now,
          onPersistError: (error, _) => reported.add(error),
        );
        for (var i = 0; i < 120; i++) {
          await store.cookieHeaderFor(_api);
          now = now.add(const Duration(seconds: 1));
        }
        // At 0, 30, 60 and 90 seconds.
        expect(storage.reads, 4);
        expect(reported, hasLength(1));
      },
    );

    test(
      'a write that keeps failing is reported once until one succeeds',
      () async {
        final storage = _RecordingTokenStore()
          ..failWrites = StateError('disk full');
        final reported = <Object>[];
        final store = PersistentSessionStore(
          store: storage,
          storageKey: 'k',
          onPersistError: (error, _) => reported.add(error),
        );
        for (var i = 0; i < 3; i++) {
          store.setCookies('n=$i; Path=/', requestUri: _api);
          await _settle();
        }
        expect(reported, hasLength(1));

        storage.failWrites = null;
        store.setCookies('n=ok; Path=/', requestUri: _api);
        await _settle();
        storage.failWrites = StateError('disk full again');
        store.setCookies('n=again; Path=/', requestUri: _api);
        await _settle();
        expect(reported, hasLength(2));
      },
    );

    test(
      'a stored value that is not a cookie list is reported, then deleted',
      () async {
        final storage = _RecordingTokenStore();
        storage.values['k'] = '{not json';
        final reported = <Object>[];
        await PersistentSessionStore(
          store: storage,
          storageKey: 'k',
          onPersistError: (error, _) => reported.add(error),
        ).load();
        expect(reported, [isA<FormatException>()]);
        expect(storage.values, isEmpty);
      },
    );
  });

  group('PersistentSessionStore.flush', () {
    test('completes after the queued writes have reached storage', () async {
      final storage = _RecordingTokenStore()
        ..writeDelay = const Duration(milliseconds: 50);
      final store = PersistentSessionStore(store: storage, storageKey: 'k')
        ..setCookies('a=1; Path=/', requestUri: _api)
        ..setCookies('b=2; Path=/', requestUri: _api);
      expect(storage.values, isEmpty);
      await store.flush();
      expect(jsonDecode(storage.values['k']!), hasLength(2));
    });

    test(
      'completes when nothing is queued, and after a failed write',
      () async {
        final storage = _RecordingTokenStore();
        final store = PersistentSessionStore(
          store: storage,
          storageKey: 'k',
          onPersistError: (_, _) {},
        );
        await store.flush();
        storage.failWrites = StateError('disk full');
        store.setCookies('a=1; Path=/', requestUri: _api);
        await store.flush();
      },
    );
  });

  group('custom stores', () {
    test('a SessionStore of the app\'s own works with BlocksClient', () async {
      final store = _OwnStore();
      String? sent;
      final client = BlocksClient(
        baseUrl: _api.toString(),
        sessionStore: store,
        client: MockClient((request) async {
          sent = request.headers['cookie'];
          return _rpc('ok', setCookie: 'blocks_session=s1; Path=/');
        }),
      );
      await client.call('api.ping', const []);
      await client.call('api.ping', const []);
      expect(sent, 'blocks_session=s1');
      expect(store.setCalls, 2);
    });
  });

  group('first load', () {
    test(
      'a cookie read waits for the stored session, with no load call',
      () async {
        final storage = _RecordingTokenStore();
        PersistentSessionStore(
          store: storage,
        ).setCookies('blocks_session=s1; Path=/', requestUri: _api);
        await _settle();

        // A caller that reads the header straight from a new store, as a client
        // does, gets the saved session: the store reads storage first.
        final store = PersistentSessionStore(store: storage);
        expect(await store.cookieHeaderFor(_api), 'blocks_session=s1');
      },
    );

    test(
      'concurrent requests share one read and all send the cookie',
      () async {
        final storage = _RecordingTokenStore();
        PersistentSessionStore(
          store: storage,
        ).setCookies('blocks_session=s1; Path=/', requestUri: _api);
        await _settle();
        storage.reads = 0;

        final sent = <String?>[];
        final client = BlocksClient(
          baseUrl: _api.toString(),
          sessionStore: PersistentSessionStore(store: storage),
          client: MockClient((request) async {
            sent.add(request.headers['cookie']);
            return _rpc('ok');
          }),
        );
        await Future.wait([
          for (var i = 0; i < 5; i++) client.call('api.ping', const []),
        ]);
        expect(storage.reads, 1);
        expect(sent, List.filled(5, 'blocks_session=s1'));
      },
    );
  });

  group('cold start', () {
    test('a failed sign-out expires the descriptor\'s sessionCookieName in the '
        'persistent store, and it stays gone after a restart', () async {
      final storage = _RecordingTokenStore();
      final origin = Uri.parse('https://api.example.com/');
      // A session from an earlier run: this block's cookie and another's.
      final earlier = PersistentSessionStore(store: storage)
        ..setCookies('blocks_auth=a; Path=/; HttpOnly', requestUri: origin)
        ..setCookies('blocks_sso=b; Path=/; HttpOnly', requestUri: origin);
      await earlier.flush();

      final session = PersistentSessionStore(store: storage);
      final oidc = OidcClient.fromJson(
        const {
          'providers': ['google'],
          'providerConfigs': <String, dynamic>{},
          'exchangePath': '/cdk-blocks/auth/exchange',
          'sessionCookieName': 'blocks_auth',
        },
        baseUrl: _api.toString(),
        tokenStore: InMemoryTokenStore(),
        sessionStore: session,
        httpClient: MockClient((_) async => http.Response('{}', 500)),
      );
      await expectLater(
        oidc.signOut(),
        throwsA(isA<ApiException>().having((e) => e.status, 'status', 500)),
      );
      await session.flush();
      expect(await session.cookieHeaderFor(origin), 'blocks_sso=b');

      final restarted = PersistentSessionStore(store: storage);
      expect(await restarted.cookieHeaderFor(origin), 'blocks_sso=b');
    });

    test('a failed sign-out of one Auth block expires only its cookie, and the '
        'other block is still signed in after a restart', () async {
      final storage = _RecordingTokenStore();
      final origin = Uri.parse('https://api.example.com/');

      OidcClient block(
        String dir,
        PersistentSessionStore session, {
        required String cookie,
        required int signOutStatus,
      }) => OidcClient(
        exchangePath: '/aws-blocks/$dir/exchange',
        refreshPath: '/aws-blocks/$dir/exchange/refresh',
        signOutPath: '/aws-blocks/$dir/signout',
        providers: const ['google'],
        providerConfigs: const {},
        baseUrl: _api.toString(),
        // Its own token store: a client built with the constructor has no
        // per-block key prefix, as one from getClient() does.
        tokenStore: InMemoryTokenStore(),
        sessionStore: session,
        httpClient: MockClient((request) async {
          if (request.url.path.endsWith('/exchange')) {
            return http.Response(
              jsonEncode({
                'user': {'userId': 'u-$dir', 'username': dir, 'groups': []},
              }),
              200,
              headers: {'set-cookie': '$cookie=v; Path=/; HttpOnly'},
            );
          }
          return http.Response('{}', signOutStatus);
        }),
      );

      Future<void> signIn(OidcClient client) => client.exchange(
        code: 'c',
        verifier: 'v',
        callbackUrl: 'https://api.example.com/cdk-blocks/auth/callback',
        provider: 'google',
        state: 's',
        nonce: 'n',
      );

      final session = PersistentSessionStore(store: storage);
      final a = block('auth', session, cookie: 'a_session', signOutStatus: 500);
      final b = block('sso', session, cookie: 'b_session', signOutStatus: 200);
      await signIn(a);
      await signIn(b);
      await session.flush();
      expect(
        await session.cookieHeaderFor(origin),
        allOf(contains('a_session=v'), contains('b_session=v')),
      );

      // The backend refuses the sign-out; the client still signs out
      // locally, removing only the cookie its own sign-in set.
      await expectLater(
        a.signOut(),
        throwsA(isA<ApiException>().having((e) => e.status, 'status', 500)),
      );
      await session.flush();
      expect(await session.cookieHeaderFor(origin), 'b_session=v');

      // The next run reads the same storage.
      final restarted = PersistentSessionStore(store: storage);
      expect(await restarted.cookieHeaderFor(origin), 'b_session=v');
    });

    test('a new client sends the session a previous run stored, without '
        'calling load', () async {
      final storage = _RecordingTokenStore();
      final seen = <String?>[];
      MockClient server() => MockClient((request) async {
        seen.add(request.headers['cookie']);
        final body = jsonDecode(request.body) as Map<String, dynamic>;
        return body['method'] == 'authApi.signIn'
            ? _rpc(null, setCookie: 'blocks_session=s1; Path=/; HttpOnly')
            : _rpc(request.headers['cookie'] == null ? 'out' : 'in');
      });

      final first = BlocksClient(
        baseUrl: _api.toString(),
        sessionStore: PersistentSessionStore(store: storage),
        client: server(),
      );
      await first.call('authApi.signIn', const []);
      await _settle();
      first.close();

      // The next run: a new store over the same storage, as the default is.
      final second = BlocksClient(
        baseUrl: _api.toString(),
        sessionStore: PersistentSessionStore(store: storage),
        client: server(),
      );
      expect(await second.call('authApi.getAuthState', const []), 'in');
      expect(seen.last, 'blocks_session=s1');
    });

    test('the OIDC client sends the stored session after a restart', () async {
      final storage = _RecordingTokenStore();
      PersistentSessionStore(
        store: storage,
      ).setCookies('blocks_session=s1; Path=/; HttpOnly', requestUri: _api);
      await _settle();

      String? sent;
      final oidc = OidcClient(
        exchangePath: '/cdk-blocks/auth/exchange',
        refreshPath: '/cdk-blocks/auth/exchange/refresh',
        signOutPath: '/cdk-blocks/auth/sign-out',
        providers: const [],
        providerConfigs: const {},
        baseUrl: _api.toString(),
        tokenStore: InMemoryTokenStore(),
        sessionStore: PersistentSessionStore(store: storage),
        httpClient: MockClient((request) async {
          sent = request.headers['cookie'];
          return http.Response('{}', 200);
        }),
      );
      await oidc.signOut();
      expect(sent, 'blocks_session=s1');
    });

    test('cookies of two Auth blocks persist and leave separately', () async {
      final storage = _RecordingTokenStore();
      final store = PersistentSessionStore(store: storage)
        ..setCookies('blocks_session_a=1; Path=/; HttpOnly', requestUri: _api)
        ..setCookies('blocks_session_b=2; Path=/; HttpOnly', requestUri: _api);
      await _settle();

      final restarted = PersistentSessionStore(store: storage);
      await restarted.load();
      expect(restarted.cookies, {
        'blocks_session_a': '1',
        'blocks_session_b': '2',
      });

      // One block signs out: its own cookie is removed, the other stays, and
      // that is what the next run sees.
      restarted.setCookies(
        'blocks_session_a=; Max-Age=0; Path=/',
        requestUri: _api,
      );
      await _settle();
      final again = PersistentSessionStore(store: storage);
      await again.load();
      expect(again.cookies, {'blocks_session_b': '2'});
      expect(store.cookies, hasLength(2), reason: 'a separate instance');
    });
  });

  group('defaultSessionStore', () {
    tearDown(() => registerDefaultSessionStore(null));

    test('without a registration, each client gets its own memory store', () {
      final a = BlocksClient(baseUrl: _api.toString());
      final b = BlocksClient(baseUrl: _api.toString());
      expect(a.sessionStore, isA<InMemorySessionStore>());
      expect(identical(a.sessionStore, b.sessionStore), isFalse);
    });

    test('a registered store is created once and shared', () {
      var created = 0;
      registerDefaultSessionStore(() {
        created++;
        return PersistentSessionStore(store: InMemoryTokenStore());
      });
      final a = BlocksClient(baseUrl: _api.toString());
      final b = BlocksClient(baseUrl: _api.toString());
      final oidc = OidcClient.fromJson(
        const {
          'providers': <String>[],
          'providerConfigs': <String, dynamic>{},
          'exchangePath': '/x',
          'signOutPath': '/y',
        },
        baseUrl: _api.toString(),
        tokenStore: InMemoryTokenStore(),
      );
      expect(a.sessionStore, isA<PersistentSessionStore>());
      expect(identical(a.sessionStore, b.sessionStore), isTrue);
      expect(identical(a.sessionStore, oidc.sessionStore), isTrue);
      expect(created, 1);
    });

    test('an explicit store opts a client out', () {
      registerDefaultSessionStore(
        () => PersistentSessionStore(store: InMemoryTokenStore()),
      );
      final client = BlocksClient(
        baseUrl: _api.toString(),
        sessionStore: InMemorySessionStore(),
      );
      expect(client.sessionStore, isA<InMemorySessionStore>());
    });

    test('a different store registered after a client got one throws', () {
      registerDefaultSessionStore(
        () => PersistentSessionStore(store: InMemoryTokenStore()),
      );
      final first = BlocksClient(baseUrl: _api.toString()).sessionStore;
      expect(
        () => registerDefaultSessionStore(
          () => PersistentSessionStore(store: InMemoryTokenStore()),
        ),
        throwsA(
          isA<StateError>().having(
            (e) => e.message,
            'message',
            contains('before creating any'),
          ),
        ),
      );
      // The shared store is unchanged.
      expect(
        identical(BlocksClient(baseUrl: _api.toString()).sessionStore, first),
        isTrue,
      );
    });

    test('registering the same function again is a no-op, even late', () {
      registerDefaultSessionStore(_sharedFactory);
      final first = BlocksClient(baseUrl: _api.toString()).sessionStore;
      registerDefaultSessionStore(_sharedFactory);
      expect(
        identical(BlocksClient(baseUrl: _api.toString()).sessionStore, first),
        isTrue,
      );
    });

    test('a store registered before any client exists replaces the last', () {
      registerDefaultSessionStore(
        () => PersistentSessionStore(store: InMemoryTokenStore()),
      );
      registerDefaultSessionStore(_OwnStore.new);
      expect(
        BlocksClient(baseUrl: _api.toString()).sessionStore,
        isA<_OwnStore>(),
      );
    });

    test('registering null restores the memory default', () {
      registerDefaultSessionStore(
        () => PersistentSessionStore(store: InMemoryTokenStore()),
      );
      registerDefaultSessionStore(null);
      expect(
        BlocksClient(baseUrl: _api.toString()).sessionStore,
        isA<InMemorySessionStore>(),
      );
    });
  });
}

SessionStore _sharedFactory() =>
    PersistentSessionStore(store: InMemoryTokenStore());
