// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/// OIDC server-relay + cookie-persistence E2E suite against
/// test-apps/native-bindings' `auth-oidc` block (`Auth` with the local stub
/// IdP).
///
/// It drives the real `OidcClient.signIn` flow headlessly — no device, no
/// real IdP — by replacing the browser with an HTTP-driven [BrowserLauncher]
/// that follows the redirect chain the stub IdP produces (it auto-approves),
/// capturing the final custom-scheme relay redirect.
///
/// native-bindings target:
///   - provider:      google            (stubIdp(), keyed `google`)
///   - relay origin:  nativebindings://auth
///   - RPC (authed):  api.oidcRequireAuth   (bound to the `auth-oidc` block)
///   - auth routes:   `Auth`'s fixed routes under /cdk-blocks/auth/* at the
///                    API **origin** — NOT under the JSON-RPC prefix
///                    (/cdk-blocks/api). The client is the one the
///                    backend's `oidcAuthApi.getClient()` returns
///                    (`Auth.createOidcApi()`), on the RPC URL; it cuts
///                    the origin itself.
///   - state machine: oidcAuthStateApi.getAuthState for the signed-in state;
///                    the sign-in button comes from the client's `providers`.
///
/// Locally the IdP is `Auth`'s stub, which auto-approves. A deployed backend
/// serves the stub only on a sandbox deployment (the native-bindings test app
/// always deploys as one), so there the suite runs only with
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

// The generated enum of the providers `oidcAuthApi.getClient()` names.
const _provider = OidcAuthApiGetClientProvider.google;
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

  /// [uri] without its query string or fragment, for the trace and error
  /// messages. The authorize, callback and relay URLs carry the OAuth `code`,
  /// `state` and similar values in the query, which are not written to logs.
  static String _withoutQuery(Uri uri) =>
      uri.toString().split(RegExp('[?#]')).first;

  @override
  Future<Uri> launch(
    Uri authorizeUrl, {
    required String callbackScheme,
    Future<void>? cancel,
  }) async {
    var current = authorizeUrl;
    for (var hop = 0; hop < 10; hop++) {
      final req = http.Request('GET', current)..followRedirects = false;
      final streamed = await _client.send(req);
      final resp = await http.Response.fromStream(streamed);
      trace.add('GET ${_withoutQuery(current)} -> ${resp.statusCode}');

      if (resp.statusCode >= 300 && resp.statusCode < 400) {
        final loc = resp.headers['location'];
        if (loc == null || loc.isEmpty) {
          throw StateError(
            'Redirect (${resp.statusCode}) without Location at '
            '${_withoutQuery(current)}',
          );
        }
        final next = current.resolve(loc);
        if (next.scheme == callbackScheme) {
          trace.add('captured relay redirect -> ${_withoutQuery(next)}');
          return next;
        }
        current = next;
        continue;
      }

      throw StateError(
        'Expected redirect chain to reach "$callbackScheme://" but got '
        'HTTP ${resp.statusCode} at ${_withoutQuery(current)}\n'
        // The body length only: the response may echo the request's query.
        'body: ${resp.bodyBytes.length} bytes',
      );
    }
    throw StateError(
      'Too many redirects without reaching "$callbackScheme://"',
    );
  }
}

/// Strip the JSON-RPC suffix to derive the API origin the OIDC relay routes
/// (/cdk-blocks/auth/*) resolve against. Handles both the deployed
/// (`/cdk-blocks/api`) and the local dev (`/cdk-blocks`) layouts.
String _deriveOidcBase(String blocksUrl) {
  final uri = Uri.parse(blocksUrl.trim());
  // The auth routes (/cdk-blocks/auth/*) resolve against the API *origin*
  // (scheme://host plus any API Gateway stage prefix like `/prod`), NOT the
  // JSON-RPC path; the route paths carry the `/cdk-blocks` prefix. Strip
  // everything from the first `/cdk-blocks` segment onward, so this is robust to
  // a path containing `/cdk-blocks/api` once, multiple times (a doubled
  // BLOCKS_URL), or just `/cdk-blocks` — all collapse to the same origin+stage.
  final idx = uri.path.indexOf('/cdk-blocks');
  final stagePath = idx >= 0 ? uri.path.substring(0, idx) : uri.path;
  final base = '${uri.scheme}://${uri.authority}$stagePath';
  return base.replaceAll(RegExp(r'/+$'), '');
}

void main() async {
  final rpcUrl =
      (Platform.environment['BLOCKS_URL'] ??
              'http://localhost:3001/cdk-blocks/api')
          .trim();
  final oidcBase = _deriveOidcBase(rpcUrl);

  print('=== OIDC relay validation (headless) — native-bindings ===');
  print('RPC base   : $rpcUrl');
  print('OIDC base  : $oidcBase');
  print('provider   : ${_provider.providerName}');
  print('relayTo    : $_relayTo');

  if (!isLocalEndpoint() && Platform.environment['RUN_OIDC'] != '1') {
    group('OIDC: relay sign-in');
    skip(
      "Auth's stub IdP runs only locally and on sandbox deployments. "
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

  // The OIDC client comes from the backend's `oidcAuthApi.getClient()`
  // (`Auth.createOidcApi()`). The generated client hydrates it with its own
  // session store, so the cookie the exchange sets is the one the generated
  // calls send.
  Future<TypedOidcClient<OidcAuthApiGetClientProvider>> oidcFor(
    SessionStore sessionStore,
  ) => Blocks(
    baseUrl: rpcUrl,
    sessionStore: sessionStore,
  ).oidcAuthApi.getClient();
  final oidc = await oidcFor(session);
  final blocks = Blocks(baseUrl: rpcUrl, sessionStore: session);

  final launcher = HttpRelayLauncher(httpClient);

  // S1: signed out, as the state machine says, and one sign-in button per
  // provider in the client's `providers`, as an app renders them. The
  // backend may serve other providers too, so only google's is checked.
  group('OIDC: signed out, with a sign-in button per provider');
  try {
    final state = await blocks.oidcAuthStateApi.getAuthState();
    check(
      state.state == AuthStateState.signedOut,
      'getAuthState is signedOut (${state.state.toJson()})',
    );
    final buttons = [
      for (final name in oidc.providers)
        ?OidcAuthApiGetClientProvider.fromProviderName(name),
    ];
    check(
      buttons.contains(_provider),
      'oidc.providers gives a ${_provider.providerName} button '
      '(got ${buttons.map((b) => b.providerName).toList()})',
    );
  } catch (e) {
    check(false, 'getAuthState and providers before sign-in, threw: $e');
  }

  // A1 — authorize-params returns a server-signed state envelope that decodes
  // and round-trips the SDK-supplied csrf + relayTo.
  group('OIDC: authorize-params returns a signed, decodable state envelope');
  try {
    final csrf = OidcClient.generateRandom();
    final resp = await httpClient.post(
      Uri.parse(
        '$oidcBase${oidc.authorizeParamsBasePath}/${_provider.providerName}',
      ),
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

  // A2 — signIn completes; /exchange returns the user and its Set-Cookie
  // is captured into the (persistent) SessionStore.
  group('OIDC: signIn completes + session cookie captured');
  OidcUser? user;
  try {
    user = await oidc.signIn(
      _provider,
      launcher: launcher,
      relayTo: _relayTo,
    );
    final cookieCaptured = session.cookies.isNotEmpty;
    check(
      user.userId.isNotEmpty && cookieCaptured,
      'signIn returned user ${user.userId} and set the session cookie',
    );
  } catch (e) {
    check(false, 'signIn completes + cookie captured — threw: $e');
    stderr.writeln('  launcher trace:\n    ${launcher.trace.join('\n    ')}');
  }

  // S2: the state machine reports the federated session.
  group('OIDC: getAuthState after sign-in');
  try {
    final state = await blocks.oidcAuthStateApi.getAuthState();
    check(
      state.state == AuthStateState.signedIn &&
          state.user?.userId == user?.userId,
      'getAuthState is signedIn as ${state.user?.userId}',
    );
  } catch (e) {
    check(false, 'getAuthState after sign-in, threw: $e');
  }

  // Let the fire-and-forget write-through to the TokenStore flush before we
  // read it back into a fresh store (proves real persistence).
  await Future<void>.delayed(const Duration(milliseconds: 100));
  final persistedBytes = await tokenStore.get('_session_cookies');

  // A3 — a follow-up authenticated RPC succeeds via the replayed cookie
  // (the CDK Blocks client shares the SAME SessionStore instance).
  group('OIDC: authenticated RPC via the replayed cookie');
  try {
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

  // S3: a fresh client on a cookie store reloaded from the same backing
  // store restores the session, as an app does on launch.
  group('OIDC: restore() from a reloaded cookie store');
  try {
    final reloaded = PersistentSessionStore(store: tokenStore);
    await reloaded.load();
    final restored = await (await oidcFor(reloaded)).restore();
    check(
      restored != null && restored.userId == user?.userId,
      'restore() returns ${restored?.userId}',
    );
  } catch (e) {
    check(false, 'restore() while signed in, threw: $e');
  }

  // A5: sign out returns the IdP logout URL and ends the session.
  group('OIDC: sign out');
  try {
    final logoutUrl = await oidc.signOut();
    check(
      logoutUrl != null,
      'signOut() returns a logout URL (${logoutUrl?.path})',
    );
  } catch (e) {
    check(false, 'signOut() threw: $e');
  }
  try {
    final restored = await (await oidcFor(session)).restore();
    check(restored == null, 'restore() is null after signOut()');
    final state = await blocks.oidcAuthStateApi.getAuthState();
    check(
      state.state == AuthStateState.signedOut,
      'getAuthState is signedOut after signOut() (${state.state.toJson()})',
    );
  } catch (e) {
    check(false, 'restore() / getAuthState after signOut(), threw: $e');
  }

  // Desktop sign-in through the runtime's own loopback listener. No
  // launcher is passed, so signIn binds 127.0.0.1 and relays there. The
  // "browser" is an HTTP client that follows the stub IdP's redirects; the
  // last one lands on the real listener, which completes the sign-in.
  group('OIDC: desktop loopback sign-in (real listener)');
  try {
    final loopbackSession = InMemorySessionStore();
    final desktop = await oidcFor(loopbackSession);
    Uri? landed;
    desktop
      ..signInTimeout = const Duration(seconds: 30)
      ..openBrowser = (url) async {
        var current = url;
        for (var hop = 0; hop < 10; hop++) {
          final req = http.Request('GET', current)..followRedirects = false;
          final resp = await http.Response.fromStream(
            await httpClient.send(req),
          );
          final location = resp.headers['location'];
          if (resp.statusCode < 300 ||
              resp.statusCode >= 400 ||
              location == null) {
            landed = current;
            return;
          }
          current = current.resolve(location);
        }
      };
    final signedIn = await desktop.signIn(_provider);
    check(
      landed?.host == '127.0.0.1' && landed?.path == '/oidc/callback',
      'the relay redirect landed on the loopback listener '
      '(${landed?.host}${landed?.path})',
    );
    final me = await Blocks(
      baseUrl: rpcUrl,
      sessionStore: loopbackSession,
    ).api.oidcRequireAuth();
    check(
      me.userId == signedIn.userId,
      'api.oidcRequireAuth succeeds after the loopback sign-in',
    );
    check(
      await desktop.signOut() != null && await desktop.restore() == null,
      'signOut() ends the loopback session',
    );
  } catch (e) {
    check(false, 'desktop loopback sign-in threw: $e');
  }

  // The OidcClient a generated client returns stops when that client is
  // closed, as its own calls do.
  group('OIDC: Blocks.close() stops the OidcClient it returned');
  final closing = Blocks(baseUrl: rpcUrl, sessionStore: InMemorySessionStore());
  final hydrated = await closing.oidcAuthApi.getClient();
  check(await hydrated.restore() == null, 'restore() works while open');
  closing.close();
  try {
    await hydrated.restore();
    check(false, 'restore() after close() throws');
  } on ClientClosedException {
    check(true, 'restore() after close() throws ClientClosedException');
  }
  try {
    await closing.oidcAuthApi.getClient();
    check(false, 'a call after close() throws');
  } on ClientClosedException {
    check(true, 'a call after Blocks.close() throws ClientClosedException');
  }

  httpClient.close();
  printResults();
}
