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
  callbackUrl: 'http://localhost:3001/aws-blocks/auth/callback',
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
        baseUrl: 'http://localhost:3001/aws-blocks/api',
        tokenStore: store,
        httpClient: _server(),
      );
      final main = client('/aws-blocks/auth', 'google');
      final sso = client('/aws-blocks/auth/sso', 'corp');

      await _exchange(main, 'google');
      await _exchange(sso, 'corp');

      expect(await main.getAccessToken(), 'main-at');
      expect(await sso.getAccessToken(), 'sso-at');
      expect(await store.get('/aws-blocks/auth/refresh_token'), 'main-rt');
      expect(await store.get('/aws-blocks/auth/sso/refresh_token'), 'sso-rt');
      expect(
        store.keys.where((k) => !k.startsWith('/aws-blocks/auth/')),
        isEmpty,
      );

      await sso.signOut();

      expect(await sso.getAccessToken(), isNull);
      expect(await main.getAccessToken(), 'main-at');
    });

    test('a client built with the constructor keeps unprefixed keys', () async {
      final store = InMemoryTokenStore();
      final client = OidcClient(
        exchangePath: '/aws-blocks/auth/exchange',
        refreshPath: '/aws-blocks/auth/exchange/refresh',
        signOutPath: '/aws-blocks/auth/signout',
        providers: ['google'],
        providerConfigs: const {},
        baseUrl: 'http://localhost:3001/aws-blocks/api',
        tokenStore: store,
        httpClient: _server(),
      );

      await _exchange(client, 'google');

      expect(await store.get('access_token'), 'main-at');
      expect(await store.get('refresh_token'), 'main-rt');
    });
  });
}
