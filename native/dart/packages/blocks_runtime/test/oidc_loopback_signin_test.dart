// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import 'dart:async';
import 'dart:convert';

import 'package:blocks_runtime/blocks_runtime.dart';
import 'package:blocks_runtime/src/loopback_session.dart'
    show loopbackSupportedOverride;
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:test/test.dart';

/// A signed state envelope as the backend sends it; the client decodes only
/// the payload, so the signature can be any token.
String _envelope(String csrf) {
  final body = base64Url
      .encode(utf8.encode(jsonEncode({'v': 1, 'csrf': csrf})))
      .replaceAll('=', '');
  return '$body.sig';
}

/// Answers the relay sign-in's requests as `Auth` does, recording each one.
class _AuthServer {
  final requests = <http.Request>[];

  late final MockClient client = MockClient((req) async {
    requests.add(req);
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
    return http.Response(
      jsonEncode({
        'user': {'userId': 'u1', 'username': 'alice'},
      }),
      200,
      headers: {'set-cookie': 'blocks_session=s1; Path=/'},
    );
  });
}

/// Returns the relay redirect a backend callback would send.
class _Launcher implements BrowserLauncher {
  Uri? authorizeUrl;
  String? scheme;

  @override
  Future<Uri> launch(
    Uri authorizeUrl, {
    required String callbackScheme,
    Future<void>? cancel,
  }) async {
    this.authorizeUrl = authorizeUrl;
    scheme = callbackScheme;
    final state = authorizeUrl.queryParameters['state']!;
    return Uri.parse(
      '$callbackScheme://auth?code=c&state=${Uri.encodeComponent(state)}',
    );
  }
}

/// The client a block's `getClient()` hydrates, sending its requests to
/// [server].
OidcClient _client(_AuthServer server) => OidcClient.fromJson(
  {
    '__blocks': 'oidc/client',
    'providers': ['google'],
    'providerConfigs': <String, dynamic>{},
    'exchangePath': '/cdk-blocks/auth/exchange',
    'signOutPath': '/cdk-blocks/auth/signout',
    'callbackPath': '/cdk-blocks/auth/callback',
  },
  baseUrl: 'http://localhost:3001/cdk-blocks/api',
  tokenStore: InMemoryTokenStore(),
  httpClient: server.client,
);

void main() {
  group('OidcClient.signIn without a launcher', () {
    /// Plays the browser: the backend relays the IdP's code to the relay
    /// target the client sent to authorize-params, with the issued state.
    Future<void> Function(Uri) browser(_AuthServer server, {String? state}) =>
        (authorizeUrl) async {
          final relayTo =
              (jsonDecode(server.requests.first.body) as Map)['relayTo']
                  as String;
          final issued = authorizeUrl.queryParameters['state']!;
          await http.get(
            Uri.parse(
              relayTo,
            ).replace(queryParameters: {'code': 'c', 'state': state ?? issued}),
          );
        };

    test('signs in through a loopback listener on desktop', () async {
      final server = _AuthServer();
      final oidc = _client(server);
      oidc.openBrowser = browser(server);

      final user = await oidc.signIn('google');

      expect(user.userId, 'u1');
      final relayTo = Uri.parse(
        (jsonDecode(server.requests.first.body) as Map)['relayTo'] as String,
      );
      expect(relayTo.scheme, 'http');
      expect(relayTo.host, '127.0.0.1');
      expect(relayTo.path, '/oidc/callback');
      expect(server.requests.last.url.path, '/cdk-blocks/auth/exchange');
      // The listener is closed once the sign-in returns.
      await expectLater(http.get(relayTo), throwsA(anything));
    }, testOn: 'vm && (mac-os || linux || windows)');

    test('ignores a relayTo passed without a launcher', () async {
      final server = _AuthServer();
      final oidc = _client(server);
      oidc.openBrowser = browser(server);

      await oidc.signIn('google', relayTo: 'myapp://auth');

      final relayTo =
          (jsonDecode(server.requests.first.body) as Map)['relayTo'] as String;
      expect(relayTo, startsWith('http://127.0.0.1:'));
    }, testOn: 'vm && (mac-os || linux || windows)');

    test(
      'a redirect with another state times out instead of signing in',
      () async {
        final server = _AuthServer();
        final oidc = _client(server);
        oidc
          ..openBrowser = browser(server, state: 'forged')
          ..signInTimeout = const Duration(milliseconds: 300);

        await expectLater(
          oidc.signIn('google'),
          throwsA(isA<OidcCancelledException>()),
        );
        expect(server.requests, hasLength(1));
      },
      testOn: 'vm && (mac-os || linux || windows)',
    );

    test('an explicit launcher wins over the loopback listener', () async {
      final server = _AuthServer();
      final oidc = _client(server);
      var opened = false;
      oidc.openBrowser = (_) async => opened = true;

      await oidc.signIn(
        'google',
        launcher: _Launcher(),
        relayTo: 'myapp://auth',
      );

      expect(opened, isFalse);
      expect(
        (jsonDecode(server.requests.first.body) as Map)['relayTo'],
        'myapp://auth',
      );
    });

    test('throws a StateError without a launcher where there is no loopback '
        'sign-in', () async {
      loopbackSupportedOverride = false;
      addTearDown(() => loopbackSupportedOverride = null);
      final server = _AuthServer();
      final oidc = _client(server);
      var opened = false;
      oidc.openBrowser = (_) async => opened = true;

      await expectLater(
        oidc.signIn('google'),
        throwsA(
          isA<StateError>().having(
            (e) => e.message,
            'message',
            contains('needs a launcher'),
          ),
        ),
      );
      expect(server.requests, isEmpty);
      expect(opened, isFalse);
    });

    test('cancel before the redirect throws OidcCancelledException', () async {
      final server = _AuthServer();
      final oidc = _client(server);
      final cancel = Completer<void>();
      oidc.openBrowser = (_) async => cancel.complete();

      await expectLater(
        oidc.signIn('google', cancel: cancel.future),
        throwsA(isA<OidcCancelledException>()),
      );
      expect(server.requests, hasLength(1));
    }, testOn: 'vm && (mac-os || linux || windows)');

    test('cancel while waiting for the redirect closes the listener and '
        'never exchanges', () async {
      final server = _AuthServer();
      final oidc = _client(server);
      final opened = Completer<void>();
      oidc.openBrowser = (_) async => opened.complete();
      final cancel = Completer<void>();

      final signIn = oidc.signIn('google', cancel: cancel.future);
      await opened.future;
      final relayTo =
          (jsonDecode(server.requests.first.body) as Map)['relayTo'] as String;
      cancel.complete();

      await expectLater(signIn, throwsA(isA<OidcCancelledException>()));
      await expectLater(http.get(Uri.parse(relayTo)), throwsA(anything));
      expect(server.requests, hasLength(1));
    }, testOn: 'vm && (mac-os || linux || windows)');

    test('signInTimeout without a redirect throws OidcCancelledException and '
        'closes the listener', () async {
      final server = _AuthServer();
      final oidc = _client(server);
      oidc
        ..openBrowser = (_) async {}
        ..signInTimeout = const Duration(milliseconds: 200);

      await expectLater(
        oidc.signIn('google'),
        throwsA(
          isA<OidcCancelledException>().having(
            (e) => e.message,
            'message',
            contains('timed out'),
          ),
        ),
      );
      final relayTo =
          (jsonDecode(server.requests.first.body) as Map)['relayTo'] as String;
      await expectLater(http.get(Uri.parse(relayTo)), throwsA(anything));
      expect(server.requests, hasLength(1));
    }, testOn: 'vm && (mac-os || linux || windows)');

    test(
      'with a launcher, a missing relayTo throws before any request',
      () async {
        final server = _AuthServer();
        await expectLater(
          _client(server).signIn('google', launcher: _Launcher()),
          throwsA(isA<StateError>()),
        );
        expect(server.requests, isEmpty);
      },
    );

    test('an unknown provider throws before anything is bound', () async {
      final server = _AuthServer();
      final oidc = _client(server);
      var opened = false;
      oidc.openBrowser = (_) async => opened = true;

      await expectLater(
        oidc.signIn('github'),
        throwsA(isA<OidcUnknownProviderException>()),
      );
      expect(server.requests, isEmpty);
      expect(opened, isFalse);
    });

    test('a typed client signs in without a launcher too', () async {
      final server = _AuthServer();
      final untyped = _client(server)..openBrowser = browser(server);
      final typed = TypedOidcClient<_Provider>(untyped);

      expect((await typed.signIn(_Provider.google)).userId, 'u1');
    }, testOn: 'vm && (mac-os || linux || windows)');
  });
}

enum _Provider implements OidcProvider {
  google('google');

  const _Provider(this.providerName);

  @override
  final String providerName;
}
