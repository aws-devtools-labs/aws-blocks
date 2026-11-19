// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import 'dart:async';
import 'dart:convert';

import 'package:blocks_runtime/blocks_runtime.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:test/test.dart';

/// A token store whose next read of [key] reads the value at once but
/// returns it only after [release], as a slow secure store would.
class _SlowReadStore extends InMemoryTokenStore {
  _SlowReadStore(this.key);

  final String key;
  final release = Completer<void>();
  final reading = Completer<void>();
  var _held = false;

  @override
  Future<String?> get(String key) async {
    final value = await super.get(key);
    if (key == this.key && !_held) {
      _held = true;
      reading.complete();
      await release.future;
    }
    return value;
  }
}

OidcClient _client(
  TokenStore store,
  Future<http.Response> Function(http.Request) handler,
) => OidcClient(
  exchangePath: '/auth/exchange',
  refreshPath: '/auth/refresh',
  signOutPath: '/auth/signout',
  providers: ['google'],
  providerConfigs: {},
  baseUrl: 'http://localhost:3000',
  tokenStore: store,
  httpClient: MockClient(handler),
);

void main() {
  test(
    'a sign-out during the refresh token read keeps it signed out',
    () async {
      final store = _SlowReadStore('refresh_token');
      await store.set('access_token', 'old-at');
      await store.set('refresh_token', 'old-rt');
      final refreshBodies = <String>[];
      final client = _client(store, (req) async {
        if (req.url.path.endsWith('/signout')) return http.Response('{}', 200);
        refreshBodies.add(req.body);
        return http.Response(
          jsonEncode({'accessToken': 'late-at', 'expiresIn': 3600}),
          200,
        );
      });

      final refresh = client.refresh();
      await store.reading.future;
      await client.signOut();
      store.release.complete();
      await refresh;

      expect(refreshBodies, isEmpty);
      expect(await store.get('access_token'), isNull);
      expect(client.authState, isA<OidcSignedOut>());
    },
  );

  test('callers that join a failing refresh get its error', () async {
    final store = InMemoryTokenStore();
    await store.set('refresh_token', 'rt');
    final gate = Completer<void>();
    final client = _client(store, (_) async {
      await gate.future;
      throw http.ClientException('offline');
    });

    final first = client.refresh();
    final joined = client.refresh();
    gate.complete();

    await expectLater(first, throwsA(isA<TransportException>()));
    await expectLater(joined, throwsA(isA<TransportException>()));
  });

  test('a failing refresh nobody joined reports no unhandled error', () async {
    final store = InMemoryTokenStore();
    await store.set('refresh_token', 'rt');
    final client = _client(
      store,
      (_) async => throw http.ClientException('offline'),
    );
    await expectLater(client.refresh(), throwsA(isA<TransportException>()));
  });
}
