import 'dart:convert';

import 'package:blocks_runtime/blocks_runtime.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:test/test.dart';

const _user = {
  'userId': 'u1',
  'username': 'alice',
  'groups': ['admin'],
};

/// A client on the default Auth routes whose requests [handler] answers, and
/// the states its [OidcClient.authStateChanges] emits.
({OidcClient client, List<OidcAuthState> states}) _client(
  Future<http.Response> Function(http.Request) handler,
) {
  final client = OidcClient(
    exchangePath: '/aws-blocks/auth/exchange',
    refreshPath: '/aws-blocks/auth/exchange/refresh',
    signOutPath: '/aws-blocks/auth/signout',
    providers: ['google'],
    providerConfigs: {},
    baseUrl: 'http://localhost:3000/aws-blocks/api',
    tokenStore: InMemoryTokenStore(),
    httpClient: MockClient(handler),
  );
  final states = <OidcAuthState>[];
  client.authStateChanges.listen(states.add);
  return (client: client, states: states);
}

Future<OidcUser> _exchange(OidcClient client) => client.exchange(
  code: 'code',
  verifier: 'verifier',
  callbackUrl: 'myapp://callback',
  provider: 'google',
  state: 'state',
  nonce: 'nonce',
);

http.Response _signedIn() => http.Response(
  jsonEncode({
    'accessToken': 'at',
    'refreshToken': 'rt',
    'expiresIn': 3600,
    'user': _user,
  }),
  200,
);

void main() {
  group('OidcClient authState', () {
    test('is OidcLoading before any state is emitted', () {
      final t = _client((_) async => http.Response('', 500));
      expect(t.client.authState, isA<OidcLoading>());
    });

    test('is the signed-in state a sign-in emits', () async {
      final t = _client((_) async => _signedIn());

      final user = await _exchange(t.client);
      await Future<void>.delayed(Duration.zero);

      expect(t.states, [isA<OidcSignedIn>()]);
      expect(t.client.authState, same(t.states.last));
      expect((t.client.authState as OidcSignedIn).user.userId, user.userId);
    });

    test('is the signed-out state a sign-out emits', () async {
      final t = _client(
        (req) async => req.url.path.endsWith('/signout')
            ? http.Response('', 204)
            : _signedIn(),
      );
      await _exchange(t.client);

      await t.client.signOut();
      await Future<void>.delayed(Duration.zero);

      expect(t.states, [isA<OidcSignedIn>(), isA<OidcSignedOut>()]);
      expect(t.client.authState, same(t.states.last));
    });

    test(
      'is signed out after a sign-out the server could not finish',
      () async {
        final t = _client(
          (req) async => req.url.path.endsWith('/signout')
              ? http.Response(
                  jsonEncode({
                    'error': 'Sign-out did not complete',
                    'name': 'SignOutIncompleteException',
                  }),
                  503,
                )
              : _signedIn(),
        );
        await _exchange(t.client);

        await expectLater(
          t.client.signOut(),
          throwsA(isA<OidcRequestException>()),
        );
        await Future<void>.delayed(Duration.zero);

        expect(t.states.last, isA<OidcSignedOut>());
        expect(t.client.authState, same(t.states.last));
      },
    );

    test(
      'is the state restore emits, and unchanged when restore fails',
      () async {
        var status = 200;
        final t = _client(
          (_) async => http.Response(jsonEncode({'user': _user}), status),
        );

        await t.client.restore();
        await Future<void>.delayed(Duration.zero);
        expect(t.client.authState, isA<OidcSignedIn>());
        expect(t.client.authState, same(t.states.last));

        status = 500;
        await expectLater(t.client.restore(), throwsA(anything));
        await Future<void>.delayed(Duration.zero);
        expect(t.states, hasLength(1));
        expect(t.client.authState, same(t.states.last));

        status = 401;
        expect(await t.client.restore(), isNull);
        await Future<void>.delayed(Duration.zero);
        expect(t.client.authState, isA<OidcSignedOut>());
        expect(t.client.authState, same(t.states.last));
      },
    );

    test('a TypedOidcClient reads the client it wraps', () async {
      final t = _client((_) async => _signedIn());
      final typed = TypedOidcClient<_Provider>(t.client);

      await _exchange(t.client);
      expect(typed.authState, same(t.client.authState));
      expect(typed.authState, isA<OidcSignedIn>());
    });
  });
}

final class _Provider implements OidcProvider {
  @override
  String get providerName => 'google';
}
