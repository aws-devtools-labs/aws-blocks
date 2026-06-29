import 'dart:convert';

import 'package:blocks_runtime/blocks_runtime.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:test/test.dart';

/// Builds a signed-state-envelope wire string matching the backend format:
/// `base64url(JSON(payload)) + '.' + base64url(fakeSig)`, no padding.
/// The client only decodes the payload, so the signature can be any token.
String makeStateEnvelope({
  required String csrf,
  int v = 1,
  String? relay,
  String sig = 'fake-signature',
}) {
  final payload = <String, dynamic>{
    'v': v,
    'csrf': csrf,
    if (relay != null) 'relay': relay,
  };
  final body =
      base64Url.encode(utf8.encode(jsonEncode(payload))).replaceAll('=', '');
  return '$body.$sig';
}

/// A scripted [BrowserLauncher] for tests: captures the authorize URL it was
/// given and returns a predetermined relay redirect URI (or throws).
class FakeLauncher implements BrowserLauncher {
  final Uri Function(Uri authorizeUrl, String callbackScheme)? onLaunch;
  Uri? capturedAuthorizeUrl;
  String? capturedScheme;

  FakeLauncher({this.onLaunch});

  @override
  Future<Uri> launch(Uri authorizeUrl, {required String callbackScheme}) async {
    capturedAuthorizeUrl = authorizeUrl;
    capturedScheme = callbackScheme;
    if (onLaunch == null) {
      throw StateError('launcher not configured');
    }
    return onLaunch!(authorizeUrl, callbackScheme);
  }
}

const _relayTo = 'testapp://auth';

OidcClient buildClient({
  required MockClient httpClient,
  TokenStore? store,
  String baseUrl = 'http://localhost:3001',
}) {
  return OidcClient(
    exchangePath: '/auth/exchange',
    refreshPath: '/auth/refresh',
    signOutPath: '/auth/signout',
    authorizeParamsBasePath: '/auth/authorize-params',
    callbackPath: '/auth/callback',
    providers: ['google'],
    providerConfigs: {},
    baseUrl: baseUrl,
    tokenStore: store ?? InMemoryTokenStore(),
    httpClient: httpClient,
  );
}

void main() {
  group('PKCE parity with Kotlin PkceTest', () {
    test('generateVerifier returns 43-char base64url (32 bytes, no padding)',
        () {
      final verifier = OidcClient.generateVerifier();
      expect(verifier.length, 43);
      expect(RegExp(r'^[A-Za-z0-9_-]+$').hasMatch(verifier), isTrue);
    });

    test('generateVerifier returns different values', () {
      expect(
          OidcClient.generateVerifier(), isNot(OidcClient.generateVerifier()));
    });

    test('generateRandom returns 43-char base64url', () {
      final random = OidcClient.generateRandom();
      expect(random.length, 43);
      expect(RegExp(r'^[A-Za-z0-9_-]+$').hasMatch(random), isTrue);
    });

    test('generateChallenge matches RFC 7636 Appendix B test vector', () {
      // Same vector asserted in Kotlin PkceTest.
      const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
      expect(OidcClient.generateChallenge(verifier),
          'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
    });
  });

  group('StatePayload envelope decoding', () {
    test('decodes csrf from a no-padding base64url payload', () {
      final csrf = OidcClient.generateRandom();
      final envelope = makeStateEnvelope(csrf: csrf, relay: _relayTo);
      final payload = StatePayload.decodeEnvelope(envelope);
      expect(payload.v, 1);
      expect(payload.csrf, csrf);
      expect(payload.relay, _relayTo);
    });

    test('takes only the payload before the first dot', () {
      final csrf = OidcClient.generateRandom();
      // Extra dots in the signature portion must not break decoding.
      final envelope = makeStateEnvelope(csrf: csrf, sig: 'a.b.c');
      expect(StatePayload.decodeEnvelope(envelope).csrf, csrf);
    });

    test('throws OidcCallbackException on a malformed (empty payload) envelope',
        () {
      expect(() => StatePayload.decodeEnvelope('.sig'),
          throwsA(isA<OidcCallbackException>()));
    });

    test('throws OidcCallbackException on undecodable payload', () {
      expect(() => StatePayload.decodeEnvelope('!!!not-base64!!!.sig'),
          throwsA(isA<OidcCallbackException>()));
    });
  });

  group('signInRelay', () {
    test('fetches authorize params and builds the correct authorize URL',
        () async {
      String? sentAuthorizeParamsBody;
      final httpClient = MockClient((req) async {
        if (req.url.path.contains('/auth/authorize-params/')) {
          sentAuthorizeParamsBody = req.body;
          // server returns a signed state envelope; csrf inside must match the
          // one the client sent.
          final csrf = (jsonDecode(req.body) as Map)['csrf'] as String;
          return http.Response(
            jsonEncode({
              'authorizeUrl': 'https://accounts.google.com/o/oauth2/v2/auth',
              'clientId': 'test-client-id',
              'scopes': ['openid', 'email'],
              'kind': 'oidc-builtin',
              'state': makeStateEnvelope(csrf: csrf, relay: _relayTo),
              'nonce': 'server-generated-nonce',
            }),
            200,
          );
        }
        // exchange
        return http.Response(
          jsonEncode({
            'user': {'userId': 'google:123', 'username': 'alice'},
          }),
          200,
        );
      });

      final client = buildClient(httpClient: httpClient);

      // The launcher returns the relay redirect carrying code + state + iss.
      // It must echo back the exact `state` the authorize URL was built with.
      final launcher = FakeLauncher(onLaunch: (authorizeUrl, scheme) {
        final state = authorizeUrl.queryParameters['state']!;
        return Uri.parse(
          '$_relayTo?code=test-code&state=${Uri.encodeComponent(state)}&iss=https://accounts.google.com',
        );
      });

      final user = await client.signInRelay('google',
          launcher: launcher, relayTo: _relayTo);

      expect(user.userId, 'google:123');
      expect(user.username, 'alice');

      // authorize-params request body carries csrf (>=32 chars) + relayTo.
      final body = jsonDecode(sentAuthorizeParamsBody!) as Map<String, dynamic>;
      expect(body['relayTo'], _relayTo);
      expect((body['csrf'] as String).length, greaterThanOrEqualTo(32));

      // The launcher captured the right scheme + authorize URL params.
      expect(launcher.capturedScheme, 'testapp');
      final qp = launcher.capturedAuthorizeUrl!.queryParameters;
      expect(launcher.capturedAuthorizeUrl!.host, 'accounts.google.com');
      expect(qp['response_type'], 'code');
      expect(qp['client_id'], 'test-client-id');
      expect(qp['redirect_uri'], 'http://localhost:3001/auth/callback');
      expect(qp['scope'], 'openid email');
      expect(qp['code_challenge_method'], 'S256');
      expect(qp['code_challenge'], isNotNull);
      expect(qp['nonce'], 'server-generated-nonce');
    });

    test('forwards iss to the exchange endpoint (RFC 9207)', () async {
      Map<String, dynamic>? exchangeBody;
      final httpClient = MockClient((req) async {
        if (req.url.path.contains('/auth/authorize-params/')) {
          final csrf = (jsonDecode(req.body) as Map)['csrf'] as String;
          return http.Response(
            jsonEncode({
              'authorizeUrl': 'https://idp.example.com/authorize',
              'clientId': 'cid',
              'scopes': ['openid'],
              'kind': 'oidc-builtin',
              'state': makeStateEnvelope(csrf: csrf),
            }),
            200,
          );
        }
        exchangeBody = jsonDecode(req.body) as Map<String, dynamic>;
        return http.Response(
          jsonEncode({
            'user': {'userId': 'u1', 'username': 'bob'},
          }),
          200,
        );
      });

      final client = buildClient(httpClient: httpClient);
      final launcher = FakeLauncher(onLaunch: (authorizeUrl, scheme) {
        final state = authorizeUrl.queryParameters['state']!;
        return Uri.parse(
          '$_relayTo?code=c&state=${Uri.encodeComponent(state)}&iss=https://idp.example.com',
        );
      });

      await client.signInRelay('google', launcher: launcher, relayTo: _relayTo);

      expect(exchangeBody!['iss'], 'https://idp.example.com');
      expect(exchangeBody!['code'], 'c');
      expect(
          exchangeBody!['callbackUrl'], 'http://localhost:3001/auth/callback');
      expect(exchangeBody!['verifier'], isNotNull);
    });

    test(
        'resolves auth routes at the API origin when baseUrl carries the RPC '
        'prefix (/aws-blocks/api)', () async {
      // Regression: the JSON-RPC baseUrl includes `/aws-blocks/api`, but the
      // server-relay auth routes mount at the API origin. The client must strip
      // the RPC prefix and target `<origin>/auth/*`, not `<rpc>/auth/*`.
      final authParamsUrls = <String>[];
      final exchangeUrls = <String>[];
      Map<String, dynamic>? exchangeBody;
      final httpClient = MockClient((req) async {
        if (req.url.path.contains('/auth/authorize-params/')) {
          authParamsUrls.add(req.url.toString());
          final csrf = (jsonDecode(req.body) as Map)['csrf'] as String;
          return http.Response(
            jsonEncode({
              'authorizeUrl': 'https://idp.example.com/authorize',
              'clientId': 'cid',
              'scopes': ['openid'],
              'kind': 'oidc-builtin',
              'state': makeStateEnvelope(csrf: csrf, relay: _relayTo),
            }),
            200,
          );
        }
        exchangeUrls.add(req.url.toString());
        exchangeBody = jsonDecode(req.body) as Map<String, dynamic>;
        return http.Response(
          jsonEncode({
            'user': {'userId': 'u1', 'username': 'carol'},
          }),
          200,
        );
      });

      // Matches the deployed sandbox: stage path + RPC prefix.
      final client = buildClient(
        httpClient: httpClient,
        baseUrl: 'https://host.example.com/prod/aws-blocks/api',
      );
      final launcher = FakeLauncher(onLaunch: (authorizeUrl, scheme) {
        final state = authorizeUrl.queryParameters['state']!;
        return Uri.parse(
          '$_relayTo?code=c&state=${Uri.encodeComponent(state)}',
        );
      });

      await client.signInRelay('google', launcher: launcher, relayTo: _relayTo);

      // Auth routes resolve at the origin (.../prod), NOT under /aws-blocks/api.
      expect(authParamsUrls.single,
          'https://host.example.com/prod/auth/authorize-params/google');
      expect(
          exchangeUrls.single, 'https://host.example.com/prod/auth/exchange');
      expect(exchangeBody!['callbackUrl'],
          'https://host.example.com/prod/auth/callback');
      expect(launcher.capturedAuthorizeUrl!.queryParameters['redirect_uri'],
          'https://host.example.com/prod/auth/callback');
    });

    test('omits iss from exchange body when the relay redirect has none',
        () async {
      Map<String, dynamic>? exchangeBody;
      final httpClient = MockClient((req) async {
        if (req.url.path.contains('/auth/authorize-params/')) {
          final csrf = (jsonDecode(req.body) as Map)['csrf'] as String;
          return http.Response(
            jsonEncode({
              'authorizeUrl': 'https://idp.example.com/authorize',
              'clientId': 'cid',
              'scopes': ['openid'],
              'kind': 'oidc-builtin',
              'state': makeStateEnvelope(csrf: csrf),
            }),
            200,
          );
        }
        exchangeBody = jsonDecode(req.body) as Map<String, dynamic>;
        return http.Response(
          jsonEncode({
            'user': {'userId': 'u1', 'username': 'bob'},
          }),
          200,
        );
      });

      final client = buildClient(httpClient: httpClient);
      final launcher = FakeLauncher(onLaunch: (authorizeUrl, scheme) {
        final state = authorizeUrl.queryParameters['state']!;
        return Uri.parse(
            '$_relayTo?code=c&state=${Uri.encodeComponent(state)}');
      });

      await client.signInRelay('google', launcher: launcher, relayTo: _relayTo);
      expect(exchangeBody!.containsKey('iss'), isFalse);
    });

    test('signs in via cookie flow ({user}-only response, no tokens stored)',
        () async {
      final store = InMemoryTokenStore();
      final httpClient = MockClient((req) async {
        if (req.url.path.contains('/auth/authorize-params/')) {
          final csrf = (jsonDecode(req.body) as Map)['csrf'] as String;
          return http.Response(
            jsonEncode({
              'authorizeUrl': 'https://idp.example.com/authorize',
              'clientId': 'cid',
              'scopes': ['openid'],
              'kind': 'oidc-builtin',
              'state': makeStateEnvelope(csrf: csrf),
            }),
            200,
          );
        }
        return http.Response(
          jsonEncode({
            'user': {'userId': 'u1', 'username': 'bob'},
          }),
          200,
        );
      });

      final client = buildClient(httpClient: httpClient, store: store);
      final states = <OidcAuthState>[];
      client.authStateChanges.listen(states.add);

      final launcher = FakeLauncher(onLaunch: (authorizeUrl, scheme) {
        final state = authorizeUrl.queryParameters['state']!;
        return Uri.parse(
            '$_relayTo?code=c&state=${Uri.encodeComponent(state)}');
      });

      final user = await client.signInRelay('google',
          launcher: launcher, relayTo: _relayTo);

      expect(user.userId, 'u1');
      expect(user.groups, isEmpty);
      // Cookie flow: no bearer tokens persisted.
      expect(await store.get('access_token'), isNull);
      expect(await store.get('refresh_token'), isNull);
      await Future.delayed(Duration.zero);
      expect(states.last, isA<OidcSignedIn>());
    });

    test('throws OidcUnknownProviderException for an unknown provider',
        () async {
      final httpClient = MockClient((_) async => http.Response('{}', 200));
      final client = buildClient(httpClient: httpClient);
      final launcher = FakeLauncher(onLaunch: (_, __) => Uri.parse(_relayTo));

      expect(
        () => client.signInRelay('unknown',
            launcher: launcher, relayTo: _relayTo),
        throwsA(isA<OidcUnknownProviderException>()
            .having((e) => e.provider, 'provider', 'unknown')),
      );
    });

    test('throws OidcCallbackException on state mismatch', () async {
      final httpClient = MockClient((req) async {
        if (req.url.path.contains('/auth/authorize-params/')) {
          final csrf = (jsonDecode(req.body) as Map)['csrf'] as String;
          return http.Response(
            jsonEncode({
              'authorizeUrl': 'https://idp.example.com/authorize',
              'clientId': 'cid',
              'scopes': ['openid'],
              'kind': 'oidc-builtin',
              'state': makeStateEnvelope(csrf: csrf),
            }),
            200,
          );
        }
        return http.Response('{}', 200);
      });
      final client = buildClient(httpClient: httpClient);
      final launcher = FakeLauncher(
        onLaunch: (_, __) =>
            Uri.parse('$_relayTo?code=c&state=a-totally-different-state'),
      );

      expect(
        () =>
            client.signInRelay('google', launcher: launcher, relayTo: _relayTo),
        throwsA(isA<OidcCallbackException>()
            .having((e) => e.message, 'message', 'State mismatch in callback')),
      );
    });

    test('throws OidcCallbackException on CSRF mismatch inside envelope',
        () async {
      // The server echoes a state envelope whose csrf does NOT match what the
      // client generated (simulating a tampered/forged envelope).
      final httpClient = MockClient((req) async {
        if (req.url.path.contains('/auth/authorize-params/')) {
          return http.Response(
            jsonEncode({
              'authorizeUrl': 'https://idp.example.com/authorize',
              'clientId': 'cid',
              'scopes': ['openid'],
              'kind': 'oidc-builtin',
              'state':
                  makeStateEnvelope(csrf: 'attacker-controlled-csrf-value-xxx'),
            }),
            200,
          );
        }
        return http.Response('{}', 200);
      });
      final client = buildClient(httpClient: httpClient);
      final launcher = FakeLauncher(onLaunch: (authorizeUrl, scheme) {
        final state = authorizeUrl.queryParameters['state']!;
        return Uri.parse(
            '$_relayTo?code=c&state=${Uri.encodeComponent(state)}');
      });

      expect(
        () =>
            client.signInRelay('google', launcher: launcher, relayTo: _relayTo),
        throwsA(isA<OidcCallbackException>().having(
            (e) => e.message, 'message', 'CSRF mismatch in state envelope')),
      );
    });

    test('throws OidcCallbackException when the relay carries an IdP error',
        () async {
      final httpClient = MockClient((req) async {
        if (req.url.path.contains('/auth/authorize-params/')) {
          final csrf = (jsonDecode(req.body) as Map)['csrf'] as String;
          return http.Response(
            jsonEncode({
              'authorizeUrl': 'https://idp.example.com/authorize',
              'clientId': 'cid',
              'scopes': ['openid'],
              'kind': 'oidc-builtin',
              'state': makeStateEnvelope(csrf: csrf),
            }),
            200,
          );
        }
        return http.Response('{}', 200);
      });
      final client = buildClient(httpClient: httpClient);
      final launcher = FakeLauncher(
        onLaunch: (_, __) => Uri.parse(
            '$_relayTo?error=access_denied&error_description=User+cancelled'),
      );

      expect(
        () =>
            client.signInRelay('google', launcher: launcher, relayTo: _relayTo),
        throwsA(isA<OidcCallbackException>()
            .having((e) => e.message, 'message', contains('access_denied'))),
      );
    });

    test('throws OidcCallbackException when authorize-params request fails',
        () async {
      final httpClient = MockClient((req) async {
        if (req.url.path.contains('/auth/authorize-params/')) {
          return http.Response(
              jsonEncode(
                  {'error': 'invalid_relay', 'reason': 'unknown-origin'}),
              400);
        }
        return http.Response('{}', 200);
      });
      final client = buildClient(httpClient: httpClient);
      final launcher = FakeLauncher(onLaunch: (_, __) => Uri.parse(_relayTo));

      expect(
        () =>
            client.signInRelay('google', launcher: launcher, relayTo: _relayTo),
        throwsA(isA<OidcCallbackException>()),
      );
    });

    test('propagates OidcCancelledException from the launcher', () async {
      final httpClient = MockClient((req) async {
        final csrf = (jsonDecode(req.body) as Map)['csrf'] as String;
        return http.Response(
          jsonEncode({
            'authorizeUrl': 'https://idp.example.com/authorize',
            'clientId': 'cid',
            'scopes': ['openid'],
            'kind': 'oidc-builtin',
            'state': makeStateEnvelope(csrf: csrf),
          }),
          200,
        );
      });
      final client = buildClient(httpClient: httpClient);
      final launcher = FakeLauncher(onLaunch: (_, __) {
        throw OidcCancelledException();
      });

      expect(
        () =>
            client.signInRelay('google', launcher: launcher, relayTo: _relayTo),
        throwsA(isA<OidcCancelledException>()),
      );
    });

    test('throws OidcCallbackException when callback is missing code',
        () async {
      final httpClient = MockClient((req) async {
        if (req.url.path.contains('/auth/authorize-params/')) {
          final csrf = (jsonDecode(req.body) as Map)['csrf'] as String;
          return http.Response(
            jsonEncode({
              'authorizeUrl': 'https://idp.example.com/authorize',
              'clientId': 'cid',
              'scopes': ['openid'],
              'kind': 'oidc-builtin',
              'state': makeStateEnvelope(csrf: csrf),
            }),
            200,
          );
        }
        return http.Response('{}', 200);
      });
      final client = buildClient(httpClient: httpClient);
      final launcher = FakeLauncher(onLaunch: (authorizeUrl, scheme) {
        final state = authorizeUrl.queryParameters['state']!;
        return Uri.parse('$_relayTo?state=${Uri.encodeComponent(state)}');
      });

      expect(
        () =>
            client.signInRelay('google', launcher: launcher, relayTo: _relayTo),
        throwsA(isA<OidcCallbackException>().having((e) => e.message, 'message',
            "Callback URI missing 'code' parameter")),
      );
    });
  });

  group('cookie session (shared SessionStore)', () {
    test('captures the session cookie set by /exchange', () async {
      final session = InMemorySessionStore();
      final httpClient = MockClient((req) async {
        if (req.url.path.contains('/auth/authorize-params/')) {
          final csrf = (jsonDecode(req.body) as Map)['csrf'] as String;
          return http.Response(
            jsonEncode({
              'authorizeUrl': 'https://idp.example.com/authorize',
              'clientId': 'cid',
              'scopes': ['openid'],
              'kind': 'oidc-builtin',
              'state': makeStateEnvelope(csrf: csrf),
            }),
            200,
          );
        }
        // exchange sets a session cookie
        return http.Response(
          jsonEncode({
            'user': {'userId': 'u1', 'username': 'bob'},
          }),
          200,
          headers: {
            'set-cookie': 'blocks_session=sess-abc-123; Path=/; HttpOnly'
          },
        );
      });

      final client = OidcClient(
        exchangePath: '/auth/exchange',
        refreshPath: '/auth/refresh',
        signOutPath: '/auth/signout',
        providers: ['google'],
        providerConfigs: {},
        baseUrl: 'http://localhost:3001',
        tokenStore: InMemoryTokenStore(),
        sessionStore: session,
        httpClient: httpClient,
      );

      final launcher = FakeLauncher(onLaunch: (authorizeUrl, scheme) {
        final state = authorizeUrl.queryParameters['state']!;
        return Uri.parse(
            '$_relayTo?code=c&state=${Uri.encodeComponent(state)}');
      });

      await client.signInRelay('google', launcher: launcher, relayTo: _relayTo);

      expect(session.cookies['blocks_session'], 'sess-abc-123');
      expect(session.cookieHeader, contains('blocks_session=sess-abc-123'));
    });

    test(
        'cookie captured at exchange is replayed on a subsequent BlocksClient RPC call',
        () async {
      // The OidcClient and BlocksClient share ONE SessionStore instance — this
      // is what the codegen wires up (sessionStore: _client.sessionStore).
      final session = InMemorySessionStore();

      final oidcHttp = MockClient((req) async {
        if (req.url.path.contains('/auth/authorize-params/')) {
          final csrf = (jsonDecode(req.body) as Map)['csrf'] as String;
          return http.Response(
            jsonEncode({
              'authorizeUrl': 'https://idp.example.com/authorize',
              'clientId': 'cid',
              'scopes': ['openid'],
              'kind': 'oidc-builtin',
              'state': makeStateEnvelope(csrf: csrf),
            }),
            200,
          );
        }
        return http.Response(
          jsonEncode({
            'user': {'userId': 'u1', 'username': 'bob'},
          }),
          200,
          headers: {'set-cookie': 'blocks_session=sess-xyz; Path=/'},
        );
      });

      final oidc = OidcClient(
        exchangePath: '/auth/exchange',
        refreshPath: '/auth/refresh',
        signOutPath: '/auth/signout',
        providers: ['google'],
        providerConfigs: {},
        baseUrl: 'http://localhost:3001',
        tokenStore: InMemoryTokenStore(),
        sessionStore: session,
        httpClient: oidcHttp,
      );

      final launcher = FakeLauncher(onLaunch: (authorizeUrl, scheme) {
        final state = authorizeUrl.queryParameters['state']!;
        return Uri.parse(
            '$_relayTo?code=c&state=${Uri.encodeComponent(state)}');
      });
      await oidc.signInRelay('google', launcher: launcher, relayTo: _relayTo);

      // Now a BlocksClient sharing the same SessionStore makes an RPC call.
      String? sentCookie;
      final rpcHttp = MockClient((req) async {
        sentCookie = req.headers['cookie'];
        return http.Response(
            jsonEncode({'jsonrpc': '2.0', 'result': 'ok', 'id': 1}), 200);
      });
      final blocks = BlocksClient(
        baseUrl: 'http://localhost:3001',
        client: rpcHttp,
        sessionStore: session,
      );

      final result = await blocks.call('someMethod', {});
      expect(result, 'ok');
      expect(sentCookie, 'blocks_session=sess-xyz');
    });

    test('signOut clears the session cookie', () async {
      final session = InMemorySessionStore();
      session.setCookies('blocks_session=live; Path=/');

      final httpClient = MockClient((_) async => http.Response('{}', 200));
      final client = OidcClient(
        exchangePath: '/auth/exchange',
        refreshPath: '/auth/refresh',
        signOutPath: '/auth/signout',
        providers: ['google'],
        providerConfigs: {},
        baseUrl: 'http://localhost:3001',
        tokenStore: InMemoryTokenStore(),
        sessionStore: session,
        httpClient: httpClient,
      );

      expect(session.cookieHeader, isNotNull);
      await client.signOut();
      expect(session.cookies, isEmpty);
      expect(session.cookieHeader, isNull);
    });
  });

  group('exchange with iss + cookie response', () {
    test('forwards iss and tolerates a {user}-only response', () async {
      Map<String, dynamic>? body;
      final httpClient = MockClient((req) async {
        body = jsonDecode(req.body) as Map<String, dynamic>;
        return http.Response(
          jsonEncode({
            'user': {'userId': 'u9', 'username': 'carol'},
          }),
          200,
        );
      });
      final client = buildClient(httpClient: httpClient);

      final user = await client.exchange(
        code: 'c',
        verifier: 'v',
        callbackUrl: 'http://localhost:3001/auth/callback',
        provider: 'google',
        state: 's',
        nonce: 'n',
        iss: 'https://idp.example.com',
      );

      expect(body!['iss'], 'https://idp.example.com');
      expect(user.userId, 'u9');
    });

    test('throws OidcExchangeException on HTTP error', () async {
      final httpClient = MockClient((_) async => http.Response('', 500));
      final client = buildClient(httpClient: httpClient);

      expect(
        () => client.exchange(
          code: 'c',
          verifier: 'v',
          callbackUrl: 'http://localhost:3001/auth/callback',
          provider: 'google',
          state: 's',
          nonce: 'n',
        ),
        throwsA(isA<OidcExchangeException>()
            .having((e) => e.message, 'message', 'Exchange failed: HTTP 500')),
      );
    });

    test('throws OidcExchangeException when response is missing user',
        () async {
      final httpClient = MockClient(
          (_) async => http.Response(jsonEncode({'session': 'x'}), 200));
      final client = buildClient(httpClient: httpClient);

      expect(
        () => client.exchange(
          code: 'c',
          verifier: 'v',
          callbackUrl: 'http://localhost:3001/auth/callback',
          provider: 'google',
          state: 's',
          nonce: 'n',
        ),
        throwsA(isA<OidcExchangeException>().having((e) => e.message, 'message',
            "Exchange response missing 'user' field")),
      );
    });
  });
}
