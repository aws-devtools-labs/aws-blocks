// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import 'dart:convert';

import 'package:blocks_runtime/blocks_runtime.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:test/test.dart';

const _descriptor = {
  '__blocks': 'oidc/client',
  'exchangePath': '/cdk-blocks/auth/exchange',
  'providers': ['google'],
  'providerConfigs': {
    'google': {
      'authorizeUrl': 'https://idp.example.com/authorize',
      'clientId': 'cid',
      'scopes': ['openid'],
      'kind': 'oidc-builtin',
    },
  },
};

/// The HTTP client every `http.Client()` made inside [_withAuthRoutes] gets:
/// it counts requests and records whether it was closed.
class _AuthRoutes extends http.BaseClient {
  int sent = 0;
  bool closed = false;

  final _inner = MockClient((request) async {
    if (request.url.path.endsWith('/session')) {
      return http.Response(jsonEncode({'error': 'no session'}), 401);
    }
    return http.Response('{}', 200);
  });

  @override
  Future<http.StreamedResponse> send(http.BaseRequest request) {
    sent++;
    return _inner.send(request);
  }

  @override
  void close() => closed = true;
}

/// A `BlocksClient` whose every call returns [result] as its JSON-RPC
/// result.
BlocksClient _blocksReturning(Object? result) => BlocksClient(
  baseUrl: 'http://localhost:3001/cdk-blocks/api',
  client: MockClient(
    (_) async => http.Response(
      jsonEncode({'jsonrpc': '2.0', 'id': 1, 'result': result}),
      200,
    ),
  ),
);

/// Hydrates the `OidcClient` in [blocks]'s result the way a generated client
/// does: `OidcClient.fromJson` on the result map, with the client's stores
/// and no HTTP client of its own.
Future<OidcClient> _getClient(BlocksClient blocks) async {
  final result = await blocks.call('oidcAuthApi.getClient', []);
  return OidcClient.fromJson(
    result as Map<String, dynamic>,
    baseUrl: blocks.baseUrl,
    tokenStore: blocks.tokenStore,
    sessionStore: blocks.sessionStore,
  );
}

/// Every network call of an `OidcClient`.
final Map<String, Future<Object?> Function(OidcClient)> _calls = {
  'restore': (c) => c.restore(),
  'signOut': (c) => c.signOut(),
  'refresh': (c) => c.refresh(),
  'exchange': (c) => c.exchange(
    code: 'c',
    verifier: 'v',
    callbackUrl: 'myapp://auth',
    provider: 'google',
    state: 's',
    nonce: 'n',
  ),
  'signInDirect': (c) => c.signInDirect(
    'google',
    launcher: _UnusedLauncher(),
    redirectUri: 'myapp://auth',
  ),
  'signIn': (c) =>
      c.signIn('google', launcher: _UnusedLauncher(), relayTo: 'myapp://auth'),
};

void main() {
  group('an OidcClient hydrated from a BlocksClient result', () {
    test('works while the BlocksClient is open', () async {
      final routes = _AuthRoutes();
      await http.runWithClient(() async {
        final oidc = await _getClient(_blocksReturning(_descriptor));
        expect(await oidc.restore(), isNull);
      }, () => routes);
      expect(routes.sent, 1);
      expect(routes.closed, isFalse);
    });

    for (final MapEntry(key: name, value: call) in _calls.entries) {
      test('$name throws ClientClosedException after close()', () async {
        final routes = _AuthRoutes();
        await http.runWithClient(() async {
          final blocks = _blocksReturning(_descriptor);
          final oidc = await _getClient(blocks);
          blocks.close();
          await expectLater(call(oidc), throwsA(isA<ClientClosedException>()));
        }, () => routes);
        expect(routes.sent, 0, reason: 'nothing is sent');
      });
    }

    test('its own HTTP client is closed with the BlocksClient', () async {
      final routes = _AuthRoutes();
      await http.runWithClient(() async {
        final blocks = _blocksReturning(_descriptor);
        await _getClient(blocks);
        expect(routes.closed, isFalse);
        blocks.close();
      }, () => routes);
      expect(routes.closed, isTrue);
    });

    test('a client nested in a model result is tied too', () async {
      final routes = _AuthRoutes();
      await http.runWithClient(() async {
        final blocks = _blocksReturning({
          'session': {'auth': _descriptor},
        });
        final result =
            await blocks.call('api.getSession', []) as Map<String, dynamic>;
        final auth = (result['session'] as Map<String, dynamic>)['auth'];
        final oidc = OidcClient.fromJson(
          auth as Map<String, dynamic>,
          baseUrl: blocks.baseUrl,
          tokenStore: blocks.tokenStore,
        );
        blocks.close();
        await expectLater(
          oidc.restore(),
          throwsA(isA<ClientClosedException>()),
        );
      }, () => routes);
      expect(routes.sent, 0);
    });

    test('hydrated after close() is closed from the start', () async {
      final routes = _AuthRoutes();
      await http.runWithClient(() async {
        final blocks = _blocksReturning(_descriptor);
        final result = await blocks.call('oidcAuthApi.getClient', []);
        blocks.close();
        final oidc = OidcClient.fromJson(
          result as Map<String, dynamic>,
          baseUrl: blocks.baseUrl,
          tokenStore: blocks.tokenStore,
        );
        await expectLater(
          oidc.restore(),
          throwsA(isA<ClientClosedException>()),
        );
      }, () => routes);
      expect(routes.sent, 0);
      expect(routes.closed, isTrue);
    });

    test('a TypedOidcClient wrapping one is tied too', () async {
      await http.runWithClient(() async {
        final blocks = _blocksReturning(_descriptor);
        final oidc = TypedOidcClient<_Provider>(await _getClient(blocks));
        blocks.close();
        await expectLater(
          oidc.signIn(
            _Provider.google,
            launcher: _UnusedLauncher(),
            relayTo: 'myapp://auth',
          ),
          throwsA(isA<ClientClosedException>()),
        );
      }, _AuthRoutes.new);
    });
  });

  group('an OidcClient not hydrated from a BlocksClient result', () {
    test('with its own HTTP client is left alone', () async {
      final routes = _AuthRoutes();
      final blocks = _blocksReturning(_descriptor);
      final result = await blocks.call('oidcAuthApi.getClient', []);
      final oidc = OidcClient.fromJson(
        result as Map<String, dynamic>,
        baseUrl: blocks.baseUrl,
        tokenStore: blocks.tokenStore,
        httpClient: routes,
      );
      blocks.close();
      expect(await oidc.restore(), isNull);
      expect(routes.sent, 1);
      expect(routes.closed, isFalse);
    });

    test('from a descriptor the app built is left alone', () async {
      final routes = _AuthRoutes();
      final blocks = _blocksReturning(_descriptor);
      await http.runWithClient(() async {
        final oidc = OidcClient.fromJson(
          Map<String, dynamic>.of(_descriptor),
          baseUrl: blocks.baseUrl,
          tokenStore: InMemoryTokenStore(),
        );
        blocks.close();
        expect(await oidc.restore(), isNull);
      }, () => routes);
      expect(routes.sent, 1);
      expect(routes.closed, isFalse);
    });

    test('from a copy of a result is left alone', () async {
      final routes = _AuthRoutes();
      await http.runWithClient(() async {
        final blocks = _blocksReturning(_descriptor);
        final result = await blocks.call('oidcAuthApi.getClient', []);
        final oidc = OidcClient.fromJson(
          Map<String, dynamic>.of(result as Map<String, dynamic>),
          baseUrl: blocks.baseUrl,
          tokenStore: InMemoryTokenStore(),
        );
        blocks.close();
        expect(await oidc.restore(), isNull);
      }, () => routes);
      expect(routes.sent, 1);
    });
  });
}

enum _Provider implements OidcProvider {
  google;

  @override
  String get providerName => name;
}

class _UnusedLauncher implements BrowserLauncher {
  @override
  Future<Uri> launch(
    Uri authorizeUrl, {
    required String callbackScheme,
    Future<void>? cancel,
  }) => throw StateError('the launcher must not run on a closed client');
}
