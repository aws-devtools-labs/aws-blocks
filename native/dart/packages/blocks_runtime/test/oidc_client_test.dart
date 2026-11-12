import 'dart:convert';

import 'package:crypto/crypto.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:blocks_runtime/blocks_runtime.dart';
import 'package:test/test.dart';

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
            'expiresAt': DateTime.now()
                .add(Duration(hours: 1))
                .millisecondsSinceEpoch,
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
    });
  });

  group('OidcClient auth origin', () {
    // The auth routes resolve against the base URL cut at its first
    // `aws-blocks` path segment, which keeps an API Gateway stage.
    Future<String> exchangeUrlFor(String baseUrl) async {
      Uri? sent;
      final client = OidcClient(
        exchangePath: '/aws-blocks/auth/exchange',
        refreshPath: '/aws-blocks/auth/exchange/refresh',
        signOutPath: '/aws-blocks/auth/signout',
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
          'https://x.execute-api.us-east-1.amazonaws.com/prod/aws-blocks/api',
        ),
        'https://x.execute-api.us-east-1.amazonaws.com/prod/aws-blocks/auth/exchange',
      );
    });

    test('gives the origin for a URL with no stage', () async {
      expect(
        await exchangeUrlFor('https://d1.cloudfront.net/aws-blocks/api'),
        'https://d1.cloudfront.net/aws-blocks/auth/exchange',
      );
    });

    test('gives the origin for a doubled RPC prefix', () async {
      expect(
        await exchangeUrlFor(
          'https://d1.cloudfront.net/aws-blocks/api/aws-blocks/api',
        ),
        'https://d1.cloudfront.net/aws-blocks/auth/exchange',
      );
    });

    test('keeps a URL with no aws-blocks segment, port included', () async {
      expect(
        await exchangeUrlFor('http://localhost:3001'),
        'http://localhost:3001/aws-blocks/auth/exchange',
      );
      expect(
        await exchangeUrlFor('http://localhost:3001/'),
        'http://localhost:3001/aws-blocks/auth/exchange',
      );
    });

    test('cuts only at a segment that is exactly aws-blocks', () async {
      expect(
        await exchangeUrlFor('https://host/aws-blocks-x/aws-blocks/api'),
        'https://host/aws-blocks-x/aws-blocks/auth/exchange',
      );
    });
  });

  group('OidcClient refresh', () {
    test('sends refresh token and stores new access token', () async {
      final store = InMemoryTokenStore();
      await store.set('refresh_token', 'rt_old');

      final mockClient = MockClient((req) async {
        final body = jsonDecode(req.body) as Map<String, dynamic>;
        expect(body['refreshToken'], 'rt_old');
        return http.Response(
          jsonEncode({
            'accessToken': 'at_new',
            'expiresAt': DateTime.now()
                .add(Duration(hours: 1))
                .millisecondsSinceEpoch,
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
      expect(await store.get('access_token'), 'at_new');
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
      client.authStateChanges.listen(states.add);

      await client.refresh();
      await Future.delayed(Duration.zero);
      expect(states.last, isA<OidcSignedOut>());
      expect(await store.get('access_token'), isNull);
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
          jsonEncode({
            'accessToken': 'at_refreshed',
            'expiresAt': DateTime.now()
                .add(Duration(hours: 1))
                .millisecondsSinceEpoch,
          }),
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
  });

  group('OidcClient signIn', () {
    test('a callback with no state when none is stored throws the state '
        'error', () async {
      final store = InMemoryTokenStore();
      final client = OidcClient(
        exchangePath: '/aws-blocks/auth/exchange',
        refreshPath: '/aws-blocks/auth/exchange/refresh',
        signOutPath: '/aws-blocks/auth/signout',
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
        client.signIn(
          'google',
          launcher: _StateDroppingLauncher(store),
          redirectUri: 'myapp://auth',
        ),
        throwsA(isA<StateError>()),
      );
    });
  });

  group('OidcClient restore', () {
    OidcClient sessionClient(
      MockClient http, {
      TokenStore? store,
      SessionStore? session,
    }) => OidcClient(
      exchangePath: '/aws-blocks/auth/exchange',
      refreshPath: '/aws-blocks/auth/exchange/refresh',
      signOutPath: '/aws-blocks/auth/signout',
      providers: ['google'],
      providerConfigs: {},
      baseUrl: 'http://localhost:3000/aws-blocks/api',
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
        client.authStateChanges.listen(states.add);

        final user = await client.restore();
        await Future<void>.delayed(Duration.zero);

        expect(sent!.method, 'GET');
        expect(
          sent!.url.toString(),
          'http://localhost:3000/aws-blocks/auth/session',
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
        client.authStateChanges.listen(states.add);
        await expectLater(
          client.restore(),
          throwsA(
            isA<OidcRequestException>().having(
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
      client.authStateChanges.listen(states.add);

      expect(await client.restore(), isNull);
      await Future<void>.delayed(Duration.zero);

      expect(states, [isA<OidcSignedOut>()]);
      expect(await store.get('access_token'), isNull);
      expect(await store.get('refresh_token'), isNull);
      expect(await store.get('expires_at'), isNull);
    });

    test('404: throws an error naming the missing session route', () async {
      final client = sessionClient(
        MockClient((_) async => http.Response('Not Found', 404)),
      );
      final states = <OidcAuthState>[];
      client.authStateChanges.listen(states.add);

      await expectLater(
        client.restore(),
        throwsA(
          isA<OidcRequestException>()
              .having((e) => e.statusCode, 'statusCode', 404)
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
      client.authStateChanges.listen(states.add);

      await expectLater(
        client.restore(),
        throwsA(
          isA<OidcRequestException>()
              .having((e) => e.statusCode, 'statusCode', 500)
              .having((e) => e.errorName, 'errorName', 'InternalError'),
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
      client.authStateChanges.listen(states.add);

      await expectLater(client.restore(), throwsA(isA<http.ClientException>()));
      await Future<void>.delayed(Duration.zero);
      expect(states, isEmpty);
    });

    test('derives the session route from a custom callbackPath', () async {
      Uri? url;
      final client = OidcClient(
        exchangePath: '/aws-blocks/auth/sso/exchange',
        refreshPath: '/aws-blocks/auth/sso/exchange/refresh',
        signOutPath: '/aws-blocks/auth/sso/signout',
        callbackPath: '/aws-blocks/auth/sso/callback',
        providers: ['google'],
        providerConfigs: {},
        baseUrl: 'https://host/prod/aws-blocks/api',
        tokenStore: InMemoryTokenStore(),
        httpClient: MockClient((req) async {
          url = req.url;
          return http.Response('{}', 401);
        }),
      );
      expect(client.sessionPath, '/aws-blocks/auth/sso/session');
      await client.restore();
      expect(url.toString(), 'https://host/prod/aws-blocks/auth/sso/session');
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
        exchangePath: '/aws-blocks/auth/exchange',
        refreshPath: '/aws-blocks/auth/exchange/refresh',
        signOutPath: '/aws-blocks/auth/signout',
        providers: ['google'],
        providerConfigs: {},
        baseUrl: 'http://localhost:3000/aws-blocks/api',
        tokenStore: store,
        sessionStore: session,
        httpClient: MockClient((req) {
          sent.add(req);
          return handler(req);
        }),
      );
      final states = <OidcAuthState>[];
      client.authStateChanges.listen(states.add);
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
        'http://localhost:3000/aws-blocks/auth/signout?format=json',
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
            isA<OidcRequestException>()
                .having((e) => e.statusCode, 'statusCode', 503)
                .having(
                  (e) => e.errorName,
                  'errorName',
                  'SignOutIncompleteException',
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
      test(
        '$status: throws, clears tokens, keeps the cookie and state',
        () async {
          final t = await signOutClient(
            (_) async => http.Response(jsonEncode({'error': 'no'}), status),
          );

          await expectLater(
            t.client.signOut(),
            throwsA(
              isA<OidcRequestException>().having(
                (e) => e.statusCode,
                'statusCode',
                status,
              ),
            ),
          );
          await Future<void>.delayed(Duration.zero);
          expect(t.states, isEmpty);
          expect(await t.store.get('access_token'), isNull);
          expect(await t.store.get('refresh_token'), isNull);
          expect(t.session.cookies['blocks_session'], 'live');
        },
      );
    }

    test('keeps the cookies of other Auth blocks in the store', () async {
      // Each Auth block names its session cookie auth_<its id>.
      final session = InMemorySessionStore()
        ..setCookies('auth_app-auth=main; Path=/', requestUri: origin)
        ..setCookies('auth_app-sso=other; Path=/', requestUri: origin);
      OidcClient block(String base, String cookie) => OidcClient.forAuth(
        BlocksClient(
          baseUrl: 'http://localhost:3000/aws-blocks/api',
          sessionStore: session,
          client: MockClient(
            (_) async => http.Response(
              '{}',
              200,
              headers: {'set-cookie': '$cookie=; Path=/; Max-Age=0'},
            ),
          ),
        ),
        providers: ['google'],
        callbackPath: '$base/callback',
        signOutPath: '$base/signout',
      );

      await block('/aws-blocks/auth/sso', 'auth_app-sso').signOut();

      expect(session.cookies, {'auth_app-auth': 'main'});
      await block('/aws-blocks/auth', 'auth_app-auth').signOut();
      expect(session.cookies, isEmpty);
    });

    test('a transport error throws, clears tokens, keeps the state', () async {
      final t = await signOutClient(
        (_) async => throw http.ClientException('offline'),
      );

      await expectLater(
        t.client.signOut(),
        throwsA(isA<http.ClientException>()),
      );
      await Future<void>.delayed(Duration.zero);
      expect(t.states, isEmpty);
      expect(await t.store.get('refresh_token'), isNull);
      expect(t.session.cookies['blocks_session'], 'live');
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

    test('defaults the relay routes to the auth block\'s /aws-blocks/auth/* '
        'routes when the descriptor omits them', () {
      final client = OidcClient.fromJson(
        {
          'exchangePath': '/aws-blocks/auth/exchange',
          'signOutPath': '/aws-blocks/auth/signout',
          'providers': ['google'],
          'providerConfigs': <String, dynamic>{},
        },
        baseUrl: 'http://localhost:3000/aws-blocks/api',
        tokenStore: InMemoryTokenStore(),
      );

      // The routes `Auth` serves (packages/bb-auth DESIGN.md → Routes).
      expect(
        client.authorizeParamsBasePath,
        '/aws-blocks/auth/authorize-params',
      );
      expect(client.callbackPath, '/aws-blocks/auth/callback');
      expect(client.refreshPath, '/aws-blocks/auth/exchange/refresh');
      expect(
        OidcClient.defaultAuthorizeParamsBasePath,
        '/aws-blocks/auth/authorize-params',
      );
      expect(OidcClient.defaultCallbackPath, '/aws-blocks/auth/callback');
    });

    test('constructor defaults match the descriptor defaults', () {
      final client = OidcClient(
        exchangePath: '/aws-blocks/auth/exchange',
        refreshPath: '/aws-blocks/auth/exchange/refresh',
        signOutPath: '/aws-blocks/auth/signout',
        providers: ['google'],
        providerConfigs: {},
        baseUrl: 'http://localhost:3000/aws-blocks/api',
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

/// The `Set-Cookie` an `Auth` block sends to remove its session cookie.
const _clearSession = 'blocks_session=; Path=/; HttpOnly; Max-Age=0';

/// Returns a callback with no state, after removing the state the client
/// stored, so neither side has one.
class _StateDroppingLauncher implements BrowserLauncher {
  _StateDroppingLauncher(this._store);

  final TokenStore _store;

  @override
  Future<Uri> launch(Uri authorizeUrl, {required String callbackScheme}) async {
    await _store.delete('oidc_state');
    return Uri.parse('$callbackScheme://auth?code=c');
  }
}
