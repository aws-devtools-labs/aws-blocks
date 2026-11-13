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
  Future<Uri> launch(Uri authorizeUrl, {required String callbackScheme}) async {
    this.authorizeUrl = authorizeUrl;
    scheme = callbackScheme;
    final state = authorizeUrl.queryParameters['state']!;
    return Uri.parse(
      '$callbackScheme://auth?code=c&state=${Uri.encodeComponent(state)}',
    );
  }
}

void main() {
  group('OidcClient.forAuth', () {
    test('derives the routes from the default callbackPath', () async {
      final server = _AuthServer();
      final blocks = BlocksClient(
        baseUrl: 'https://x.example.com/prod/aws-blocks/api',
        client: server.client,
      );
      final oidc = OidcClient.forAuth(
        blocks,
        providers: ['google'],
        relayTo: 'myapp://auth',
      );
      final launcher = _Launcher();

      final user = await oidc.signInRelay('google', launcher: launcher);

      expect(user.userId, 'u1');
      expect(server.requests.map((r) => r.url.toString()), [
        'https://x.example.com/prod/aws-blocks/auth/authorize-params/google',
        'https://x.example.com/prod/aws-blocks/auth/exchange',
      ]);
      expect(
        (jsonDecode(server.requests.first.body) as Map)['relayTo'],
        'myapp://auth',
      );
      expect(launcher.scheme, 'myapp');
      const callback = 'https://x.example.com/prod/aws-blocks/auth/callback';
      expect(launcher.authorizeUrl!.queryParameters['redirect_uri'], callback);
      expect(
        (jsonDecode(server.requests.last.body) as Map)['callbackUrl'],
        callback,
      );
      expect(oidc.refreshPath, '/aws-blocks/auth/exchange/refresh');
      expect(oidc.sessionPath, '/aws-blocks/auth/session');
      expect(oidc.signOutPath, '/aws-blocks/auth/signout');
    });

    test('derives the sso block routes', () async {
      final server = _AuthServer();
      final oidc = OidcClient.forAuth(
        BlocksClient(
          baseUrl: 'http://localhost:3001/aws-blocks/api',
          client: server.client,
        ),
        providers: ['corp'],
        relayTo: 'myapp://auth',
        callbackPath: '/aws-blocks/auth/sso/callback',
        signOutPath: '/aws-blocks/auth/sso/signout',
      );

      await oidc.signInRelay('corp', launcher: _Launcher());

      expect(server.requests.map((r) => r.url.toString()), [
        'http://localhost:3001/aws-blocks/auth/sso/authorize-params/corp',
        'http://localhost:3001/aws-blocks/auth/sso/exchange',
      ]);
      expect(
        oidc.authorizeParamsBasePath,
        '/aws-blocks/auth/sso/authorize-params',
      );
      expect(oidc.exchangePath, '/aws-blocks/auth/sso/exchange');
      expect(oidc.sessionPath, '/aws-blocks/auth/sso/session');
      expect(oidc.refreshPath, '/aws-blocks/auth/sso/exchange/refresh');
      expect(oidc.callbackPath, '/aws-blocks/auth/sso/callback');
      expect(oidc.signOutPath, '/aws-blocks/auth/sso/signout');
    });

    test('derives the routes from a custom callbackPath', () async {
      final server = _AuthServer();
      final oidc = OidcClient.forAuth(
        BlocksClient(baseUrl: 'http://localhost:3001', client: server.client),
        providers: ['corp sso'],
        relayTo: 'myapp://auth',
        callbackPath: '/aws-blocks/auth/sso/return',
        signOutPath: '/aws-blocks/auth/sso/signout',
      );

      await oidc.signInRelay('corp sso', launcher: _Launcher());

      expect(server.requests.map((r) => r.url.toString()), [
        'http://localhost:3001/aws-blocks/auth/sso/authorize-params/corp%20sso',
        'http://localhost:3001/aws-blocks/auth/sso/exchange',
      ]);
      expect(
        (jsonDecode(server.requests.last.body) as Map)['callbackUrl'],
        'http://localhost:3001/aws-blocks/auth/sso/return',
      );
      expect(oidc.refreshPath, '/aws-blocks/auth/sso/exchange/refresh');
      expect(oidc.sessionPath, '/aws-blocks/auth/sso/session');
      expect(oidc.signOutPath, '/aws-blocks/auth/sso/signout');
    });

    test(
      "shares the client's HTTP client, session store and token store",
      () async {
        final server = _AuthServer();
        final blocks = BlocksClient(
          baseUrl: 'http://localhost:3001/aws-blocks/api',
          client: server.client,
        );
        final oidc = OidcClient.forAuth(
          blocks,
          providers: ['google'],
          relayTo: 'myapp://auth',
        );

        await oidc.signInRelay('google', launcher: _Launcher());

        expect(server.requests, hasLength(2));
        expect(identical(oidc.sessionStore, blocks.sessionStore), isTrue);
        expect(identical(oidc.tokenStore, blocks.tokenStore), isTrue);
        expect(blocks.sessionStore.cookies['blocks_session'], 's1');
      },
    );

    test('uses the token store it is given', () {
      final store = InMemoryTokenStore();
      final oidc = OidcClient.forAuth(
        BlocksClient(baseUrl: 'http://localhost:3001'),
        providers: ['google'],
        tokenStore: store,
      );
      expect(identical(oidc.tokenStore, store), isTrue);
    });

    test('makes no request when built', () {
      final server = _AuthServer();
      OidcClient.forAuth(
        BlocksClient(baseUrl: 'http://localhost:3001', client: server.client),
        providers: ['google'],
      );
      expect(server.requests, isEmpty);
    });

    test(
      'throws for a provider it does not list, before any request',
      () async {
        final server = _AuthServer();
        final oidc = OidcClient.forAuth(
          BlocksClient(baseUrl: 'http://localhost:3001', client: server.client),
          providers: ['google'],
          relayTo: 'myapp://auth',
        );
        await expectLater(
          oidc.signInRelay('github', launcher: _Launcher()),
          throwsA(
            isA<OidcUnknownProviderException>().having(
              (e) => e.provider,
              'provider',
              'github',
            ),
          ),
        );
        expect(server.requests, isEmpty);
      },
    );

    test(
      'a relayTo passed to signInRelay wins over the configured one',
      () async {
        final server = _AuthServer();
        final oidc = OidcClient.forAuth(
          BlocksClient(baseUrl: 'http://localhost:3001', client: server.client),
          providers: ['google'],
          relayTo: 'myapp://auth',
        );
        final launcher = _Launcher();
        await oidc.signInRelay(
          'google',
          launcher: launcher,
          relayTo: 'other://auth',
        );
        expect(
          (jsonDecode(server.requests.first.body) as Map)['relayTo'],
          'other://auth',
        );
        expect(launcher.scheme, 'other');
      },
    );

    for (final relayTo in [null, '']) {
      test(
        'signInRelay with no relayTo configured (${relayTo == null ? 'null' : 'empty'}) '
        'throws a StateError before any request',
        () async {
          final server = _AuthServer();
          final oidc = OidcClient.forAuth(
            BlocksClient(
              baseUrl: 'http://localhost:3001',
              client: server.client,
            ),
            providers: ['google'],
            relayTo: relayTo,
          );
          expect(oidc.relayTo, isNull);
          await expectLater(
            oidc.signInRelay('google', launcher: _Launcher()),
            throwsA(isA<StateError>()),
          );
          expect(server.requests, isEmpty);
        },
      );
    }

    group('rejects', () {
      final blocks = BlocksClient(baseUrl: 'http://localhost:3001');
      for (final path in [
        '/login',
        '/aws-blocks/callback',
        '/aws-blocks/auth/',
        '/aws-blocks/auth/callback/',
        'aws-blocks/auth/callback',
      ]) {
        test('callbackPath $path', () {
          expect(
            () => OidcClient.forAuth(
              blocks,
              providers: ['google'],
              callbackPath: path,
            ),
            throwsA(
              isA<ArgumentError>().having(
                (e) => e.name,
                'name',
                'callbackPath',
              ),
            ),
          );
        });
      }
      for (final path in ['/signout', '/aws-blocks/signout']) {
        test('signOutPath $path', () {
          expect(
            () => OidcClient.forAuth(
              blocks,
              providers: ['google'],
              signOutPath: path,
            ),
            throwsA(
              isA<ArgumentError>().having((e) => e.name, 'name', 'signOutPath'),
            ),
          );
        });
      }
    });

    test('wraps as a TypedOidcClient', () async {
      final server = _AuthServer();
      final typed = TypedOidcClient<_Provider>(
        OidcClient.forAuth(
          BlocksClient(baseUrl: 'http://localhost:3001', client: server.client),
          providers: ['google'],
          relayTo: 'myapp://auth',
        ),
      );
      final user = await typed.signInRelay(
        _Provider.google,
        launcher: _Launcher(),
      );
      expect(user.userId, 'u1');
    });
  });

  group('OidcClient.signInRelay without a launcher', () {
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
      final oidc = OidcClient.forAuth(
        BlocksClient(baseUrl: 'http://localhost:3001', client: server.client),
        providers: ['google'],
      );
      oidc.openBrowser = browser(server);

      final user = await oidc.signInRelay('google');

      expect(user.userId, 'u1');
      final relayTo = Uri.parse(
        (jsonDecode(server.requests.first.body) as Map)['relayTo'] as String,
      );
      expect(relayTo.scheme, 'http');
      expect(relayTo.host, '127.0.0.1');
      expect(relayTo.path, '/oidc/callback');
      expect(server.requests.last.url.path, '/aws-blocks/auth/exchange');
      // The listener is closed once the sign-in returns.
      await expectLater(http.get(relayTo), throwsA(anything));
    }, testOn: 'mac-os || linux || windows');

    test('uses the loopback target even when relayTo is configured', () async {
      final server = _AuthServer();
      final oidc = OidcClient.forAuth(
        BlocksClient(baseUrl: 'http://localhost:3001', client: server.client),
        providers: ['google'],
        relayTo: 'myapp://auth',
      );
      oidc.openBrowser = browser(server);

      await oidc.signInRelay('google');

      final relayTo =
          (jsonDecode(server.requests.first.body) as Map)['relayTo'] as String;
      expect(relayTo, startsWith('http://127.0.0.1:'));
    }, testOn: 'mac-os || linux || windows');

    test(
      'a redirect with another state times out instead of signing in',
      () async {
        final server = _AuthServer();
        final oidc = OidcClient.forAuth(
          BlocksClient(baseUrl: 'http://localhost:3001', client: server.client),
          providers: ['google'],
        );
        oidc
          ..openBrowser = browser(server, state: 'forged')
          ..signInTimeout = const Duration(milliseconds: 300);

        await expectLater(
          oidc.signInRelay('google'),
          throwsA(isA<OidcCancelledException>()),
        );
        expect(server.requests, hasLength(1));
      },
      testOn: 'mac-os || linux || windows',
    );

    test('an explicit launcher wins over the loopback listener', () async {
      final server = _AuthServer();
      final oidc = OidcClient.forAuth(
        BlocksClient(baseUrl: 'http://localhost:3001', client: server.client),
        providers: ['google'],
        relayTo: 'myapp://auth',
      );
      var opened = false;
      oidc.openBrowser = (_) async => opened = true;

      await oidc.signInRelay('google', launcher: _Launcher());

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
      final oidc = OidcClient.forAuth(
        BlocksClient(baseUrl: 'http://localhost:3001', client: server.client),
        providers: ['google'],
      );
      var opened = false;
      oidc.openBrowser = (_) async => opened = true;

      await expectLater(
        oidc.signInRelay('google'),
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
      final oidc = OidcClient.forAuth(
        BlocksClient(baseUrl: 'http://localhost:3001', client: server.client),
        providers: ['google'],
      );
      final cancel = Completer<void>();
      oidc.openBrowser = (_) async => cancel.complete();

      await expectLater(
        oidc.signInRelay('google', cancel: cancel.future),
        throwsA(isA<OidcCancelledException>()),
      );
      expect(server.requests, hasLength(1));
    }, testOn: 'mac-os || linux || windows');

    test('an unknown provider throws before anything is bound', () async {
      final server = _AuthServer();
      final oidc = OidcClient.forAuth(
        BlocksClient(baseUrl: 'http://localhost:3001', client: server.client),
        providers: ['google'],
      );
      var opened = false;
      oidc.openBrowser = (_) async => opened = true;

      await expectLater(
        oidc.signInRelay('github'),
        throwsA(isA<OidcUnknownProviderException>()),
      );
      expect(server.requests, isEmpty);
      expect(opened, isFalse);
    });

    test('a typed client signs in without a launcher too', () async {
      final server = _AuthServer();
      final untyped = OidcClient.forAuth(
        BlocksClient(baseUrl: 'http://localhost:3001', client: server.client),
        providers: ['google'],
      )..openBrowser = browser(server);
      final typed = TypedOidcClient<_Provider>(untyped);

      expect((await typed.signInRelay(_Provider.google)).userId, 'u1');
    }, testOn: 'mac-os || linux || windows');
  });

  group('OidcClient.providerIdOf', () {
    test('returns the id of a federated sign-in action', () {
      expect(OidcClient.providerIdOf('signIn:google'), 'google');
      expect(OidcClient.providerIdOf('signIn:corp sso'), 'corp sso');
      expect(OidcClient.providerIdOf('signIn:a:b'), 'a:b');
    });

    test('returns null for any other action', () {
      expect(OidcClient.providerIdOf('signIn'), isNull);
      expect(OidcClient.providerIdOf('signIn:'), isNull);
      expect(OidcClient.providerIdOf('signOut'), isNull);
      expect(OidcClient.providerIdOf('signUp'), isNull);
      expect(OidcClient.providerIdOf('signin:google'), isNull);
      expect(OidcClient.providerIdOf(''), isNull);
    });
  });

  group('OidcClient.forAuth token keys', () {
    /// Answers like `_AuthServer`, with bearer tokens named after the block
    /// whose exchange route was called.
    MockClient bearerServer() => MockClient((req) async {
      final block = req.url.path.contains('/sso/') ? 'sso' : 'main';
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

    test('two blocks sharing a token store keep their own tokens', () async {
      final store = _RecordingTokenStore();
      final blocks = BlocksClient(
        baseUrl: 'http://localhost:3001/aws-blocks/api',
        client: bearerServer(),
        tokenStore: store,
      );
      final main = OidcClient.forAuth(
        blocks,
        providers: ['google'],
        relayTo: 'myapp://auth',
      );
      final sso = OidcClient.forAuth(
        blocks,
        providers: ['corp'],
        relayTo: 'myapp://auth',
        callbackPath: '/aws-blocks/auth/sso/callback',
        signOutPath: '/aws-blocks/auth/sso/signout',
      );

      await main.signInRelay('google', launcher: _Launcher());
      await sso.signInRelay('corp', launcher: _Launcher());

      expect(await main.getAccessToken(), 'main-at');
      expect(await sso.getAccessToken(), 'sso-at');
      expect(await store.get('/aws-blocks/auth/refresh_token'), 'main-rt');
      expect(await store.get('/aws-blocks/auth/sso/refresh_token'), 'sso-rt');
      expect(await store.get('/aws-blocks/auth/provider'), 'google');
      expect(await store.get('/aws-blocks/auth/sso/provider'), 'corp');
      expect(
        store.keys.where((k) => !k.startsWith('/aws-blocks/auth/')),
        isEmpty,
      );

      await sso.signOut();

      expect(await sso.getAccessToken(), isNull);
      expect(await main.getAccessToken(), 'main-at');
      expect(await store.get('/aws-blocks/auth/refresh_token'), 'main-rt');
    });

    test('a client built with the constructor keeps unprefixed keys', () async {
      final store = InMemoryTokenStore();
      final oidc = OidcClient(
        exchangePath: '/aws-blocks/auth/exchange',
        refreshPath: '/aws-blocks/auth/exchange/refresh',
        signOutPath: '/aws-blocks/auth/signout',
        providers: ['google'],
        providerConfigs: const {},
        baseUrl: 'http://localhost:3001/aws-blocks/api',
        tokenStore: store,
        httpClient: bearerServer(),
      );

      await oidc.signInRelay(
        'google',
        launcher: _Launcher(),
        relayTo: 'myapp://auth',
      );

      expect(await store.get('access_token'), 'main-at');
      expect(await store.get('refresh_token'), 'main-rt');
    });
  });
}

/// An [InMemoryTokenStore] that records every key written to it.
class _RecordingTokenStore extends InMemoryTokenStore {
  final keys = <String>{};

  @override
  Future<void> set(String key, String value) {
    keys.add(key);
    return super.set(key, value);
  }
}

enum _Provider implements OidcProvider {
  google('google');

  const _Provider(this.providerName);

  @override
  final String providerName;
}
