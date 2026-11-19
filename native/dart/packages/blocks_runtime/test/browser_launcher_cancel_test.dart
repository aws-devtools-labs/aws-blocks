// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import 'dart:async';
import 'dart:convert';

import 'package:blocks_runtime/blocks_runtime.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:test/test.dart';

const _relayTo = 'testapp://auth';

/// A signed state envelope as the backend sends it; the client decodes only
/// the payload, so the signature can be any token.
String _envelope(String csrf) {
  final body = base64Url
      .encode(utf8.encode(jsonEncode({'v': 1, 'csrf': csrf})))
      .replaceAll('=', '');
  return '$body.sig';
}

/// Answers the authorize-params request as `Auth` does and counts the
/// exchange requests, which a cancelled sign-in must never send.
class _Backend {
  int exchanges = 0;

  late final client = MockClient((req) async {
    if (req.url.path.contains('/authorize-params/')) {
      final csrf = (jsonDecode(req.body) as Map)['csrf'] as String;
      return http.Response(
        jsonEncode({
          'authorizeUrl': 'https://idp.example.com/authorize',
          'clientId': 'cid',
          'scopes': ['openid'],
          'kind': 'oidc-builtin',
          'state': _envelope(csrf),
        }),
        200,
      );
    }
    exchanges++;
    return http.Response(
      jsonEncode({
        'user': {'userId': 'u1', 'username': 'alice'},
      }),
      200,
    );
  });
}

OidcClient _client(_Backend backend, TokenStore store) => OidcClient(
  exchangePath: '/auth/exchange',
  refreshPath: '/auth/refresh',
  signOutPath: '/auth/signout',
  authorizeParamsBasePath: '/auth/authorize-params',
  callbackPath: '/auth/callback',
  providers: ['google'],
  providerConfigs: {
    'google': ProviderConfig(
      authorizeUrl: 'https://idp.example.com/authorize',
      clientId: 'cid',
      scopes: const ['openid'],
      kind: 'oidc-builtin',
    ),
  },
  baseUrl: 'http://localhost:3001',
  tokenStore: store,
  httpClient: backend.client,
);

/// A launcher that waits until the test answers [redirect], and records the
/// `cancel` future it was given.
class _WaitingLauncher implements BrowserLauncher {
  final redirect = Completer<Uri>();
  final launched = Completer<Uri>();
  Future<void>? cancel;
  int launches = 0;

  @override
  Future<Uri> launch(
    Uri authorizeUrl, {
    required String callbackScheme,
    Future<void>? cancel,
  }) {
    launches++;
    this.cancel = cancel;
    launched.complete(authorizeUrl);
    return redirect.future;
  }

  /// Answers with a redirect carrying the state of the launched sign-in.
  Future<void> answer() async {
    final url = await launched.future;
    final state = Uri.encodeComponent(url.queryParameters['state']!);
    redirect.complete(Uri.parse('$_relayTo?code=c&state=$state'));
  }
}

/// A launcher that honors `cancel` and its own timeout, as
/// `FlutterBrowserLauncher` does.
class _TimingOutLauncher implements BrowserLauncher {
  _TimingOutLauncher(this.timeout);

  final Duration timeout;

  @override
  Future<Uri> launch(
    Uri authorizeUrl, {
    required String callbackScheme,
    Future<void>? cancel,
  }) => Completer<Uri>().future.timeout(
    timeout,
    onTimeout: () => throw OidcCancelledException(
      'Sign-in timed out after ${timeout.inMilliseconds}ms',
    ),
  );
}

void main() {
  group('signIn with a launcher', () {
    test('throws OidcCancelledException when cancel completes, and hands '
        'the launcher the cancel future', () async {
      final backend = _Backend();
      final launcher = _WaitingLauncher();
      final cancel = Completer<void>();
      final signIn = _client(backend, InMemoryTokenStore()).signIn(
        'google',
        launcher: launcher,
        relayTo: _relayTo,
        cancel: cancel.future,
      );

      await launcher.launched.future;
      expect(launcher.cancel, same(cancel.future));
      cancel.complete();

      await expectLater(signIn, throwsA(isA<OidcCancelledException>()));
      // A redirect the launcher returns after the cancel is ignored.
      await launcher.answer();
      await pumpEventQueue();
      expect(backend.exchanges, 0);
    });

    test('propagates the launcher\'s own timeout as '
        'OidcCancelledException', () async {
      final backend = _Backend();
      await expectLater(
        _client(backend, InMemoryTokenStore()).signIn(
          'google',
          launcher: _TimingOutLauncher(const Duration(milliseconds: 20)),
          relayTo: _relayTo,
        ),
        throwsA(
          isA<OidcCancelledException>().having(
            (e) => e.message,
            'message',
            'Sign-in timed out after 20ms',
          ),
        ),
      );
      expect(backend.exchanges, 0);
    });

    test('signs in when the redirect arrives before cancel', () async {
      final backend = _Backend();
      final launcher = _WaitingLauncher();
      final cancel = Completer<void>();
      final signIn = _client(backend, InMemoryTokenStore()).signIn(
        'google',
        launcher: launcher,
        relayTo: _relayTo,
        cancel: cancel.future,
      );

      await launcher.answer();
      final user = await signIn;
      cancel.complete();

      expect(user.userId, 'u1');
      expect(backend.exchanges, 1);
    });

    test('passes a null cancel to the launcher when none is given', () async {
      final launcher = _WaitingLauncher();
      final signIn = _client(
        _Backend(),
        InMemoryTokenStore(),
      ).signIn('google', launcher: launcher, relayTo: _relayTo);
      await launcher.answer();
      await signIn;
      expect(launcher.launches, 1);
      expect(launcher.cancel, isNull);
    });
  });

  group('signInDirect with a launcher', () {
    test('throws OidcCancelledException when cancel completes, and leaves '
        'no PKCE values behind', () async {
      final store = InMemoryTokenStore();
      final backend = _Backend();
      final launcher = _WaitingLauncher();
      final cancel = Completer<void>();
      final signIn = _client(backend, store).signInDirect(
        'google',
        launcher: launcher,
        redirectUri: 'myapp://auth',
        cancel: cancel.future,
      );

      await launcher.launched.future;
      expect(launcher.cancel, same(cancel.future));
      cancel.complete();

      await expectLater(signIn, throwsA(isA<OidcCancelledException>()));
      for (final key in ['oidc_verifier', 'oidc_state', 'oidc_nonce']) {
        expect(await store.get(key), isNull, reason: key);
      }
      expect(backend.exchanges, 0);
    });

    test('propagates the launcher\'s own timeout as '
        'OidcCancelledException', () async {
      final store = InMemoryTokenStore();
      await expectLater(
        _client(_Backend(), store).signInDirect(
          'google',
          launcher: _TimingOutLauncher(const Duration(milliseconds: 20)),
          redirectUri: 'myapp://auth',
        ),
        throwsA(isA<OidcCancelledException>()),
      );
      expect(await store.get('oidc_state'), isNull);
    });
  });
}
