// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import 'dart:convert';

import 'package:blocks_runtime/blocks_runtime.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:test/test.dart';

const _relayTo = 'testapp://auth';

/// A state envelope as the backend signs it; the client reads only the
/// payload.
String _stateEnvelope(String csrf) {
  final payload = base64Url
      .encode(
        utf8.encode(jsonEncode({'v': 1, 'csrf': csrf, 'relay': _relayTo})),
      )
      .replaceAll('=', '');
  return '$payload.sig';
}

/// A launcher that answers with a redirect carrying a code and the state it
/// was sent, as an IdP that signed the user in does.
class _RedirectLauncher implements BrowserLauncher {
  _RedirectLauncher(this.redirect);

  final String redirect;

  // `cancel` is optional here, so this fits a launch() with or without it.
  @override
  Future<Uri> launch(
    Uri authorizeUrl, {
    required String callbackScheme,
    Future<void>? cancel,
  }) async {
    final state = authorizeUrl.queryParameters['state']!;
    return Uri.parse(
      '$redirect?code=c&state=${Uri.encodeQueryComponent(state)}',
    );
  }
}

/// The authorize-params route's answer for the [request] the client sent.
http.Response _authorizeParams(http.Request request) {
  final csrf = (jsonDecode(request.body) as Map)['csrf'] as String;
  return http.Response(
    jsonEncode({
      'authorizeUrl': 'https://idp.example.com/authorize',
      'clientId': 'cid',
      'scopes': ['openid'],
      'kind': 'oidc-builtin',
      'state': _stateEnvelope(csrf),
      'nonce': 'n',
    }),
    200,
  );
}

/// A response whose headers arrive and whose body then fails, as when the
/// connection drops partway through.
Future<http.StreamedResponse> _brokenBody(http.BaseRequest request) async =>
    http.StreamedResponse(
      Stream<List<int>>.error(
        http.ClientException('Connection closed while receiving data'),
      ),
      200,
      request: request,
    );

/// Every OIDC call, run on a client whose route [failing] gets [fail] and
/// whose other routes answer as a working backend does.
final Map<String, Future<Object?> Function(OidcClient client)> _calls = {
  'restore': (c) => c.restore(),
  'signOut': (c) => c.signOut(),
  'refresh': (c) => c.refresh(),
  'exchange': _exchange,
  'signInDirect (exchange)': (c) => c.signInDirect(
    'google',
    launcher: _RedirectLauncher('myapp://auth'),
    redirectUri: 'myapp://auth',
  ),
  'signIn (authorize-params)': (c) => c.signIn(
    'google',
    launcher: _RedirectLauncher(_relayTo),
    relayTo: _relayTo,
  ),
  'signIn (exchange)': (c) => c.signIn(
    'google',
    launcher: _RedirectLauncher(_relayTo),
    relayTo: _relayTo,
  ),
};

/// The route each of [_calls] fails on.
const _failingRoute = {
  'restore': '/auth/session',
  'signOut': '/auth/signout',
  'refresh': '/auth/refresh',
  'exchange': '/auth/exchange',
  'signInDirect (exchange)': '/auth/exchange',
  'signIn (authorize-params)': '/auth/authorize-params/google',
  'signIn (exchange)': '/auth/exchange',
};

/// A client whose [route] is answered by [fail], and whose authorize-params
/// route otherwise works.
Future<OidcClient> _failingOn(
  String route,
  Future<http.StreamedResponse> Function(http.BaseRequest) fail,
) async {
  final store = InMemoryTokenStore();
  await store.set('refresh_token', 'rt');
  return OidcClient(
    exchangePath: '/auth/exchange',
    refreshPath: '/auth/refresh',
    signOutPath: '/auth/signout',
    sessionPath: '/auth/session',
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
    httpClient: MockClient.streaming((request, body) async {
      if (request.url.path == route) return fail(request);
      final bytes = await body.toBytes();
      final response = _authorizeParams(
        http.Request(request.method, request.url)..bodyBytes = bytes,
      );
      return http.StreamedResponse(
        Stream.value(response.bodyBytes),
        response.statusCode,
        request: request,
      );
    }),
  );
}

class _ThrowingLauncher implements BrowserLauncher {
  _ThrowingLauncher(this.error);

  final Exception error;

  // `cancel` is optional here, so this fits a launch() with or without it.
  @override
  Future<Uri> launch(
    Uri authorizeUrl, {
    required String callbackScheme,
    Future<void>? cancel,
  }) => Future.error(error);
}

OidcClient _client(
  Future<http.Response> Function(http.Request) handler, {
  TokenStore? store,
}) => OidcClient(
  exchangePath: '/auth/exchange',
  refreshPath: '/auth/refresh',
  signOutPath: '/auth/signout',
  sessionPath: '/auth/session',
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
  tokenStore: store ?? InMemoryTokenStore(),
  httpClient: MockClient(handler),
);

Future<OidcUser> _exchange(OidcClient client) => client.exchange(
  code: 'c',
  verifier: 'v',
  callbackUrl: 'http://localhost:3001/auth/callback',
  provider: 'google',
  state: 's',
  nonce: 'n',
);

void main() {
  group('OIDC routes report the general taxonomy', () {
    test('a refused sign-out matches by name', () async {
      final client = _client(
        (_) async => http.Response(
          jsonEncode({
            'error': 'Sign-out did not complete',
            'name': 'SignOutIncompleteException',
          }),
          503,
        ),
      );
      Object? caught;
      try {
        await client.signOut();
      } on Exception catch (e) {
        caught = e;
      }
      expect(isBlocksError(caught, 'SignOutIncompleteException'), isTrue);
      expect(
        caught,
        isA<ApiException>().having((e) => e.status, 'status', 503),
      );
    });

    test('a refused sign-out keeps the server message', () async {
      final client = _client(
        (_) async => http.Response(
          jsonEncode({'error': 'Session store down', 'name': 'Unavailable'}),
          500,
        ),
      );
      await expectLater(
        client.signOut(),
        throwsA(
          isA<ApiException>()
              .having((e) => e.status, 'status', 500)
              .having((e) => e.name, 'name', 'Unavailable')
              .having(
                (e) => e.message,
                'message',
                'Sign-out failed: HTTP 500: Session store down',
              ),
        ),
      );
    });

    test('a refused restore is an ApiException with its name', () async {
      final client = _client(
        (_) async => http.Response(
          jsonEncode({'error': 'Forbidden', 'name': 'AccessDenied'}),
          403,
        ),
      );
      await expectLater(
        client.restore(),
        throwsA(
          isA<ApiException>()
              .having((e) => e.status, 'status', 403)
              .having((e) => e.name, 'name', 'AccessDenied'),
        ),
      );
    });

    test(
      'a refused restore with a body that is not JSON has no name',
      () async {
        final client = _client((_) async => http.Response('<html>', 502));
        await expectLater(
          client.restore(),
          throwsA(
            isA<ApiException>()
                .having((e) => e.status, 'status', 502)
                .having((e) => e.name, 'name', isNull)
                .having(
                  (e) => e.message,
                  'message',
                  'Session request failed: HTTP 502',
                ),
          ),
        );
      },
    );

    test(
      'a 200 refresh without an accessToken is a TransportException',
      () async {
        final store = InMemoryTokenStore();
        await store.set('refresh_token', 'rt');
        for (final body in ['not json', '{}', '{"accessToken": 7}']) {
          final client = _client(
            (_) async => http.Response(body, 200),
            store: store,
          );
          await expectLater(
            client.refresh(),
            throwsA(
              isA<TransportException>().having(
                (e) => e.statusCode,
                'statusCode',
                200,
              ),
            ),
            reason: body,
          );
          expect(await store.get('refresh_token'), 'rt');
        }
      },
    );

    test('a timeout on an auth route is a TransportException', () async {
      final client = _client(
        (_) async => throw http.ClientException('Request stalled'),
      );
      await expectLater(
        client.signOut(),
        throwsA(
          isA<TransportException>()
              .having((e) => e.statusCode, 'statusCode', isNull)
              .having((e) => e.cause, 'cause', isA<http.ClientException>()),
        ),
      );
    });
  });

  group('OidcExchangeException', () {
    test('a refused exchange carries the ApiException as its cause', () async {
      final client = _client(
        (_) async => http.Response(
          jsonEncode({
            'error': 'The sign-in provider refused the sign-in.',
            'name': 'IdpErrorException',
          }),
          400,
        ),
      );
      await expectLater(
        _exchange(client),
        throwsA(
          isA<OidcExchangeException>()
              .having(
                (e) => e.message,
                'message',
                'Exchange failed: HTTP 400: '
                    'The sign-in provider refused the sign-in.',
              )
              .having(
                (e) => e.cause,
                'cause',
                isA<ApiException>()
                    .having((e) => e.status, 'status', 400)
                    .having((e) => e.name, 'name', 'IdpErrorException'),
              ),
        ),
      );
    });

    test('a 200 exchange that is not a JSON object', () async {
      final client = _client((_) async => http.Response('[]', 200));
      await expectLater(
        _exchange(client),
        throwsA(
          isA<OidcExchangeException>().having(
            (e) => e.cause,
            'cause',
            isA<TransportException>().having(
              (e) => e.statusCode,
              'statusCode',
              200,
            ),
          ),
        ),
      );
    });
  });

  group('every OIDC call reports a failed request as a TransportException', () {
    for (final MapEntry(key: name, value: call) in _calls.entries) {
      final route = _failingRoute[name]!;

      test('$name: connection failure', () async {
        final refused = http.ClientException('Connection refused');
        final client = await _failingOn(route, (_) async => throw refused);
        await expectLater(
          call(client),
          throwsA(
            isA<TransportException>()
                .having((e) => e.statusCode, 'statusCode', isNull)
                .having((e) => e.message, 'message', 'Connection refused')
                .having((e) => e.cause, 'cause', same(refused)),
          ),
        );
      });

      test('$name: read failure', () async {
        final client = await _failingOn(route, _brokenBody);
        await expectLater(
          call(client),
          throwsA(
            isA<TransportException>()
                .having((e) => e.statusCode, 'statusCode', isNull)
                .having((e) => e.cause, 'cause', isA<http.ClientException>()),
          ),
        );
      });

      test('$name: cancellation passes through', () async {
        final cancelled = OidcCancelledException();
        final client = await _failingOn(route, (_) async => throw cancelled);
        await expectLater(call(client), throwsA(same(cancelled)));
      });
    }
  });

  group('cancellation', () {
    test('a launcher\'s OidcCancelledException passes through', () async {
      final cancelled = OidcCancelledException('User closed the sheet');
      final client = _client((req) async {
        final csrf = (jsonDecode(req.body) as Map)['csrf'] as String;
        return http.Response(
          jsonEncode({
            'authorizeUrl': 'https://accounts.google.com/o/oauth2/v2/auth',
            'clientId': 'test-client-id',
            'scopes': ['openid'],
            'kind': 'oidc-builtin',
            'state': _stateEnvelope(csrf),
            'nonce': 'n',
          }),
          200,
        );
      });
      final launcher = _ThrowingLauncher(cancelled);
      await expectLater(
        client.signIn('google', launcher: launcher, relayTo: _relayTo),
        throwsA(same(cancelled)),
      );
    });
  });
}
