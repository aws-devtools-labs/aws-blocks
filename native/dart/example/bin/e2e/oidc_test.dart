// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/// OIDC server-relay + cookie-persistence E2E suite against
/// test-apps/native-bindings' `auth-oidc` block (`Auth` with the local stub
/// IdP).
///
/// It drives the real `OidcClient.signInRelay` flow headlessly — no device, no
/// real IdP — by replacing the browser with an HTTP-driven [BrowserLauncher]
/// that follows the redirect chain the stub IdP produces (it auto-approves),
/// capturing the final custom-scheme relay redirect.
///
/// native-bindings target:
///   - provider:      google            (stubIdp(), keyed `google`)
///   - relay origin:  nativebindings://auth
///   - RPC (authed):  api.oidcRequireAuth   (bound to the `auth-oidc` block)
///   - auth routes:   `Auth`'s fixed routes under /aws-blocks/auth/* at the
///                    API **origin** — NOT under the JSON-RPC prefix
///                    (/aws-blocks/api). The client is built with
///                    [OidcClient]'s default authorize-params and callback
///                    paths, which are exactly those routes.
///
/// Locally the IdP is `Auth`'s stub, which auto-approves. A deployed backend
/// serves the stub only when the provider opts in with `unsafeAllowDeployed`
/// (the native-bindings test app does), so there the suite runs only with
/// `RUN_OIDC=1`, which says the backend serves a headless IdP: that deployed
/// stub, or a real, auto-approving IdP (`NATIVE_E2E_OIDC_ISSUER`; see
/// `.github/workflows/native-sdk-e2e.yml`). Otherwise it reports a visible SKIP.
///
///   dart run bin/e2e/oidc_test.dart          # BLOCKS_URL defaults to localhost
library;

import 'dart:convert';
import 'dart:io';

import 'package:blocks_runtime/blocks_runtime.dart';
import 'package:http/http.dart' as http;
import 'harness.dart';

const _provider = 'google';
const _relayTo = 'nativebindings://auth';

/// HTTP-driven [BrowserLauncher] standing in for a real browser.
///
/// Manually follows the redirect chain (the stub IdP `/authorize` auto-approves
/// with a 302 → backend relay `/callback`, which 302s to the custom-scheme
/// relay target). Returns the first redirect whose scheme matches
/// [callbackScheme] (e.g. `nativebindings`).
class HttpRelayLauncher implements BrowserLauncher {
  HttpRelayLauncher(this._client);

  final http.Client _client;

  /// Human-readable trace of every hop, for diagnostics on failure.
  final List<String> trace = [];

  @override
  Future<Uri> launch(Uri authorizeUrl, {required String callbackScheme}) async {
    var current = authorizeUrl;
    for (var hop = 0; hop < 10; hop++) {
      final req = http.Request('GET', current)..followRedirects = false;
      final streamed = await _client.send(req);
      final resp = await http.Response.fromStream(streamed);
      trace.add('GET $current -> ${resp.statusCode}');

      if (resp.statusCode >= 300 && resp.statusCode < 400) {
        final loc = resp.headers['location'];
        if (loc == null || loc.isEmpty) {
          throw StateError(
            'Redirect (${resp.statusCode}) without Location at $current',
          );
        }
        final next = current.resolve(loc);
        if (next.scheme == callbackScheme) {
          trace.add('captured relay redirect -> $next');
          return next;
        }
        current = next;
        continue;
      }

      throw StateError(
        'Expected redirect chain to reach "$callbackScheme://" but got '
        'HTTP ${resp.statusCode} at $current\nbody: ${resp.body}',
      );
    }
    throw StateError(
      'Too many redirects without reaching "$callbackScheme://"',
    );
  }
}

/// Strip the JSON-RPC suffix to derive the API origin the OIDC relay routes
/// (/aws-blocks/auth/*) resolve against. Handles both the deployed
/// (`/aws-blocks/api`) and the local dev (`/aws-blocks`) layouts.
String _deriveOidcBase(String blocksUrl) {
  final uri = Uri.parse(blocksUrl.trim());
  // The auth routes (/aws-blocks/auth/*) resolve against the API *origin*
  // (scheme://host plus any API Gateway stage prefix like `/prod`), NOT the
  // JSON-RPC path; the route paths carry the `/aws-blocks` prefix. Strip
  // everything from the first `/aws-blocks` segment onward, so this is robust to
  // a path containing `/aws-blocks/api` once, multiple times (a doubled
  // BLOCKS_URL), or just `/aws-blocks` — all collapse to the same origin+stage.
  final idx = uri.path.indexOf('/aws-blocks');
  final stagePath = idx >= 0 ? uri.path.substring(0, idx) : uri.path;
  final base = '${uri.scheme}://${uri.authority}$stagePath';
  return base.replaceAll(RegExp(r'/+$'), '');
}

void main() async {
  final rpcUrl =
      (Platform.environment['BLOCKS_URL'] ??
              'http://localhost:3001/aws-blocks/api')
          .trim();
  final oidcBase = _deriveOidcBase(rpcUrl);

  print('=== OIDC relay validation (headless) — native-bindings ===');
  print('RPC base   : $rpcUrl');
  print('OIDC base  : $oidcBase');
  print('provider   : $_provider');
  print('relayTo    : $_relayTo');

  if (!isLocalEndpoint() && Platform.environment['RUN_OIDC'] != '1') {
    group('OIDC: relay sign-in');
    skip(
      "Auth's stub IdP is local-only unless deployed with unsafeAllowDeployed. "
      'Against a deployed backend this suite needs RUN_OIDC=1 and a headless '
      'IdP: that deployed stub, or a real, auto-approving one '
      '(NATIVE_E2E_OIDC_ISSUER; see .github/workflows/native-sdk-e2e.yml)',
    );
    printResults();
    return;
  }

  final httpClient = http.Client();

  // Backing persistence (the bytes that survive a "restart") + the cookie store
  // that owns all cookie logic and write-through-persists to the TokenStore.
  final tokenStore = InMemoryTokenStore();
  final session = PersistentSessionStore(store: tokenStore);
  await session.load();

  // The client is built from the `Auth` block's fixed routes
  // (packages/bb-auth DESIGN.md → Routes), with no server-supplied descriptor.
  // The authorize-params and callback paths are left to OidcClient's defaults,
  // which name exactly those routes.
  final oidc = OidcClient(
    exchangePath: '/aws-blocks/auth/exchange',
    refreshPath: '/aws-blocks/auth/exchange/refresh',
    signOutPath: '/aws-blocks/auth/signout',
    providers: const [_provider],
    providerConfigs: const {},
    baseUrl: oidcBase,
    tokenStore: tokenStore,
    sessionStore: session,
    httpClient: httpClient,
  );

  final launcher = HttpRelayLauncher(httpClient);

  // A1 — authorize-params returns a server-signed state envelope that decodes
  // and round-trips the SDK-supplied csrf + relayTo.
  group('OIDC: authorize-params returns a signed, decodable state envelope');
  try {
    final csrf = OidcClient.generateRandom();
    final resp = await httpClient.post(
      Uri.parse('$oidcBase${oidc.authorizeParamsBasePath}/$_provider'),
      headers: const {'content-type': 'application/json'},
      body: jsonEncode({'csrf': csrf, 'relayTo': _relayTo}),
    );
    final ok200 = resp.statusCode == 200;
    final body = ok200
        ? jsonDecode(resp.body) as Map<String, dynamic>
        : <String, dynamic>{};
    final stateEnvelope = body['state'] as String?;
    final payload = stateEnvelope != null
        ? StatePayload.decodeEnvelope(stateEnvelope)
        : null;
    final roundTrips =
        payload != null && payload.csrf == csrf && payload.relay == _relayTo;
    check(
      ok200 && roundTrips,
      'authorize-params signed state decodes + round-trips csrf/relay (http=${resp.statusCode})',
    );
  } catch (e) {
    check(false, 'authorize-params signed state envelope decodes — threw: $e');
  }

  // A2 — signInRelay completes; /exchange returns the user and its Set-Cookie
  // is captured into the (persistent) SessionStore.
  group('OIDC: signInRelay completes + session cookie captured');
  OidcUser? user;
  try {
    user = await oidc.signInRelay(
      _provider,
      launcher: launcher,
      relayTo: _relayTo,
    );
    final cookieCaptured =
        session.cookies.isNotEmpty && session.cookieHeader != null;
    check(
      user.userId.isNotEmpty && cookieCaptured,
      'signInRelay returned user ${user.userId} and set the session cookie',
    );
  } catch (e) {
    check(false, 'signInRelay completes + cookie captured — threw: $e');
    stderr.writeln('  launcher trace:\n    ${launcher.trace.join('\n    ')}');
  }

  // Let the fire-and-forget write-through to the TokenStore flush before we
  // read it back into a fresh store (proves real persistence).
  await Future<void>.delayed(const Duration(milliseconds: 100));
  final persistedBytes = await tokenStore.get('_session_cookies');

  // A3 — a follow-up authenticated RPC succeeds via the replayed cookie
  // (the Blocks client shares the SAME SessionStore instance).
  group('OIDC: authenticated RPC via the replayed cookie');
  try {
    final blocks = Blocks(baseUrl: rpcUrl, sessionStore: session);
    final me = await blocks.api.oidcRequireAuth();
    check(
      me.userId.isNotEmpty,
      'api.oidcRequireAuth succeeds (userId=${me.userId}, provider=${me.provider})',
    );
  } catch (e) {
    check(false, 'authenticated RPC via replayed cookie — threw: $e');
  }

  // A4 — persistence: re-hydrate a FRESH PersistentSessionStore from the SAME
  // TokenStore bytes and confirm the authenticated RPC still works.
  group('OIDC: persistence across a fresh session store');
  try {
    final rehydrated = PersistentSessionStore(store: tokenStore);
    await rehydrated.load();
    final blocks2 = Blocks(baseUrl: rpcUrl, sessionStore: rehydrated);
    final me2 = await blocks2.api.oidcRequireAuth();
    final hydratedFromBytes =
        persistedBytes != null && rehydrated.cookies.isNotEmpty;
    check(
      hydratedFromBytes && me2.userId.isNotEmpty,
      'fresh PersistentSessionStore re-hydrated from TokenStore still authenticates '
      '(userId=${me2.userId})',
    );
  } catch (e) {
    check(
      false,
      'persistence across a fresh PersistentSessionStore — threw: $e',
    );
  }

  // A5 — sign out clears the session.
  group('OIDC: sign out');
  try {
    final out = await Blocks(
      baseUrl: rpcUrl,
      sessionStore: session,
    ).api.oidcSignOut();
    check(out.success, 'oidcSignOut returns success');
  } catch (e) {
    check(false, 'oidcSignOut — threw: $e');
  }

  httpClient.close();
  printResults();
}
