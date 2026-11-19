// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import 'dart:convert';

import 'package:blocks_runtime/blocks_runtime.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:test/test.dart';

/// Answers an exchange with bearer tokens named after the block whose route
/// was called, and a sign-out with 200.
MockClient _server() => MockClient((req) async {
  final block = req.url.path.contains('/sso/') ? 'sso' : 'main';
  if (req.url.path.endsWith('/signout')) return http.Response('{}', 200);
  return http.Response(
    jsonEncode({
      'user': {'userId': block, 'username': block},
      'accessToken': '$block-at',
      'refreshToken': '$block-rt',
      'expiresIn': 3600,
    }),
    200,
  );
});

/// The descriptor a block's `getClient()` returns, for the block at [base].
Map<String, dynamic> _descriptor(String base, String provider) => {
  '__blocks': 'oidc/client',
  'providers': [provider],
  'providerConfigs': <String, dynamic>{},
  'exchangePath': '$base/exchange',
  'signOutPath': '$base/signout',
  'callbackPath': '$base/callback',
};

Future<void> _exchange(OidcClient client, String provider) => client.exchange(
  code: 'c',
  verifier: 'v',
  callbackUrl: 'http://localhost:3001/cdk-blocks/auth/callback',
  provider: provider,
  state: 's',
  nonce: '',
);

/// An [InMemoryTokenStore] that records every key written to it.
class _RecordingTokenStore extends InMemoryTokenStore {
  final keys = <String>{};

  @override
  Future<void> set(String key, String value) {
    keys.add(key);
    return super.set(key, value);
  }
}

void main() {
  group('OidcClient token keys', () {
    test('two blocks sharing a token store keep their own tokens', () async {
      final store = _RecordingTokenStore();
      OidcClient client(String base, String provider) => OidcClient.fromJson(
        _descriptor(base, provider),
        baseUrl: 'http://localhost:3001/cdk-blocks/api',
        tokenStore: store,
        httpClient: _server(),
      );
      final main = client('/cdk-blocks/auth', 'google');
      final sso = client('/cdk-blocks/auth/sso', 'corp');

      await _exchange(main, 'google');
      await _exchange(sso, 'corp');

      expect(await main.getAccessToken(), 'main-at');
      expect(await sso.getAccessToken(), 'sso-at');
      expect(await store.get('/cdk-blocks/auth/refresh_token'), 'main-rt');
      expect(await store.get('/cdk-blocks/auth/sso/refresh_token'), 'sso-rt');
      expect(await store.get('/cdk-blocks/auth/provider'), 'google');
      expect(await store.get('/cdk-blocks/auth/sso/provider'), 'corp');
      expect(
        store.keys.where((k) => !k.startsWith('/cdk-blocks/auth/')),
        isEmpty,
      );

      await sso.signOut();

      expect(await sso.getAccessToken(), isNull);
      expect(await main.getAccessToken(), 'main-at');
    });

    test('a client built with the constructor keeps unprefixed keys', () async {
      final store = InMemoryTokenStore();
      final client = OidcClient(
        exchangePath: '/cdk-blocks/auth/exchange',
        refreshPath: '/cdk-blocks/auth/exchange/refresh',
        signOutPath: '/cdk-blocks/auth/signout',
        providers: ['google'],
        providerConfigs: const {},
        baseUrl: 'http://localhost:3001/cdk-blocks/api',
        tokenStore: store,
        httpClient: _server(),
      );

      await _exchange(client, 'google');

      expect(await store.get('access_token'), 'main-at');
      expect(await store.get('refresh_token'), 'main-rt');
    });
  });

  group('OidcClient token key migration', () {
    /// A store holding the tokens an earlier version wrote, unprefixed.
    Future<InMemoryTokenStore> legacyStore() async {
      final store = InMemoryTokenStore();
      await store.set('access_token', 'old-at');
      await store.set('refresh_token', 'old-rt');
      final inAnHour = DateTime.now().add(const Duration(hours: 1));
      await store.set('expires_at', '${inAnHour.millisecondsSinceEpoch}');
      return store;
    }

    OidcClient client(TokenStore store, String base, String provider) =>
        OidcClient.fromJson(
          _descriptor(base, provider),
          baseUrl: 'http://localhost:3001/cdk-blocks/api',
          tokenStore: store,
          httpClient: _server(),
        );

    test('moves unprefixed tokens to the default block', () async {
      final store = await legacyStore();
      final main = client(store, '/cdk-blocks/auth', 'google');

      expect(await main.getAccessToken(), 'old-at');
      expect(await store.get('/cdk-blocks/auth/refresh_token'), 'old-rt');
      expect(await store.get('access_token'), isNull);
      expect(await store.get('refresh_token'), isNull);
      expect(await store.get('expires_at'), isNull);
    });

    test('a block used first leaves them for the default block', () async {
      final store = await legacyStore();
      final sso = client(store, '/cdk-blocks/auth/sso', 'corp');
      expect(await sso.getAccessToken(), isNull);
      expect(await store.get('access_token'), 'old-at');

      final main = client(store, '/cdk-blocks/auth', 'google');
      expect(await main.getAccessToken(), 'old-at');
      expect(await sso.getAccessToken(), isNull);
      expect(await store.get('access_token'), isNull);
    });

    test('with both blocks built first, the default block gets them', () async {
      final store = await legacyStore();
      final main = client(store, '/cdk-blocks/auth', 'google');
      final sso = client(store, '/cdk-blocks/auth/sso', 'corp');

      expect(await sso.getAccessToken(), isNull);
      expect(await main.getAccessToken(), 'old-at');
      expect(await store.get('/cdk-blocks/auth/sso/access_token'), isNull);
      expect(await store.get('access_token'), isNull);
    });

    test('a store with no default block keeps them where they are', () async {
      final store = await legacyStore();
      final sso = client(store, '/cdk-blocks/auth/sso', 'corp');

      expect(await sso.getAccessToken(), isNull);
      expect(await store.get('access_token'), 'old-at');
      expect(await store.get('refresh_token'), 'old-rt');
    });

    test('never overwrites tokens the block already has', () async {
      final store = await legacyStore();
      await store.set('/cdk-blocks/auth/refresh_token', 'new-rt');
      final main = client(store, '/cdk-blocks/auth', 'google');

      await main.signOut();

      expect(await store.get('refresh_token'), 'old-rt');
      expect(await store.get('/cdk-blocks/auth/refresh_token'), isNull);
    });

    test('moves /aws-blocks/-prefixed tokens to each block', () async {
      final store = InMemoryTokenStore();
      await store.set('/aws-blocks/auth/access_token', 'main-old');
      await store.set('/aws-blocks/auth/session_cookies', '["s"]');
      await store.set('/aws-blocks/auth/sso/access_token', 'sso-old');
      final inAnHour = DateTime.now().add(const Duration(hours: 1));
      for (final base in ['/aws-blocks/auth', '/aws-blocks/auth/sso']) {
        await store.set(
          '$base/expires_at',
          '${inAnHour.millisecondsSinceEpoch}',
        );
      }
      final main = client(store, '/cdk-blocks/auth', 'google');
      final sso = client(store, '/cdk-blocks/auth/sso', 'corp');

      expect(await sso.getAccessToken(), 'sso-old');
      expect(await main.getAccessToken(), 'main-old');
      expect(await store.get('/cdk-blocks/auth/session_cookies'), '["s"]');
      expect(await store.get('/aws-blocks/auth/access_token'), isNull);
      expect(await store.get('/aws-blocks/auth/sso/access_token'), isNull);
    });

    test('prefers /aws-blocks/-prefixed tokens over unprefixed ones', () async {
      final store = await legacyStore();
      await store.set('/aws-blocks/auth/access_token', 'newer-at');
      await store.set(
        '/aws-blocks/auth/expires_at',
        (await store.get('expires_at'))!,
      );
      final main = client(store, '/cdk-blocks/auth', 'google');

      expect(await main.getAccessToken(), 'newer-at');
      expect(await store.get('access_token'), 'old-at');
    });

    test(
      'a default block pinned to /aws-blocks/auth takes the unprefixed tokens',
      () async {
        final store = await legacyStore();
        final main = client(store, '/aws-blocks/auth', 'google');

        expect(await main.getAccessToken(), 'old-at');
        expect(await store.get('/aws-blocks/auth/refresh_token'), 'old-rt');
        expect(await store.get('access_token'), isNull);
      },
    );

    test(
      'a client built with the constructor reads them where they are',
      () async {
        final store = await legacyStore();
        final legacy = OidcClient(
          exchangePath: '/cdk-blocks/auth/exchange',
          refreshPath: '/cdk-blocks/auth/exchange/refresh',
          signOutPath: '/cdk-blocks/auth/signout',
          providers: ['google'],
          providerConfigs: const {},
          baseUrl: 'http://localhost:3001/cdk-blocks/api',
          tokenStore: store,
          httpClient: _server(),
        );

        expect(await legacy.getAccessToken(), 'old-at');
        expect(await store.get('access_token'), 'old-at');
      },
    );
  });
}
