// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import 'dart:async';
import 'dart:convert';

import 'package:blocks_runtime/blocks_runtime.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:test/test.dart';

// A restore() still in flight when a sign-in or sign-out finishes must not
// apply its result: its answer describes the session before that change.

const _user = {'userId': 'u1', 'username': 'alice'};

/// A client whose session route waits for [session] to complete, and whose
/// exchange and sign-out routes answer at once.
({OidcClient client, InMemoryTokenStore store, List<OidcAuthState> states})
_client(Completer<http.Response> session) {
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
      final path = req.url.path;
      if (path.endsWith('/session')) return session.future;
      if (path.endsWith('/signout')) return http.Response('{}', 200);
      return http.Response(
        jsonEncode({
          'accessToken': 'new-at',
          'refreshToken': 'new-rt',
          'expiresIn': 3600,
          'user': _user,
        }),
        200,
      );
    }),
  );
  final states = <OidcAuthState>[];
  // Skip the state a new listener gets first: these tests check changes.
  client.authStateChanges.skip(1).listen(states.add);
  return (client: client, store: store, states: states);
}

Future<OidcUser> _exchange(OidcClient client) => client.exchange(
  code: 'code',
  verifier: 'verifier',
  callbackUrl: 'myapp://callback',
  provider: 'google',
  state: 'state',
  nonce: 'nonce',
);

void main() {
  group('a restore overtaken by', () {
    test('a sign-in keeps the sign-in when the session is a 401', () async {
      final session = Completer<http.Response>();
      final t = _client(session);

      final restored = t.client.restore();
      await Future<void>.delayed(Duration.zero);
      await _exchange(t.client);
      session.complete(http.Response('{}', 401));

      expect((await restored)?.userId, 'u1');
      await Future<void>.delayed(Duration.zero);
      expect(t.states, [isA<OidcSignedIn>()]);
      expect(t.client.authState, isA<OidcSignedIn>());
      expect(await t.store.get('access_token'), 'new-at');
      expect(await t.store.get('refresh_token'), 'new-rt');
    });

    test('a sign-out stays signed out when the session is a 200', () async {
      final session = Completer<http.Response>();
      final t = _client(session);
      await _exchange(t.client);

      final restored = t.client.restore();
      await Future<void>.delayed(Duration.zero);
      await t.client.signOut();
      session.complete(
        http.Response(
          jsonEncode({'user': _user}),
          200,
          headers: {'set-cookie': 'auth_session=stale; Path=/'},
        ),
      );

      expect(await restored, isNull);
      await Future<void>.delayed(Duration.zero);
      expect(t.states, [isA<OidcSignedIn>(), isA<OidcSignedOut>()]);
      expect(t.client.authState, isA<OidcSignedOut>());
      expect(
        await t.client.sessionStore.cookieHeaderFor(
          Uri.parse('http://localhost:3000/cdk-blocks/auth/session'),
        ),
        isNull,
      );
    });
  });

  test('a restore with nothing in between applies its result', () async {
    final session = Completer<http.Response>();
    final t = _client(session);
    final restored = t.client.restore();
    session.complete(http.Response(jsonEncode({'user': _user}), 200));

    expect((await restored)?.userId, 'u1');
    await Future<void>.delayed(Duration.zero);
    expect(t.states, [isA<OidcSignedIn>()]);
  });
}
