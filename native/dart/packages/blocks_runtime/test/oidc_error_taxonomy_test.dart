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
  providerConfigs: {},
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

    test('an exchange with no response carries a TransportException', () async {
      final offline = http.ClientException('offline');
      final client = _client((_) async => throw offline);
      await expectLater(
        _exchange(client),
        throwsA(
          isA<OidcExchangeException>().having(
            (e) => e.cause,
            'cause',
            isA<TransportException>()
                .having((e) => e.statusCode, 'statusCode', isNull)
                .having((e) => e.cause, 'cause', same(offline)),
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
