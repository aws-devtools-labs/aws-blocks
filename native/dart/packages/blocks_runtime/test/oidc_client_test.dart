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
            'expiresAt':
                DateTime.now().add(Duration(hours: 1)).millisecondsSinceEpoch,
            'user': {
              'userId': 'u1',
              'username': 'alice',
              'groups': ['admin']
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
      expect(user.userId, 'u1');
      expect(user.username, 'alice');
      expect(user.groups, ['admin']);
      expect(await store.get('access_token'), 'at_123');
      expect(await store.get('refresh_token'), 'rt_456');
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
            'expiresAt':
                DateTime.now().add(Duration(hours: 1)).millisecondsSinceEpoch,
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
              .toString());

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

      final mockClient = MockClient((_) async => http.Response(
            jsonEncode({
              'accessToken': 'at_refreshed',
              'expiresAt':
                  DateTime.now().add(Duration(hours: 1)).millisecondsSinceEpoch,
            }),
            200,
          ));

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

  group('OidcClient restore', () {
    test('emits OidcSignedOut when no tokens stored', () async {
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

      final states = <OidcAuthState>[];
      client.authStateChanges.listen(states.add);

      await client.restore();
      await Future.delayed(Duration.zero);
      expect(states.last, isA<OidcSignedOut>());
    });

    test('emits OidcSignedIn when valid JWT token exists', () async {
      final store = InMemoryTokenStore();
      // Create a fake JWT with payload
      final payload = base64Url.encode(utf8.encode(jsonEncode({
        'sub': 'user-1',
        'username': 'bob',
        'groups': ['dev'],
      })));
      final fakeJwt = 'header.$payload.signature';
      await store.set('access_token', fakeJwt);
      await store.set('refresh_token', 'rt_valid');
      await store.set(
          'expires_at',
          (DateTime.now().add(Duration(hours: 1)).millisecondsSinceEpoch)
              .toString());

      final client = OidcClient(
        exchangePath: '/auth/exchange',
        refreshPath: '/auth/refresh',
        signOutPath: '/auth/signout',
        providers: [],
        providerConfigs: {},
        baseUrl: 'http://localhost:3000',
        tokenStore: store,
      );

      final states = <OidcAuthState>[];
      client.authStateChanges.listen(states.add);

      await client.restore();
      await Future.delayed(Duration.zero);
      expect(states.last, isA<OidcSignedIn>());
      final signedIn = states.last as OidcSignedIn;
      expect(signedIn.user.userId, 'user-1');
      expect(signedIn.user.username, 'bob');
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
  });
}
