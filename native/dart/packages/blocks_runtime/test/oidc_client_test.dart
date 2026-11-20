// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import 'dart:async';
import 'dart:convert';

import 'package:crypto/crypto.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:blocks_runtime/blocks_runtime.dart';
import 'package:test/test.dart';

/// A [TransportException] for the `offline` [http.ClientException] the
/// tests' clients throw, with that error as its cause.
final _offline = isA<TransportException>()
    .having((e) => e.statusCode, 'statusCode', isNull)
    .having((e) => e.message, 'message', 'offline')
    .having((e) => e.cause, 'cause', isA<http.ClientException>());

void main() {
  group('OidcClient PKCE', () {
    test('generateVerifier produces url-safe base64 without padding', () {
      final verifier = OidcClient.generateVerifier();
      expect(verifier, isNotEmpty);
      expect(verifier, isNot(contains('=')));
      expect(verifier, isNot(contains('+')));
      expect(verifier, isNot(contains('/')));
    });

    test('generateNonce produces url-safe base64 without padding', () {
      final nonce = OidcClient.generateNonce();
      expect(nonce, isNotEmpty);
      expect(nonce, isNot(contains('=')));
      expect(nonce, isNot(contains('+')));
      expect(nonce, isNot(contains('/')));
    });

    test('generateChallenge is SHA-256 of verifier in base64url', () {
      final verifier = 'test-verifier-value';
      final challenge = OidcClient.generateChallenge(verifier);
      // Manually compute expected
      final digest = sha256.convert(utf8.encode(verifier));
      final expected = base64Url.encode(digest.bytes).replaceAll('=', '');
      expect(challenge, expected);
    });
  });

  group('OidcClient exchange', () {
    test('posts code and stores tokens', () async {
      final store = InMemoryTokenStore();
      Map<String, dynamic>? sentBody;

      final mockClient = MockClient((req) async {
        sentBody = jsonDecode(req.body) as Map<String, dynamic>;
        return http.Response(
          jsonEncode({
            'accessToken': 'at_123',
            'refreshToken': 'rt_456',
            'expiresIn': 3600,
            'user': {
              'userId': 'u1',
              'username': 'alice',
              'groups': ['admin'],
            },
          }),
          200,
        );
      });

      final client = OidcClient(
        exchangePath: '/auth/exchange',
        refreshPath: '/auth/refresh',
        signOutPath: '/auth/signout',
        providers: ['google'],
        providerConfigs: {},
        baseUrl: 'http://localhost:3000',
        tokenStore: store,
        httpClient: mockClient,
      );

      final user = await client.exchange(
        code: 'auth_code',
        verifier: 'verifier',
        callbackUrl: 'myapp://callback',
        provider: 'google',
        state: 'test_state',
        nonce: 'test_nonce',
      );

      expect(sentBody!['code'], 'auth_code');
      expect(sentBody!['verifier'], 'verifier');
      expect(sentBody!['callbackUrl'], 'myapp://callback');
      expect(sentBody!['provider'], 'google');
      expect(sentBody!['state'], 'test_state');
      expect(sentBody!['nonce'], 'test_nonce');
      expect(sentBody!['tokens'], isFalse);
      expect(user.userId, 'u1');
      expect(user.username, 'alice');
      expect(user.groups, ['admin']);
      expect(await store.get('access_token'), 'at_123');
      expect(await store.get('refresh_token'), 'rt_456');
      expect(await store.get('provider'), 'google');
      _expectExpiresInAboutAnHour(await store.get('expires_at'));
    });
  });

  group('OidcClient auth origin', () {
    // The auth routes resolve against the base URL cut at its first
    // `cdk-blocks` (or legacy `aws-blocks`) path segment, which keeps an API
    // Gateway stage.
    Future<String> exchangeUrlFor(String baseUrl) async {
      Uri? sent;
      final client = OidcClient(
        exchangePath: '/cdk-blocks/auth/exchange',
        refreshPath: '/cdk-blocks/auth/exchange/refresh',
        signOutPath: '/cdk-blocks/auth/signout',
        providers: ['google'],
        providerConfigs: {},
        baseUrl: baseUrl,
        tokenStore: InMemoryTokenStore(),
        httpClient: MockClient((req) async {
          sent = req.url;
          return http.Response(
            jsonEncode({
              'user': {'userId': 'u1', 'username': 'alice'},
            }),
            200,
          );
        }),
      );
      await client.exchange(
        code: 'c',
        verifier: 'v',
        callbackUrl: 'cb',
        provider: 'google',
        state: 's',
        nonce: '',
      );
      return sent.toString();
    }

    test('keeps an API Gateway stage', () async {
      expect(
        await exchangeUrlFor(
          'https://x.execute-api.us-east-1.amazonaws.com/prod/cdk-blocks/api',
        ),
        'https://x.execute-api.us-east-1.amazonaws.com/prod/cdk-blocks/auth/exchange',
      );
    });

    test('gives the origin for a URL with no stage', () async {
      expect(
        await exchangeUrlFor('https://d1.cloudfront.net/cdk-blocks/api'),
        'https://d1.cloudfront.net/cdk-blocks/auth/exchange',
      );
    });

    test('gives the origin for a doubled RPC prefix', () async {
      expect(
        await exchangeUrlFor(
          'https://d1.cloudfront.net/cdk-blocks/api/cdk-blocks/api',
        ),
        'https://d1.cloudfront.net/cdk-blocks/auth/exchange',
      );
    });

    test('cuts at a legacy aws-blocks segment', () async {
      expect(
        await exchangeUrlFor('https://host/prod/aws-blocks/api'),
        'https://host/prod/cdk-blocks/auth/exchange',
      );
    });

    test('keeps a URL with no cdk-blocks segment, port included', () async {
      expect(
        await exchangeUrlFor('http://localhost:3001'),
        'http://localhost:3001/cdk-blocks/auth/exchange',
      );
      expect(
        await exchangeUrlFor('http://localhost:3001/'),
        'http://localhost:3001/cdk-blocks/auth/exchange',
      );
    });

    test('cuts only at a segment that is exactly cdk-blocks', () async {
      expect(
        await exchangeUrlFor('https://host/cdk-blocks-x/cdk-blocks/api'),
        'https://host/cdk-blocks-x/cdk-blocks/auth/exchange',
      );
    });
  });

  group('OidcClient refresh', () {
    test('sends refresh token and stores new access token', () async {
      final store = InMemoryTokenStore();
      await store.set('refresh_token', 'rt_old');

      await store.set('provider', 'google');
      Map<String, dynamic>? body;

      final mockClient = MockClient((req) async {
        body = jsonDecode(req.body) as Map<String, dynamic>;
        // The auth block's refresh response.
        return http.Response(
          jsonEncode({
            'accessToken': 'at_new',
            'refreshToken': 'rt_new',
            'expiresIn': 3600,
          }),
          200,
        );
      });

      final client = OidcClient(
        exchangePath: '/auth/exchange',
        refreshPath: '/auth/refresh',
        signOutPath: '/auth/signout',
        providers: [],
        providerConfigs: {},
        baseUrl: 'http://localhost:3000',
        tokenStore: store,
        httpClient: mockClient,
      );

      await client.refresh();
      expect(body, {'refreshToken': 'rt_old', 'provider': 'google'});
      expect(await store.get('access_token'), 'at_new');
      // The refresh token rotates.
      expect(await store.get('refresh_token'), 'rt_new');
      _expectExpiresInAboutAnHour(await store.get('expires_at'));
      // Not expired, so the next read doesn't refresh again.
      expect(await client.getAccessToken(), 'at_new');
    });

    test('omits provider when none was stored', () async {
      final store = InMemoryTokenStore();
      await store.set('refresh_token', 'rt_old');
      Map<String, dynamic>? body;
      final client = OidcClient(
        exchangePath: '/auth/exchange',
        refreshPath: '/auth/refresh',
        signOutPath: '/auth/signout',
        providers: [],
        providerConfigs: {},
        baseUrl: 'http://localhost:3000',
        tokenStore: store,
        httpClient: MockClient((req) async {
          body = jsonDecode(req.body) as Map<String, dynamic>;
          return http.Response(
            jsonEncode({'accessToken': 'at_new', 'expiresIn': 60}),
            200,
          );
        }),
      );
      await client.refresh();
      expect(body, {'refreshToken': 'rt_old'});
      // Without a rotated token, the old one is kept.
      expect(await store.get('refresh_token'), 'rt_old');
    });

    test('falls back to an absolute expiresAt', () async {
      final store = InMemoryTokenStore();
      await store.set('refresh_token', 'rt_old');
      final expiresAt = DateTime.now()
          .add(Duration(hours: 1))
          .millisecondsSinceEpoch;
      final client = OidcClient(
        exchangePath: '/auth/exchange',
        refreshPath: '/auth/refresh',
        signOutPath: '/auth/signout',
        providers: [],
        providerConfigs: {},
        baseUrl: 'http://localhost:3000',
        tokenStore: store,
        httpClient: MockClient(
          (_) async => http.Response(
            jsonEncode({'accessToken': 'at_new', 'expiresAt': expiresAt}),
            200,
          ),
        ),
      );
      await client.refresh();
      expect(await store.get('expires_at'), '$expiresAt');
    });

    test('emits OidcSignedOut on refresh failure', () async {
      final store = InMemoryTokenStore();
      await store.set('refresh_token', 'rt_expired');

      final mockClient = MockClient((_) async => http.Response('', 401));

      final client = OidcClient(
        exchangePath: '/auth/exchange',
        refreshPath: '/auth/refresh',
        signOutPath: '/auth/signout',
        providers: [],
        providerConfigs: {},
        baseUrl: 'http://localhost:3000',
        tokenStore: store,
        httpClient: mockClient,
      );

      final states = <OidcAuthState>[];
      // Skip the state a new listener gets first: these tests check changes.
      client.authStateChanges.skip(1).listen(states.add);

      await client.refresh();
      await Future.delayed(Duration.zero);
      expect(states.last, isA<OidcSignedOut>());
      expect(await store.get('access_token'), isNull);
    });

    ({OidcClient client, InMemoryTokenStore store, List<OidcAuthState> states})
    refreshClient(Future<http.Response> Function(http.Request) handler) {
      final store = InMemoryTokenStore();
      final client = OidcClient(
        exchangePath: '/auth/exchange',
        refreshPath: '/auth/refresh',
        signOutPath: '/auth/signout',
        providers: ['google'],
        providerConfigs: {},
        baseUrl: 'http://localhost:3000',
        tokenStore: store,
        httpClient: MockClient(handler),
      );
      final states = <OidcAuthState>[];
      // Skip the state a new listener gets first: these tests check changes.
      client.authStateChanges.skip(1).listen(states.add);
      return (client: client, store: store, states: states);
    }

    for (final status in [400, 401]) {
      test('$status: clears the tokens and signs out', () async {
        final t = refreshClient((_) async => http.Response('{}', status));
        await t.store.set('access_token', 'at');
        await t.store.set('refresh_token', 'rt');

        await t.client.refresh();
        await Future<void>.delayed(Duration.zero);
        expect(t.states, [isA<OidcSignedOut>()]);
        expect(await t.store.get('refresh_token'), isNull);
      });
    }

    for (final status in [403, 429, 500, 503]) {
      test('$status: throws and keeps the tokens and the state', () async {
        final t = refreshClient(
          (_) async => http.Response(jsonEncode({'name': 'Busy'}), status),
        );
        await t.store.set('access_token', 'at');
        await t.store.set('refresh_token', 'rt');

        await expectLater(
          t.client.refresh(),
          throwsA(
            isA<ApiException>()
                .having((e) => e.status, 'status', status)
                .having((e) => e.name, 'name', 'Busy'),
          ),
        );
        await Future<void>.delayed(Duration.zero);
        expect(t.states, isEmpty);
        expect(await t.store.get('access_token'), 'at');
        expect(await t.store.get('refresh_token'), 'rt');
      });
    }

    test('a transport error throws and keeps the tokens', () async {
      final t = refreshClient(
        (_) async => throw http.ClientException('offline'),
      );
      await t.store.set('refresh_token', 'rt');

      await expectLater(t.client.refresh(), throwsA(_offline));
      await Future<void>.delayed(Duration.zero);
      expect(t.states, isEmpty);
      expect(await t.store.get('refresh_token'), 'rt');
    });

    test('a sign-out during the refresh keeps it signed out', () async {
      final refreshed = Completer<http.Response>();
      final t = refreshClient(
        (req) async => req.url.path.endsWith('/signout')
            ? http.Response('{}', 200)
            : refreshed.future,
      );
      await t.store.set('refresh_token', 'rt');

      final refresh = t.client.refresh();
      await Future<void>.delayed(Duration.zero);
      await t.client.signOut();
      refreshed.complete(
        http.Response(
          jsonEncode({
            'accessToken': 'late-at',
            'refreshToken': 'late-rt',
            'expiresIn': 3600,
          }),
          200,
        ),
      );
      await refresh;

      expect(await t.store.get('access_token'), isNull);
      expect(await t.store.get('refresh_token'), isNull);
      expect(t.client.authState, isA<OidcSignedOut>());
    });

    test('a sign-in during the refresh keeps its tokens', () async {
      final refreshed = Completer<http.Response>();
      final t = refreshClient(
        (req) async => req.url.path.endsWith('/refresh')
            ? refreshed.future
            : http.Response(
                jsonEncode({
                  'accessToken': 'new-at',
                  'refreshToken': 'new-rt',
                  'expiresIn': 3600,
                  'user': {'userId': 'u1', 'username': 'alice'},
                }),
                200,
              ),
      );
      await t.store.set('refresh_token', 'rt');

      final refresh = t.client.refresh();
      await Future<void>.delayed(Duration.zero);
      await t.client.exchange(
        code: 'code',
        verifier: 'verifier',
        callbackUrl: 'myapp://callback',
        provider: 'google',
        state: 'state',
        nonce: 'nonce',
      );
      refreshed.complete(http.Response('{}', 401));
      await refresh;

      expect(await t.store.get('refresh_token'), 'new-rt');
      expect(t.client.authState, isA<OidcSignedIn>());
    });
  });

  group('OidcClient getAccessToken', () {
    test('returns stored token when not expired', () async {
      final store = InMemoryTokenStore();
      await store.set('access_token', 'at_valid');
      await store.set(
        'expires_at',
        (DateTime.now().add(Duration(hours: 1)).millisecondsSinceEpoch)
            .toString(),
      );

      final client = OidcClient(
        exchangePath: '/auth/exchange',
        refreshPath: '/auth/refresh',
        signOutPath: '/auth/signout',
        providers: [],
        providerConfigs: {},
        baseUrl: 'http://localhost:3000',
        tokenStore: store,
      );

      expect(await client.getAccessToken(), 'at_valid');
    });

    test('returns null when not authenticated', () async {
      final store = InMemoryTokenStore();
      final client = OidcClient(
        exchangePath: '/auth/exchange',
        refreshPath: '/auth/refresh',
        signOutPath: '/auth/signout',
        providers: [],
        providerConfigs: {},
        baseUrl: 'http://localhost:3000',
        tokenStore: store,
      );

      expect(await client.getAccessToken(), isNull);
    });
  });

  group('OidcClient onAuthFailure', () {
    test('triggers refresh', () async {
      final store = InMemoryTokenStore();
      await store.set('access_token', 'at_old');
      await store.set('refresh_token', 'rt_valid');

      final mockClient = MockClient(
        (_) async => http.Response(
          jsonEncode({'accessToken': 'at_refreshed', 'expiresIn': 3600}),
          200,
        ),
      );

      final client = OidcClient(
        exchangePath: '/auth/exchange',
        refreshPath: '/auth/refresh',
        signOutPath: '/auth/signout',
        providers: [],
        providerConfigs: {},
        baseUrl: 'http://localhost:3000',
        tokenStore: store,
        httpClient: mockClient,
      );

      await client.onAuthFailure();
      expect(await store.get('access_token'), 'at_refreshed');
    });

    test('rethrows a refresh failure other than a rejected token', () async {
      final store = InMemoryTokenStore();
      await store.set('refresh_token', 'rt_valid');
      final client = OidcClient(
        exchangePath: '/auth/exchange',
        refreshPath: '/auth/refresh',
        signOutPath: '/auth/signout',
        providers: [],
        providerConfigs: {},
        baseUrl: 'http://localhost:3000',
        tokenStore: store,
        httpClient: MockClient((_) async => http.Response('', 502)),
      );

      await expectLater(
        client.onAuthFailure(),
        throwsA(isA<ApiException>().having((e) => e.status, 'status', 502)),
      );
      expect(await store.get('refresh_token'), 'rt_valid');
      expect(client.authState, isA<OidcLoading>());
    });
  });

  group('OidcClient signInDirect', () {
    test('a callback with no state when none is stored throws the state '
        'error', () async {
      final store = InMemoryTokenStore();
      final client = OidcClient(
        exchangePath: '/cdk-blocks/auth/exchange',
        refreshPath: '/cdk-blocks/auth/exchange/refresh',
        signOutPath: '/cdk-blocks/auth/signout',
        providers: ['google'],
        providerConfigs: {
          'google': ProviderConfig(
            authorizeUrl: 'https://idp.example.com/authorize',
            clientId: 'cid',
            scopes: const ['openid'],
            kind: 'oidc-builtin',
          ),
        },
        baseUrl: 'http://localhost:3000',
        tokenStore: store,
        httpClient: MockClient((_) async => http.Response('{}', 200)),
      );

      await expectLater(
        client.signInDirect(
          'google',
          launcher: _StateDroppingLauncher(store),
          redirectUri: 'myapp://auth',
        ),
        throwsA(isA<StateError>()),
      );
    });
  });

  group('OidcClient signInDirect callback errors', () {
    OidcClient directClient(TokenStore store) => OidcClient(
      exchangePath: '/cdk-blocks/auth/exchange',
      refreshPath: '/cdk-blocks/auth/exchange/refresh',
      signOutPath: '/cdk-blocks/auth/signout',
      providers: ['google'],
      providerConfigs: {
        'google': ProviderConfig(
          authorizeUrl: 'https://idp.example.com/authorize',
          clientId: 'cid',
          scopes: const ['openid'],
          kind: 'oidc-builtin',
        ),
      },
      baseUrl: 'http://localhost:3000',
      tokenStore: store,
      httpClient: MockClient((_) async => http.Response('{}', 200)),
    );

    Future<void> expectPkceCleared(InMemoryTokenStore store) async {
      for (final key in ['oidc_verifier', 'oidc_state', 'oidc_nonce']) {
        expect(await store.get(key), isNull, reason: key);
      }
    }

    test(
      'an IdP error with the right state throws OidcCallbackException',
      () async {
        final store = InMemoryTokenStore();
        await expectLater(
          directClient(store).signInDirect(
            'google',
            launcher: _ErrorLauncher(),
            redirectUri: 'myapp://auth',
          ),
          throwsA(
            isA<OidcCallbackException>().having(
              (e) => e.message,
              'message',
              'IdP error: access_denied',
            ),
          ),
        );
        await expectPkceCleared(store);
      },
    );

    test('a launcher that throws leaves no PKCE values behind', () async {
      final store = InMemoryTokenStore();
      await expectLater(
        directClient(store).signInDirect(
          'google',
          launcher: _ThrowingLauncher(),
          redirectUri: 'myapp://auth',
        ),
        throwsA(isA<StateError>()),
      );
      await expectPkceCleared(store);
    });

    test('a state mismatch leaves no PKCE values behind', () async {
      final store = InMemoryTokenStore();
      await expectLater(
        directClient(store).signInDirect(
          'google',
          launcher: _ForgedStateLauncher(),
          redirectUri: 'myapp://auth',
        ),
        throwsA(isA<StateError>()),
      );
      await expectPkceCleared(store);
    });
  });

  group('OidcClient restore', () {
    OidcClient sessionClient(
      MockClient http, {
      TokenStore? store,
      SessionStore? session,
    }) => OidcClient(
      exchangePath: '/cdk-blocks/auth/exchange',
      refreshPath: '/cdk-blocks/auth/exchange/refresh',
      signOutPath: '/cdk-blocks/auth/signout',
      providers: ['google'],
      providerConfigs: {},
      baseUrl: 'http://localhost:3000/cdk-blocks/api',
      tokenStore: store ?? InMemoryTokenStore(),
      sessionStore: session,
      httpClient: http,
    );

    test(
      '200: emits OidcSignedIn with the server user and returns it',
      () async {
        final session = InMemorySessionStore()
          ..setCookies(
            'blocks_session=live; Path=/',
            requestUri: Uri.parse('http://localhost:3000/'),
          );
        http.Request? sent;
        final client = sessionClient(
          MockClient((req) async {
            sent = req;
            return http.Response(
              jsonEncode({
                'user': {
                  'userId': 'https://idp.example.com:sub-1',
                  'username': 'bob',
                  'groups': ['dev'],
                },
              }),
              200,
            );
          }),
          session: session,
        );
        final states = <OidcAuthState>[];
        // Skip the state a new listener gets first: these tests check changes.
        client.authStateChanges.skip(1).listen(states.add);

        final user = await client.restore();
        await Future<void>.delayed(Duration.zero);

        expect(sent!.method, 'GET');
        expect(
          sent!.url.toString(),
          'http://localhost:3000/cdk-blocks/auth/session',
        );
        expect(sent!.headers['cookie'], 'blocks_session=live');
        expect(sent!.headers.containsKey('authorization'), isFalse);
        expect(user!.userId, 'https://idp.example.com:sub-1');
        expect(user.groups, ['dev']);
        expect(states, [isA<OidcSignedIn>()]);
        expect((states.single as OidcSignedIn).user.username, 'bob');
      },
    );

    test('sends a stored access token as a bearer token', () async {
      final store = InMemoryTokenStore();
      await store.set('access_token', 'opaque-token');
      await store.set(
        'expires_at',
        DateTime.now()
            .add(const Duration(hours: 1))
            .millisecondsSinceEpoch
            .toString(),
      );
      String? authorization;
      final client = sessionClient(
        MockClient((req) async {
          authorization = req.headers['authorization'];
          return http.Response(
            jsonEncode({
              'user': {'userId': 'u1', 'username': 'bob'},
            }),
            200,
          );
        }),
        store: store,
      );
      await client.restore();
      expect(authorization, 'Bearer opaque-token');
    });

    test('leaves out an expired access token', () async {
      final store = InMemoryTokenStore();
      await store.set('access_token', 'old-token');
      await store.set('expires_at', '1');
      final headers = <String, String>{};
      final client = sessionClient(
        MockClient((req) async {
          headers.addAll(req.headers);
          return http.Response(
            jsonEncode({
              'user': {'userId': 'u1', 'username': 'bob'},
            }),
            200,
          );
        }),
        store: store,
      );
      await client.restore();
      expect(headers, isNot(contains('authorization')));
    });

    for (final (label, body) in [
      ('a body that is not JSON', '<html>ok</html>'),
      (
        'a user without its required fields',
        jsonEncode({'user': <String, dynamic>{}}),
      ),
    ]) {
      test('200 with $label throws, leaves the state', () async {
        final client = sessionClient(
          MockClient((_) async => http.Response(body, 200)),
        );
        final states = <OidcAuthState>[];
        // Skip the state a new listener gets first: these tests check changes.
        client.authStateChanges.skip(1).listen(states.add);
        await expectLater(
          client.restore(),
          throwsA(
            isA<TransportException>().having(
              (e) => e.statusCode,
              'statusCode',
              200,
            ),
          ),
        );
        await Future<void>.delayed(Duration.zero);
        expect(states, isEmpty);
      });
    }

    test('a descriptor client reads the session route beside its exchange '
        'route', () async {
      Uri? url;
      final client = OidcClient.fromJson(
        {
          'providers': ['corp'],
          'providerConfigs': <String, dynamic>{},
          'exchangePath': '/custom/oidc/exchange',
          'signOutPath': '/custom/oidc/signout',
        },
        baseUrl: 'http://localhost:3000',
        tokenStore: InMemoryTokenStore(),
        httpClient: MockClient((req) async {
          url = req.url;
          return http.Response('', 401);
        }),
      );
      expect(client.sessionPath, '/custom/oidc/session');
      expect(await client.restore(), isNull);
      expect(url.toString(), 'http://localhost:3000/custom/oidc/session');
    });

    test('an exchangePath with no / does not throw at construction', () {
      final client = OidcClient(
        exchangePath: 'exchange',
        refreshPath: 'refresh',
        signOutPath: 'signout',
        providers: const [],
        providerConfigs: const {},
        baseUrl: 'http://localhost:3000',
        tokenStore: InMemoryTokenStore(),
        callbackPath: 'callback',
      );
      expect(client.sessionPath, '/session');
    });

    test('401: clears tokens, emits OidcSignedOut and returns null', () async {
      final store = InMemoryTokenStore();
      await store.set('access_token', 'at');
      await store.set('refresh_token', 'rt');
      await store.set('expires_at', '1');
      await store.set('provider', 'google');
      final client = sessionClient(
        MockClient(
          (_) async => http.Response(
            jsonEncode({
              'error': 'Not signed in',
              'name': 'NotAuthenticatedException',
            }),
            401,
          ),
        ),
        store: store,
      );
      final states = <OidcAuthState>[];
      // Skip the state a new listener gets first: these tests check changes.
      client.authStateChanges.skip(1).listen(states.add);

      expect(await client.restore(), isNull);
      await Future<void>.delayed(Duration.zero);

      expect(states, [isA<OidcSignedOut>()]);
      expect(await store.get('access_token'), isNull);
      expect(await store.get('refresh_token'), isNull);
      expect(await store.get('expires_at'), isNull);
      expect(await store.get('provider'), isNull);
    });

    test('404: throws an error naming the missing session route', () async {
      final client = sessionClient(
        MockClient((_) async => http.Response('Not Found', 404)),
      );
      final states = <OidcAuthState>[];
      // Skip the state a new listener gets first: these tests check changes.
      client.authStateChanges.skip(1).listen(states.add);

      await expectLater(
        client.restore(),
        throwsA(
          isA<ApiException>()
              .having((e) => e.status, 'status', 404)
              .having((e) => e.message, 'message', contains('session route')),
        ),
      );
      await Future<void>.delayed(Duration.zero);
      expect(states, isEmpty);
    });

    test('any other status throws and leaves the state unchanged', () async {
      final store = InMemoryTokenStore();
      await store.set('access_token', 'at');
      final client = sessionClient(
        MockClient(
          (_) async => http.Response(
            jsonEncode({'error': 'boom', 'name': 'InternalError'}),
            500,
          ),
        ),
        store: store,
      );
      final states = <OidcAuthState>[];
      // Skip the state a new listener gets first: these tests check changes.
      client.authStateChanges.skip(1).listen(states.add);

      await expectLater(
        client.restore(),
        throwsA(
          isA<ApiException>()
              .having((e) => e.status, 'status', 500)
              .having((e) => e.name, 'name', 'InternalError')
              .having(
                (e) => e.message,
                'message',
                'Session request failed: HTTP 500: boom',
              ),
        ),
      );
      await Future<void>.delayed(Duration.zero);
      expect(states, isEmpty);
      expect(await store.get('access_token'), 'at');
    });

    test('a transport error throws and leaves the state unchanged', () async {
      final client = sessionClient(
        MockClient((_) async => throw http.ClientException('offline')),
      );
      final states = <OidcAuthState>[];
      // Skip the state a new listener gets first: these tests check changes.
      client.authStateChanges.skip(1).listen(states.add);

      await expectLater(client.restore(), throwsA(_offline));
      await Future<void>.delayed(Duration.zero);
      expect(states, isEmpty);
    });

    test('derives the session route from a custom callbackPath', () async {
      Uri? url;
      final client = OidcClient(
        exchangePath: '/cdk-blocks/auth/sso/exchange',
        refreshPath: '/cdk-blocks/auth/sso/exchange/refresh',
        signOutPath: '/cdk-blocks/auth/sso/signout',
        callbackPath: '/cdk-blocks/auth/sso/callback',
        providers: ['google'],
        providerConfigs: {},
        baseUrl: 'https://host/prod/cdk-blocks/api',
        tokenStore: InMemoryTokenStore(),
        httpClient: MockClient((req) async {
          url = req.url;
          return http.Response('{}', 401);
        }),
      );
      expect(client.sessionPath, '/cdk-blocks/auth/sso/session');
      await client.restore();
      expect(url.toString(), 'https://host/prod/cdk-blocks/auth/sso/session');
    });
  });

  group('OidcClient signOut', () {
    final origin = Uri.parse('http://localhost:3000/');

    Future<
      ({
        OidcClient client,
        InMemoryTokenStore store,
        InMemorySessionStore session,
        List<OidcAuthState> states,
        List<http.Request> sent,
      })
    >
    signOutClient(Future<http.Response> Function(http.Request) handler) async {
      final store = InMemoryTokenStore();
      await store.set('access_token', 'at');
      await store.set('refresh_token', 'rt');
      final session = InMemorySessionStore()
        ..setCookies('blocks_session=live; Path=/', requestUri: origin);
      final sent = <http.Request>[];
      final client = OidcClient(
        exchangePath: '/cdk-blocks/auth/exchange',
        refreshPath: '/cdk-blocks/auth/exchange/refresh',
        signOutPath: '/cdk-blocks/auth/signout',
        providers: ['google'],
        providerConfigs: {},
        baseUrl: 'http://localhost:3000/cdk-blocks/api',
        tokenStore: store,
        sessionStore: session,
        httpClient: MockClient((req) {
          sent.add(req);
          return handler(req);
        }),
      );
      final states = <OidcAuthState>[];
      // Skip the state a new listener gets first: these tests check changes.
      client.authStateChanges.skip(1).listen(states.add);
      return (
        client: client,
        store: store,
        session: session,
        states: states,
        sent: sent,
      );
    }

    test('posts ?format=json and returns the logout URL', () async {
      final t = await signOutClient(
        (_) async => http.Response(
          jsonEncode({'logoutUrl': 'https://idp.example.com/logout?x=1'}),
          200,
          headers: {'set-cookie': _clearSession},
        ),
      );

      final logoutUrl = await t.client.signOut();
      await Future<void>.delayed(Duration.zero);

      final req = t.sent.single;
      expect(req.method, 'POST');
      expect(
        req.url.toString(),
        'http://localhost:3000/cdk-blocks/auth/signout?format=json',
      );
      expect(req.headers['content-type'], startsWith('application/json'));
      expect(req.headers['cookie'], 'blocks_session=live');
      expect(jsonDecode(req.body), <String, dynamic>{});
      expect(logoutUrl, Uri.parse('https://idp.example.com/logout?x=1'));
      expect(t.states, [isA<OidcSignedOut>()]);
      expect(await t.store.get('access_token'), isNull);
      expect(await t.store.get('refresh_token'), isNull);
      expect(t.session.cookies, isEmpty);
    });

    test('sends {} even when a refresh token is stored', () async {
      final t = await signOutClient((_) async => http.Response('{}', 200));
      expect(await t.store.get('refresh_token'), 'rt');
      expect(await t.client.signOut(), isNull);
      expect(t.sent.single.body, '{}');
    });

    test('returns null for a 204 with no body', () async {
      final t = await signOutClient((_) async => http.Response('', 204));
      expect(await t.client.signOut(), isNull);
      await Future<void>.delayed(Duration.zero);
      expect(t.states, [isA<OidcSignedOut>()]);
    });

    test(
      '503 SignOutIncompleteException: signs out locally, then throws',
      () async {
        final t = await signOutClient(
          (_) async => http.Response(
            jsonEncode({
              'error': 'Sign-out did not complete',
              'name': 'SignOutIncompleteException',
            }),
            503,
            headers: {'set-cookie': _clearSession},
          ),
        );

        await expectLater(
          t.client.signOut(),
          throwsA(
            isA<ApiException>()
                .having((e) => e.status, 'status', 503)
                .having(
                  (e) => isBlocksError(e, 'SignOutIncompleteException'),
                  'isBlocksError(SignOutIncompleteException)',
                  isTrue,
                ),
          ),
        );
        await Future<void>.delayed(Duration.zero);
        expect(t.states, [isA<OidcSignedOut>()]);
        expect(await t.store.get('refresh_token'), isNull);
        expect(t.session.cookies, isEmpty);
      },
    );

    for (final status in [400, 404, 500, 503]) {
      test('$status: signs out locally, then throws', () async {
        final t = await signOutClient(
          (_) async => http.Response(jsonEncode({'error': 'no'}), status),
        );

        await expectLater(
          t.client.signOut(),
          throwsA(
            isA<ApiException>().having((e) => e.status, 'status', status),
          ),
        );
        await Future<void>.delayed(Duration.zero);
        expect(t.states, [isA<OidcSignedOut>()]);
        expect(await t.store.get('access_token'), isNull);
        expect(await t.store.get('refresh_token'), isNull);
        // Not a cookie this client's sign-in set.
        expect(t.session.cookies['blocks_session'], 'live');
      });
    }

    test('keeps the cookies of other Auth blocks in the store', () async {
      // Each Auth block names its session cookie auth_<its id>.
      final session = InMemorySessionStore()
        ..setCookies('auth_app-auth=main; Path=/', requestUri: origin)
        ..setCookies('auth_app-sso=other; Path=/', requestUri: origin);
      OidcClient block(String base, String cookie) => OidcClient.fromJson(
        {
          '__blocks': 'oidc/client',
          'providers': ['google'],
          'providerConfigs': <String, dynamic>{},
          'exchangePath': '$base/exchange',
          'signOutPath': '$base/signout',
          'callbackPath': '$base/callback',
        },
        baseUrl: 'http://localhost:3000/cdk-blocks/api',
        tokenStore: InMemoryTokenStore(),
        sessionStore: session,
        httpClient: MockClient(
          (_) async => http.Response(
            '{}',
            200,
            headers: {'set-cookie': '$cookie=; Path=/; Max-Age=0'},
          ),
        ),
      );

      await block('/cdk-blocks/auth/sso', 'auth_app-sso').signOut();

      expect(session.cookies, {'auth_app-auth': 'main'});
      await block('/cdk-blocks/auth', 'auth_app-auth').signOut();
      expect(session.cookies, isEmpty);
    });

    /// A client of the block at `/cdk-blocks/auth/sso`, signed in through
    /// its exchange, which set the block's session cookie `auth_app-sso`,
    /// on a session store that also holds another block's cookie. Its
    /// sign-out route is answered by [signOut].
    Future<
      ({
        OidcClient client,
        InMemoryTokenStore store,
        InMemorySessionStore session,
        List<OidcAuthState> states,
      })
    >
    signedIn(Future<http.Response> Function() signOut) async {
      final store = InMemoryTokenStore();
      final session = InMemorySessionStore()
        ..setCookies('auth_app-auth=main; Path=/', requestUri: origin);
      final client = OidcClient.fromJson(
        {
          '__blocks': 'oidc/client',
          'providers': ['google'],
          'exchangePath': '/cdk-blocks/auth/sso/exchange',
        },
        baseUrl: 'http://localhost:3000/cdk-blocks/api',
        tokenStore: store,
        sessionStore: session,
        httpClient: MockClient((req) async {
          if (req.url.path.endsWith('/signout')) return signOut();
          return http.Response(
            jsonEncode({
              'user': {'userId': 'u1', 'username': 'alice'},
              'accessToken': 'at',
              'refreshToken': 'rt',
              'expiresIn': 3600,
            }),
            200,
            headers: {'set-cookie': 'auth_app-sso=sso; Path=/; HttpOnly'},
          );
        }),
      );
      await client.exchange(
        code: 'code',
        verifier: 'verifier',
        callbackUrl: 'myapp://callback',
        provider: 'google',
        state: 'state',
        nonce: 'nonce',
      );
      final states = <OidcAuthState>[];
      // Skip the state a new listener gets first: these tests check changes.
      client.authStateChanges.skip(1).listen(states.add);
      return (client: client, store: store, session: session, states: states);
    }

    final failures = <String, (Future<http.Response> Function(), Matcher)>{
      'a transport error': (
        () async => throw http.ClientException('offline'),
        _offline,
      ),
      'a 500': (
        () async => http.Response(jsonEncode({'name': 'Boom'}), 500),
        isA<ApiException>()
            .having((e) => e.status, 'status', 500)
            .having((e) => e.name, 'name', 'Boom'),
      ),
      'a cancelled request': (
        () async => throw http.RequestAbortedException(),
        isA<http.RequestAbortedException>(),
      ),
    };
    for (final MapEntry(key: name, value: (answer, error))
        in failures.entries) {
      test('$name signs out locally, removes only this block\'s cookie, '
          'then throws', () async {
        final t = await signedIn(answer);
        expect(t.session.cookies, {
          'auth_app-auth': 'main',
          'auth_app-sso': 'sso',
        });

        await expectLater(t.client.signOut(), throwsA(error));
        await Future<void>.delayed(Duration.zero);

        expect(t.states, [isA<OidcSignedOut>()]);
        expect(t.client.authState, isA<OidcSignedOut>());
        expect(await t.store.get('/cdk-blocks/auth/sso/access_token'), isNull);
        expect(await t.store.get('/cdk-blocks/auth/sso/refresh_token'), isNull);
        expect(t.session.cookies, {'auth_app-auth': 'main'});
      });
    }

    test('a descriptor naming its session cookie removes exactly that cookie, '
        'even after a relaunch', () async {
      // An older client's sign-in recorded no cookie names: the app
      // relaunches with the cookies but nothing else.
      final store = InMemoryTokenStore();
      final session = InMemorySessionStore()
        ..setCookies('auth_app-auth=main; Path=/', requestUri: origin)
        ..setCookies('auth_app-sso=sso; Path=/', requestUri: origin)
        ..setCookies('other=keep; Path=/', requestUri: origin);
      final client = OidcClient.fromJson(
        {
          '__blocks': 'oidc/client',
          'providers': ['google'],
          'exchangePath': '/cdk-blocks/auth/sso/exchange',
          'sessionCookieName': 'auth_app-sso',
        },
        baseUrl: 'http://localhost:3000/cdk-blocks/api',
        tokenStore: store,
        sessionStore: session,
        httpClient: MockClient(
          (_) async => throw http.ClientException('offline'),
        ),
      );
      expect(client.sessionCookieName, 'auth_app-sso');

      await expectLater(client.signOut(), throwsA(_offline));

      expect(session.cookies, {'auth_app-auth': 'main', 'other': 'keep'});
      expect(client.authState, isA<OidcSignedOut>());
    });

    test('without sessionCookieName, a relaunch keeps the cookie', () async {
      final session = InMemorySessionStore()
        ..setCookies('auth_app-sso=sso; Path=/', requestUri: origin);
      final client = OidcClient.fromJson(
        {
          '__blocks': 'oidc/client',
          'exchangePath': '/cdk-blocks/auth/sso/exchange',
        },
        baseUrl: 'http://localhost:3000/cdk-blocks/api',
        tokenStore: InMemoryTokenStore(),
        sessionStore: session,
        httpClient: MockClient((_) async => http.Response('{}', 500)),
      );
      expect(client.sessionCookieName, isNull);

      await expectLater(client.signOut(), throwsA(isA<ApiException>()));
      expect(session.cookies, {'auth_app-sso': 'sso'});
    });

    test('a restore overtaken by a failed sign-out stays signed out', () async {
      final session = Completer<http.Response>();
      final store = InMemoryTokenStore();
      final client = OidcClient(
        exchangePath: '/cdk-blocks/auth/exchange',
        refreshPath: '/cdk-blocks/auth/exchange/refresh',
        signOutPath: '/cdk-blocks/auth/signout',
        providers: ['google'],
        providerConfigs: {},
        baseUrl: 'http://localhost:3000/cdk-blocks/api',
        tokenStore: store,
        httpClient: MockClient((req) async {
          if (req.url.path.endsWith('/session')) return session.future;
          throw http.ClientException('offline');
        }),
      );

      final restored = client.restore();
      await Future<void>.delayed(Duration.zero);
      await expectLater(client.signOut(), throwsA(_offline));
      session.complete(
        http.Response(
          jsonEncode({
            'user': {'userId': 'u1', 'username': 'a'},
          }),
          200,
        ),
      );

      expect(await restored, isNull);
      expect(client.authState, isA<OidcSignedOut>());
    });
  });

  group('OidcUser.fromJson', () {
    test('reads the optional fields the server sends', () {
      final user = OidcUser.fromJson({
        'userId': 'https://idp.example.com:sub-1',
        'username': 'alice',
        'displayName': 'Alice',
        'userSub': 'https://idp.example.com:sub-1',
        'groups': ['admins'],
        'attributes': {'email': 'alice@example.com'},
        'signInProvider': 'google',
      });
      expect(user.displayName, 'Alice');
      expect(user.userSub, 'https://idp.example.com:sub-1');
      expect(user.groups, ['admins']);
      expect(user.attributes, {'email': 'alice@example.com'});
      expect(user.signInProvider, 'google');
    });

    test('leaves them null or empty when absent', () {
      final user = OidcUser.fromJson({'userId': 'u1', 'username': 'bob'});
      expect(user.displayName, isNull);
      expect(user.userSub, isNull);
      expect(user.signInProvider, isNull);
      expect(user.attributes, isNull);
      expect(user.groups, isEmpty);
    });
  });

  group('OidcClient fromJson', () {
    Matcher descriptorError(String message) => throwsA(
      isA<InvalidDescriptorException>()
          .having((e) => e.message, 'message', message)
          .having((e) => e.missingField, 'missingField', 'exchangePath'),
    );

    test('names a missing exchangePath', () {
      expect(
        () => OidcClient.fromJson(
          {
            '__blocks': 'oidc/client',
            'providers': ['google'],
            'sessionPath': '/cdk-blocks/auth/session',
            'signOutPath': '/cdk-blocks/auth/signout',
          },
          baseUrl: 'http://localhost:3001',
          tokenStore: InMemoryTokenStore(),
        ),
        descriptorError(
          "OidcClient for 'oidc/client' is missing the required field "
          "'exchangePath'",
        ),
      );
    });

    test('names a null exchangePath', () {
      expect(
        () => OidcClient.fromJson(
          {'__blocks': 'oidc/client', 'exchangePath': null},
          baseUrl: 'http://localhost:3001',
          tokenStore: InMemoryTokenStore(),
        ),
        descriptorError(
          "OidcClient for 'oidc/client' is missing the required field "
          "'exchangePath'",
        ),
      );
    });

    test('names an exchangePath that is not a string', () {
      expect(
        () => OidcClient.fromJson(
          {'__blocks': 'oidc/client', 'exchangePath': 42},
          baseUrl: 'http://localhost:3001',
          tokenStore: InMemoryTokenStore(),
        ),
        descriptorError(
          "OidcClient for 'oidc/client' expected 'exchangePath' to be a "
          'String, got int',
        ),
      );
    });

    test('derives the routes it is not sent from the exchange route', () {
      final client = OidcClient.fromJson(
        {
          '__blocks': 'oidc/client',
          'exchangePath': '/cdk-blocks/auth/sso/exchange',
        },
        baseUrl: 'http://localhost:3001',
        tokenStore: InMemoryTokenStore(),
      );
      expect(client.providers, isEmpty);
      expect(client.providerConfigs, isEmpty);
      expect(client.refreshPath, '/cdk-blocks/auth/sso/exchange/refresh');
      expect(client.sessionPath, '/cdk-blocks/auth/sso/session');
      expect(client.signOutPath, '/cdk-blocks/auth/sso/signout');
      expect(client.callbackPath, '/cdk-blocks/auth/sso/callback');
      expect(
        client.authorizeParamsBasePath,
        '/cdk-blocks/auth/sso/authorize-params',
      );
    });

    test(
      'reads sessionPath and refreshPath when the descriptor sends them',
      () {
        final client = OidcClient.fromJson(
          {
            '__blocks': 'oidc/client',
            'providers': ['google'],
            'exchangePath': '/custom/exchange',
            'sessionPath': '/custom/me',
            'refreshPath': '/custom/renew',
            'signOutPath': '/custom/logout',
          },
          baseUrl: 'http://localhost:3001',
          tokenStore: InMemoryTokenStore(),
        );
        expect(client.sessionPath, '/custom/me');
        expect(client.refreshPath, '/custom/renew');
        expect(client.signOutPath, '/custom/logout');
      },
    );

    test('accepts a provider config without a kind', () {
      final client = OidcClient.fromJson(
        {
          '__blocks': 'oidc/client',
          'providers': ['google'],
          'providerConfigs': {
            'google': {
              'authorizeUrl': 'https://idp.example.com/authorize',
              'clientId': 'cid',
              'scopes': ['openid'],
            },
          },
          'exchangePath': '/cdk-blocks/auth/exchange',
          'signOutPath': '/cdk-blocks/auth/signout',
        },
        baseUrl: 'http://localhost:3001',
        tokenStore: InMemoryTokenStore(),
      );
      expect(client.providerConfigs['google']!.kind, '');
    });

    test('parses descriptor correctly', () {
      final descriptor = {
        'exchangePath': '/auth/exchange',
        'refreshPath': '/auth/refresh',
        'signOutPath': '/auth/signout',
        'providers': ['google', 'github'],
        'providerConfigs': {
          'google': {
            'authorizeUrl': 'https://accounts.google.com/o/oauth2/v2/auth',
            'clientId': 'client-123',
            'scopes': ['openid', 'profile'],
            'kind': 'oauth2',
          },
        },
      };

      final client = OidcClient.fromJson(
        descriptor,
        baseUrl: 'http://localhost:3000',
        tokenStore: InMemoryTokenStore(),
      );

      expect(client.providers, ['google', 'github']);
      expect(client.providerConfigs['google']!.clientId, 'client-123');
      expect(client.exchangePath, '/auth/exchange');
    });

    test('defaults the relay routes to the auth block\'s /cdk-blocks/auth/* '
        'routes when the descriptor omits them', () {
      final client = OidcClient.fromJson(
        {
          'exchangePath': '/cdk-blocks/auth/exchange',
          'signOutPath': '/cdk-blocks/auth/signout',
          'providers': ['google'],
          'providerConfigs': <String, dynamic>{},
        },
        baseUrl: 'http://localhost:3000/cdk-blocks/api',
        tokenStore: InMemoryTokenStore(),
      );

      // The routes `Auth` serves (packages/bb-auth DESIGN.md → Routes).
      expect(
        client.authorizeParamsBasePath,
        '/cdk-blocks/auth/authorize-params',
      );
      expect(client.callbackPath, '/cdk-blocks/auth/callback');
      expect(client.refreshPath, '/cdk-blocks/auth/exchange/refresh');
      expect(
        OidcClient.defaultAuthorizeParamsBasePath,
        '/cdk-blocks/auth/authorize-params',
      );
      expect(OidcClient.defaultCallbackPath, '/cdk-blocks/auth/callback');
    });

    test('constructor defaults match the descriptor defaults', () {
      final client = OidcClient(
        exchangePath: '/cdk-blocks/auth/exchange',
        refreshPath: '/cdk-blocks/auth/exchange/refresh',
        signOutPath: '/cdk-blocks/auth/signout',
        providers: ['google'],
        providerConfigs: {},
        baseUrl: 'http://localhost:3000/cdk-blocks/api',
        tokenStore: InMemoryTokenStore(),
      );

      expect(
        client.authorizeParamsBasePath,
        OidcClient.defaultAuthorizeParamsBasePath,
      );
      expect(client.callbackPath, OidcClient.defaultCallbackPath);
    });
  });
}

/// Expects a stored `expires_at` about an hour from now, in epoch ms.
void _expectExpiresInAboutAnHour(String? stored) {
  final expiresAt = int.parse(stored!);
  final inAnHour = DateTime.now()
      .add(const Duration(hours: 1))
      .millisecondsSinceEpoch;
  expect((expiresAt - inAnHour).abs(), lessThan(60000));
}

/// The `Set-Cookie` an `Auth` block sends to remove its session cookie.
const _clearSession = 'blocks_session=; Path=/; HttpOnly; Max-Age=0';

/// Returns a callback with no state, after removing the state the client
/// stored, so neither side has one.
class _StateDroppingLauncher implements BrowserLauncher {
  _StateDroppingLauncher(this._store);

  final TokenStore _store;

  @override
  Future<Uri> launch(
    Uri authorizeUrl, {
    required String callbackScheme,
    Future<void>? cancel,
  }) async {
    await _store.delete('oidc_state');
    return Uri.parse('$callbackScheme://auth?code=c');
  }
}

/// Returns an IdP error redirect that carries the issued state.
class _ErrorLauncher implements BrowserLauncher {
  @override
  Future<Uri> launch(
    Uri authorizeUrl, {
    required String callbackScheme,
    Future<void>? cancel,
  }) async {
    final state = Uri.encodeComponent(authorizeUrl.queryParameters['state']!);
    return Uri.parse('$callbackScheme://auth?error=access_denied&state=$state');
  }
}

/// Fails as a launcher does when no browser could be opened.
class _ThrowingLauncher implements BrowserLauncher {
  @override
  Future<Uri> launch(
    Uri authorizeUrl, {
    required String callbackScheme,
    Future<void>? cancel,
  }) => throw StateError('no browser');
}

/// Returns a callback with a state this sign-in didn't issue.
class _ForgedStateLauncher implements BrowserLauncher {
  @override
  Future<Uri> launch(
    Uri authorizeUrl, {
    required String callbackScheme,
    Future<void>? cancel,
  }) async => Uri.parse('$callbackScheme://auth?code=c&state=forged');
}
