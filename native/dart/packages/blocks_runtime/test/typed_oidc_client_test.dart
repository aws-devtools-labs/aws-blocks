import 'dart:convert';

import 'package:blocks_runtime/blocks_runtime.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:test/test.dart';

/// The shape a generated client gives the providers a spec names: an enum
/// implementing [OidcProvider] whose values carry the backend's names.
enum TestProvider implements OidcProvider {
  google('google'),
  loginGov('login.gov'),
  github('github');

  const TestProvider(this.providerName);

  @override
  final String providerName;
}

const _relayTo = 'testapp://auth';

/// A provider from some other method's enum.
final class _Other implements OidcProvider {
  const _Other(this.providerName);

  @override
  final String providerName;
}

String _envelope(String csrf) {
  final body = base64Url
      .encode(utf8.encode(jsonEncode({'v': 1, 'csrf': csrf})))
      .replaceAll('=', '');
  return '$body.sig';
}

/// A backend that serves authorize-params and exchange, recording each
/// request.
({MockClient client, List<http.Request> requests}) _backend() {
  final requests = <http.Request>[];
  final client = MockClient((req) async {
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
    );
  });
  return (client: client, requests: requests);
}

Map<String, dynamic> _bodyOf(http.Request req) =>
    jsonDecode(req.body) as Map<String, dynamic>;

/// Captures what a sign-in hands the launcher, and answers as the IdP would.
class _Launcher implements BrowserLauncher {
  _Launcher(this.callback);

  Uri? authorizeUrl;
  String? callbackScheme;

  /// The query the IdP redirects back with, given the authorize URL.
  final Map<String, String> Function(Uri authorizeUrl) callback;

  @override
  Future<Uri> launch(Uri authorizeUrl, {required String callbackScheme}) async {
    this.authorizeUrl = authorizeUrl;
    this.callbackScheme = callbackScheme;
    return Uri(
      scheme: callbackScheme,
      host: 'cb',
      queryParameters: callback(authorizeUrl),
    );
  }
}

_Launcher _relayLauncher() => _Launcher(
  (url) => {'code': 'c', 'state': url.queryParameters['state']!, 'iss': 'i'},
);

OidcClient _client(
  http.Client httpClient, {
  List<String> providers = const ['google', 'login.gov'],
  TokenStore? tokenStore,
}) => OidcClient(
  exchangePath: '/aws-blocks/auth/exchange',
  refreshPath: '/aws-blocks/auth/exchange/refresh',
  signOutPath: '/aws-blocks/auth/signout',
  providers: providers,
  providerConfigs: {
    for (final p in providers)
      p: ProviderConfig(
        authorizeUrl: 'https://idp.example.com/authorize',
        clientId: 'cid-$p',
        scopes: const ['openid'],
        kind: 'oidc-builtin',
      ),
  },
  baseUrl: 'http://localhost:3001/aws-blocks/api',
  tokenStore: tokenStore ?? InMemoryTokenStore(),
  httpClient: httpClient,
);

void main() {
  group('TypedOidcClient', () {
    test('signInRelay forwards the provider name and every argument', () async {
      final backend = _backend();
      final typed = TypedOidcClient<TestProvider>(_client(backend.client));
      final launcher = _relayLauncher();

      final user = await typed.signInRelay(
        TestProvider.loginGov,
        launcher: launcher,
        relayTo: _relayTo,
      );

      expect(user.userId, 'u1');
      // provider: a name that isn't an identifier reaches the wire unchanged.
      expect(
        backend.requests.first.url.path,
        '/aws-blocks/auth/authorize-params/login.gov',
      );
      expect(_bodyOf(backend.requests.last)['provider'], 'login.gov');
      // relayTo: sent to the backend and used as the callback scheme.
      expect(_bodyOf(backend.requests.first)['relayTo'], _relayTo);
      expect(launcher.callbackScheme, 'testapp');
      // launcher: the one passed in ran the authorize step.
      expect(launcher.authorizeUrl, isNotNull);
    });

    test('signIn forwards the provider name and every argument', () async {
      final backend = _backend();
      final typed = TypedOidcClient<TestProvider>(_client(backend.client));
      // The direct flow checks the state it generated, so echo it back.
      final launcher = _Launcher(
        (url) => {'code': 'c', 'state': url.queryParameters['state']!},
      );

      await typed.signIn(
        TestProvider.loginGov,
        launcher: launcher,
        redirectUri: 'myapp://callback',
      );

      // provider: picks that provider's config, and reaches the exchange.
      expect(
        launcher.authorizeUrl!.queryParameters['client_id'],
        'cid-login.gov',
      );
      expect(_bodyOf(backend.requests.single)['provider'], 'login.gov');
      // redirectUri: the IdP redirect_uri, the callback scheme and the
      // exchange's callbackUrl.
      expect(
        launcher.authorizeUrl!.queryParameters['redirect_uri'],
        'myapp://callback',
      );
      expect(launcher.callbackScheme, 'myapp');
      expect(
        _bodyOf(backend.requests.single)['callbackUrl'],
        'myapp://callback',
      );
    });

    test('exchange forwards the provider name and every argument', () async {
      final backend = _backend();
      final typed = TypedOidcClient<TestProvider>(_client(backend.client));

      await typed.exchange(
        code: 'the-code',
        verifier: 'the-verifier',
        callbackUrl: 'http://localhost:3001/aws-blocks/auth/callback',
        provider: TestProvider.google,
        state: 'the-state',
        nonce: 'the-nonce',
        iss: 'the-iss',
      );

      expect(_bodyOf(backend.requests.single), {
        'code': 'the-code',
        'verifier': 'the-verifier',
        'callbackUrl': 'http://localhost:3001/aws-blocks/auth/callback',
        'provider': 'google',
        'state': 'the-state',
        'nonce': 'the-nonce',
        'iss': 'the-iss',
      });
    });

    test('exchange leaves iss out when it is not given', () async {
      final backend = _backend();
      final typed = TypedOidcClient<TestProvider>(_client(backend.client));

      await typed.exchange(
        code: 'c',
        verifier: 'v',
        callbackUrl: 'cb',
        provider: TestProvider.google,
        state: 's',
        nonce: 'n',
      );

      expect(_bodyOf(backend.requests.single).containsKey('iss'), isFalse);
    });

    test('is the client it wraps, so its other members are the client\'s', () {
      final client = _client(_backend().client);
      final typed = TypedOidcClient<TestProvider>(client);

      expect(identical(typed, client), isTrue);
      expect(typed.untyped, same(client));
      expect(typed.providers, ['google', 'login.gov']);
      expect(typed.toJson(), client.toJson());
    });

    test('a provider the backend does not list throws '
        'OidcUnknownProviderException, not a type error', () {
      final typed = TypedOidcClient<TestProvider>(
        _client(_backend().client, providers: const ['google']),
      );
      expect(
        () => typed.signInRelay(
          TestProvider.github,
          launcher: _relayLauncher(),
          relayTo: _relayTo,
        ),
        throwsA(
          isA<OidcUnknownProviderException>().having(
            (e) => e.provider,
            'provider',
            'github',
          ),
        ),
      );
    });

    test('typed as an OidcClient, it takes provider names again', () async {
      final backend = _backend();
      final OidcClient asClient = TypedOidcClient<TestProvider>(
        _client(backend.client),
      );

      await asClient.signInRelay(
        'google',
        launcher: _relayLauncher(),
        relayTo: _relayTo,
      );
      expect(_bodyOf(backend.requests.last)['provider'], 'google');

      expect(
        () => asClient.signInRelay(
          'nope',
          launcher: _relayLauncher(),
          relayTo: _relayTo,
        ),
        throwsA(isA<OidcUnknownProviderException>()),
      );
    });

    test(
      'wraps a client hydrated from a descriptor, keeping its descriptor',
      () {
        final descriptor = {
          '__blocks': 'oidc/client',
          'providers': ['google'],
          'providerConfigs': <String, dynamic>{},
          'exchangePath': '/aws-blocks/auth/exchange',
          'signOutPath': '/aws-blocks/auth/signout',
        };
        final typed = TypedOidcClient<TestProvider>(
          OidcClient.fromJson(
            descriptor,
            baseUrl: 'http://localhost:3001',
            tokenStore: InMemoryTokenStore(),
          ),
        );
        expect(typed.toJson(), descriptor);
      },
    );
  });

  group('exchange', () {
    test('throws OidcUnknownProviderException for a provider the client does '
        'not list, and sends nothing', () {
      final backend = _backend();
      final typed = TypedOidcClient<TestProvider>(
        _client(backend.client, providers: const ['google']),
      );
      expect(
        () => typed.exchange(
          code: 'c',
          verifier: 'v',
          callbackUrl: 'cb',
          provider: TestProvider.github,
          state: 's',
          nonce: 'n',
        ),
        throwsA(
          isA<OidcUnknownProviderException>().having(
            (e) => e.provider,
            'provider',
            'github',
          ),
        ),
      );
      expect(backend.requests, isEmpty);
    });

    test('an untyped client rejects an unlisted name the same way', () {
      final backend = _backend();
      final client = _client(backend.client, providers: const ['google']);
      expect(
        () => client.exchange(
          code: 'c',
          verifier: 'v',
          callbackUrl: 'cb',
          provider: 'nope',
          state: 's',
          nonce: 'n',
        ),
        throwsA(isA<OidcUnknownProviderException>()),
      );
      expect(backend.requests, isEmpty);
    });

    test('a widened client still rejects another enum\'s unlisted value', () {
      final backend = _backend();
      final TypedOidcClient<OidcProvider> widened =
          TypedOidcClient<TestProvider>(
            _client(backend.client, providers: const ['google']),
          );
      expect(
        () => widened.signInRelay(
          const _Other('okta'),
          launcher: _relayLauncher(),
          relayTo: _relayTo,
        ),
        throwsA(isA<OidcUnknownProviderException>()),
      );
      expect(backend.requests, isEmpty);
    });
  });

  group('OidcClient.signIn', () {
    test('throws OidcUnknownProviderException for a provider it does not '
        'list, rather than failing a null check', () {
      final client = _client(_backend().client, providers: const ['google']);
      expect(
        () => client.signIn(
          'github',
          launcher: _relayLauncher(),
          redirectUri: 'myapp://callback',
        ),
        throwsA(
          isA<OidcUnknownProviderException>().having(
            (e) => e.provider,
            'provider',
            'github',
          ),
        ),
      );
    });

    test('throws OidcUnknownProviderException for a listed provider with no '
        'config', () {
      final client = OidcClient(
        exchangePath: '/aws-blocks/auth/exchange',
        refreshPath: '/aws-blocks/auth/exchange/refresh',
        signOutPath: '/aws-blocks/auth/signout',
        providers: const ['google'],
        providerConfigs: const {},
        baseUrl: 'http://localhost:3001',
        tokenStore: InMemoryTokenStore(),
        httpClient: _backend().client,
      );
      expect(
        () => client.signIn(
          'google',
          launcher: _relayLauncher(),
          redirectUri: 'myapp://callback',
        ),
        throwsA(isA<OidcUnknownProviderException>()),
      );
    });
  });
}
