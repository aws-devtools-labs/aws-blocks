// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/// Two federated `Auth` blocks in test-apps/native-bindings, each signed in
/// through the client its `getClient()` returns:
///
///   - `auth-oidc` (`oidcAuthApi`) on the default routes, signing in with its
///     second provider, `github2`;
///   - `auth-sso` (`ssoOidcApi`) on `/aws-blocks/auth/sso/*`, whose callback is
///     named `return`, signing in with its provider `corp`.
///
/// For each it signs in through the relay, checks an authenticated RPC and the
/// block's state machine, restores the session on a fresh client that shares
/// the cookie store, signs out with `OidcClient.signOut()` (which returns the
/// stub IdP's logout URL), and checks that `restore()` is null afterwards.
/// Then, on one cookie store shared by both blocks, it checks that they stay
/// separate: `auth-sso` refuses an `auth-oidc` session, and signing out of
/// either block leaves the other signed in.
///
/// Like oidc_test.dart, it needs a headless IdP: it runs against the local dev
/// server, and against a deployed backend only with `RUN_OIDC=1`.
///
///   dart run bin/e2e/oidc_multi_block_test.dart   # BLOCKS_URL defaults to localhost
library;

import 'dart:io';

import 'package:blocks_runtime/blocks_runtime.dart';
import 'package:http/http.dart' as http;
import 'harness.dart';
import 'oidc_test.dart' show HttpRelayLauncher;

const _relayTo = 'nativebindings://auth';

/// An [HttpRelayLauncher] that also records the authorize URL each sign-in
/// opens.
class _RecordingLauncher implements BrowserLauncher {
  _RecordingLauncher(this._inner);

  final HttpRelayLauncher _inner;
  final List<Uri> authorizeUrls = [];

  @override
  Future<Uri> launch(
    Uri authorizeUrl, {
    required String callbackScheme,
    Future<void>? cancel,
  }) {
    authorizeUrls.add(authorizeUrl);
    return _inner.launch(
      authorizeUrl,
      callbackScheme: callbackScheme,
      cancel: cancel,
    );
  }
}

void main() async {
  final rpcUrl =
      (Platform.environment['BLOCKS_URL'] ??
              'http://localhost:3001/aws-blocks/api')
          .trim();
  // A deployed API Gateway URL has a stage segment (`/prod`) before
  // `/aws-blocks`; locally it is empty. The auth routes and the stub IdP sit
  // under the same prefix, so every expected path below starts with it.
  final stagePath = _stagePath(rpcUrl);

  if (!isLocalEndpoint() && Platform.environment['RUN_OIDC'] != '1') {
    group('OIDC: getClient() across two federated blocks');
    skip(
      "Auth's stub IdP runs only locally and on sandbox deployments. Against a "
      'deployed backend this suite needs RUN_OIDC=1 (see oidc_test.dart).',
    );
    printResults();
    return;
  }

  final httpClient = http.Client();
  final launcher = HttpRelayLauncher(httpClient);

  // --- auth-oidc, second provider -----------------------------------------
  await _signInRestoreSignOut(
    label: 'auth-oidc via github2',
    rpcUrl: rpcUrl,
    stagePath: stagePath,
    launcher: launcher,
    provider: OidcAuthApiGetClientProvider.github2,
    client: (blocks) => blocks.oidcAuthApi.getClient(),
    state: (blocks) async =>
        (await blocks.oidcAuthStateApi.getAuthState()).state,
    requireAuth: (blocks) async {
      final me = await blocks.api.oidcRequireAuth();
      return (userId: me.userId, provider: me.provider);
    },
  );

  // --- auth-sso, routes under /aws-blocks/auth/sso/ -------------------------
  await _signInRestoreSignOut(
    label: 'auth-sso via corp',
    rpcUrl: rpcUrl,
    stagePath: stagePath,
    launcher: launcher,
    provider: SsoOidcApiGetClientProvider.corp,
    expectedCallbackPath: '$stagePath/aws-blocks/auth/sso/return',
    client: (blocks) => blocks.ssoOidcApi.getClient(),
    state: (blocks) async =>
        (await blocks.ssoAuthStateApi.getAuthState()).state,
    requireAuth: (blocks) async {
      final me = await blocks.api.ssoRequireAuth();
      return (userId: me.userId, provider: me.provider);
    },
  );

  await _blocksStaySeparate(rpcUrl: rpcUrl, launcher: launcher);

  httpClient.close();
  printResults();
}

Future<void> _blocksStaySeparate({
  required String rpcUrl,
  required HttpRelayLauncher launcher,
}) async {
  final session = InMemorySessionStore();
  final blocks = Blocks(baseUrl: rpcUrl, sessionStore: session);
  final oidc = await blocks.oidcAuthApi.getClient();
  final sso = await blocks.ssoOidcApi.getClient();

  group('OIDC getClient(): auth-sso refuses an auth-oidc session');
  try {
    await oidc.signIn(
      OidcAuthApiGetClientProvider.github2,
      launcher: launcher,
      relayTo: _relayTo,
    );
    final oidcSignedIn = await blocks.api.oidcRequireAuth();
    check(
      oidcSignedIn.provider == 'github2',
      'auth-oidc is signed in (provider=${oidcSignedIn.provider})',
    );
    await expectErrorNamed(
      () => blocks.api.ssoRequireAuth(),
      AuthErrorNames.notAuthenticated,
      label: 'api.ssoRequireAuth throws with only auth-oidc signed in',
    );
    final ssoUser = await blocks.api.ssoGetCurrentUser();
    check(
      ssoUser == null,
      'api.ssoGetCurrentUser is null (got: ${ssoUser?.userId})',
    );
    final ssoState = (await blocks.ssoAuthStateApi.getAuthState()).state;
    check(
      ssoState == AuthStateState.signedOut,
      'ssoAuthStateApi is signedOut (got: $ssoState)',
    );
  } catch (e) {
    check(false, 'auth-sso refuses an auth-oidc session threw: $e');
  }

  group(
    'OIDC getClient(): signing out of either block leaves the other signed in',
  );
  try {
    await sso.signIn(
      SsoOidcApiGetClientProvider.corp,
      launcher: launcher,
      relayTo: _relayTo,
    );
    await sso.signOut();
    final ssoAfter = await sso.restore();
    check(ssoAfter == null, 'auth-sso restore() is null after its sign-out');
    check(
      sso.authState is OidcSignedOut,
      'auth-sso\'s client reports signed out (got: ${sso.authState.runtimeType})',
    );
    final oidcAfter = await blocks.api.oidcRequireAuth();
    check(
      oidcAfter.provider == 'github2',
      'auth-oidc is still signed in (provider=${oidcAfter.provider})',
    );
    check(
      oidc.authState is OidcSignedIn,
      'auth-oidc\'s client still reports signed in '
      '(got: ${oidc.authState.runtimeType})',
    );

    await sso.signIn(
      SsoOidcApiGetClientProvider.corp,
      launcher: launcher,
      relayTo: _relayTo,
    );
    await oidc.signOut();
    final oidcRestored = await oidc.restore();
    check(
      oidcRestored == null,
      'auth-oidc restore() is null after its sign-out',
    );
    check(
      oidc.authState is OidcSignedOut,
      'auth-oidc\'s client reports signed out (got: ${oidc.authState.runtimeType})',
    );
    final ssoStill = await blocks.api.ssoRequireAuth();
    check(
      ssoStill.provider == 'corp',
      'auth-sso is still signed in (provider=${ssoStill.provider})',
    );
    check(
      sso.authState is OidcSignedIn,
      'auth-sso\'s client still reports signed in '
      '(got: ${sso.authState.runtimeType})',
    );
    await sso.signOut();
  } catch (e) {
    check(false, 'signing out of one block only threw: $e');
  }
}

Future<void> _signInRestoreSignOut<P extends OidcProvider>({
  required String label,
  required String rpcUrl,
  required HttpRelayLauncher launcher,
  required P provider,
  required Future<TypedOidcClient<P>> Function(Blocks blocks) client,
  required Future<AuthStateState> Function(Blocks blocks) state,
  required Future<({String userId, String provider})> Function(Blocks blocks)
  requireAuth,
  required String stagePath,
  String? expectedCallbackPath,
}) async {
  final id = provider.providerName;
  final session = InMemorySessionStore();
  // Every call builds a fresh client on the same cookie store, as a relaunch
  // does.
  Blocks blocksFor() => Blocks(baseUrl: rpcUrl, sessionStore: session);
  final blocks = blocksFor();

  group('OIDC getClient() ($label): sign in');
  String? userId;
  try {
    final recording = _RecordingLauncher(launcher);
    final oidc = await client(blocksFor());
    final user = await oidc.signIn(
      provider,
      launcher: recording,
      relayTo: _relayTo,
    );
    userId = user.userId;
    check(
      user.userId.isNotEmpty && user.signInProvider == id,
      'signIn returns the user (userId=${user.userId}, '
      'signInProvider=${user.signInProvider})',
    );
    check(
      oidc.authState is OidcSignedIn,
      'the client reports signed in (got: ${oidc.authState.runtimeType})',
    );
    if (expectedCallbackPath != null) {
      final redirectUri = recording.authorizeUrls.isEmpty
          ? null
          : recording.authorizeUrls.first.queryParameters['redirect_uri'];
      final path = redirectUri == null ? null : Uri.parse(redirectUri).path;
      check(
        path == expectedCallbackPath,
        "the IdP is sent the descriptor's callback $expectedCallbackPath "
        '(got: $path)',
      );
    }
    final me = await requireAuth(blocks);
    check(
      me.userId == user.userId && me.provider == id,
      'an authenticated RPC sees the same user through $id '
      '(got: ${me.userId}, ${me.provider})',
    );
    final signedIn = await state(blocks);
    check(
      signedIn == AuthStateState.signedIn,
      'the state machine is signedIn (got: $signedIn)',
    );
  } catch (e) {
    check(false, 'sign in through $id threw: $e');
    stderr.writeln('  launcher trace:\n    ${launcher.trace.join('\n    ')}');
  }

  group('OIDC getClient() ($label): restore on a fresh client');
  try {
    final restored = await (await client(blocksFor())).restore();
    check(
      restored != null && restored.userId == userId,
      'restore() returns the signed-in user (got: ${restored?.userId})',
    );
  } catch (e) {
    check(false, 'restore() threw: $e');
  }

  group('OIDC getClient() ($label): OidcClient.signOut()');
  try {
    final oidc = await client(blocksFor());
    await oidc.restore();
    final logoutUrl = await oidc.signOut();
    check(
      logoutUrl?.path == '$stagePath/aws-blocks/auth/idp/$id/logout',
      "signOut() returns the stub IdP's logout URL (got: ${logoutUrl?.path})",
    );
    check(
      oidc.authState is OidcSignedOut,
      'the client reports signed out (got: ${oidc.authState.runtimeType})',
    );
    final fresh = await client(blocksFor());
    final afterSignOut = await fresh.restore();
    check(afterSignOut == null, 'restore() is null after sign-out');
    check(
      fresh.authState is OidcSignedOut,
      'the restoring client reports signed out '
      '(got: ${fresh.authState.runtimeType})',
    );
    final signedOut = await state(blocks);
    check(
      signedOut == AuthStateState.signedOut,
      'the state machine is signedOut (got: $signedOut)',
    );
  } catch (e) {
    check(false, 'sign out threw: $e');
  }
}

/// The API Gateway stage segment of [rpcUrl], such as `/prod`: everything in
/// its path before the first `/aws-blocks`, as `oidc_test.dart` derives it.
/// Empty for a local dev server.
String _stagePath(String rpcUrl) {
  final path = Uri.parse(rpcUrl).path;
  final idx = path.indexOf('/aws-blocks');
  return (idx >= 0 ? path.substring(0, idx) : path).replaceAll(
    RegExp(r'/+$'),
    '',
  );
}
