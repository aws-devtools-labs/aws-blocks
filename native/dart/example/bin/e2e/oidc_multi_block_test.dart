// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/// `OidcClient.forAuth` against two federated `Auth` blocks in
/// test-apps/native-bindings:
///
///   - `auth-oidc` on the default routes, signing in with its second
///     provider, `github2`;
///   - `auth-sso` on `/aws-blocks/auth/sso/*` (its own `redirects.callbackPath`
///     and `signOutPath`), signing in with its provider `corp`.
///
/// For each it signs in through the relay, checks an authenticated RPC,
/// restores the session on a fresh client that shares the cookie store, signs
/// out (which returns the stub IdP's logout URL), and checks that `restore()`
/// is null afterwards. Then, on one cookie store shared by both blocks, it
/// checks that they stay separate: `auth-sso` refuses an `auth-oidc` session,
/// and signing out of either block leaves the other signed in.
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

void main() async {
  final rpcUrl =
      (Platform.environment['BLOCKS_URL'] ??
              'http://localhost:3001/aws-blocks/api')
          .trim();

  if (!isLocalEndpoint() && Platform.environment['RUN_OIDC'] != '1') {
    group('OIDC: forAuth across two federated blocks');
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
    httpClient: httpClient,
    launcher: launcher,
    provider: 'github2',
    providers: const ['google', 'github2'],
    requireAuth: (blocks) async {
      final me = await blocks.api.oidcRequireAuth();
      return (userId: me.userId, provider: me.provider);
    },
  );

  // --- auth-sso, routes under /aws-blocks/auth/sso/ -------------------------
  await _signInRestoreSignOut(
    label: 'auth-sso via corp',
    rpcUrl: rpcUrl,
    httpClient: httpClient,
    launcher: launcher,
    provider: 'corp',
    providers: const ['corp'],
    callbackPath: '/aws-blocks/auth/sso/callback',
    signOutPath: '/aws-blocks/auth/sso/signout',
    requireAuth: (blocks) async {
      final me = await blocks.api.ssoRequireAuth();
      return (userId: me.userId, provider: me.provider);
    },
  );

  await _blocksStaySeparate(
    rpcUrl: rpcUrl,
    httpClient: httpClient,
    launcher: launcher,
  );

  httpClient.close();
  printResults();
}

Future<void> _blocksStaySeparate({
  required String rpcUrl,
  required http.Client httpClient,
  required HttpRelayLauncher launcher,
}) async {
  final session = InMemorySessionStore();
  final client = BlocksClient(
    baseUrl: rpcUrl,
    client: httpClient,
    sessionStore: session,
  );
  final oidc = OidcClient.forAuth(
    client,
    providers: const ['google', 'github2'],
    relayTo: _relayTo,
  );
  final sso = OidcClient.forAuth(
    client,
    providers: const ['corp'],
    relayTo: _relayTo,
    callbackPath: '/aws-blocks/auth/sso/callback',
    signOutPath: '/aws-blocks/auth/sso/signout',
  );
  final blocks = Blocks(baseUrl: rpcUrl, sessionStore: session);

  group('OIDC forAuth: auth-sso refuses an auth-oidc session');
  try {
    await oidc.signInRelay('github2', launcher: launcher);
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
  } catch (e) {
    check(false, 'auth-sso refuses an auth-oidc session threw: $e');
  }

  group('OIDC forAuth: signing out of either block leaves the other signed in');
  try {
    await sso.signInRelay('corp', launcher: launcher);
    await sso.signOut();
    final ssoAfter = await sso.restore();
    check(ssoAfter == null, 'auth-sso restore() is null after its sign-out');
    final oidcAfter = await blocks.api.oidcRequireAuth();
    check(
      oidcAfter.provider == 'github2',
      'auth-oidc is still signed in (provider=${oidcAfter.provider})',
    );

    await sso.signInRelay('corp', launcher: launcher);
    await oidc.signOut();
    final oidcRestored = await oidc.restore();
    check(
      oidcRestored == null,
      'auth-oidc restore() is null after its sign-out',
    );
    final ssoStill = await blocks.api.ssoRequireAuth();
    check(
      ssoStill.provider == 'corp',
      'auth-sso is still signed in (provider=${ssoStill.provider})',
    );
    await sso.signOut();
  } catch (e) {
    check(false, 'signing out of one block only threw: $e');
  }
}

Future<void> _signInRestoreSignOut({
  required String label,
  required String rpcUrl,
  required http.Client httpClient,
  required HttpRelayLauncher launcher,
  required String provider,
  required List<String> providers,
  required Future<({String userId, String provider})> Function(Blocks blocks)
  requireAuth,
  String? callbackPath,
  String? signOutPath,
}) async {
  final session = InMemorySessionStore();
  OidcClient forAuth() {
    final client = BlocksClient(
      baseUrl: rpcUrl,
      client: httpClient,
      sessionStore: session,
    );
    return callbackPath == null
        ? OidcClient.forAuth(client, providers: providers, relayTo: _relayTo)
        : OidcClient.forAuth(
            client,
            providers: providers,
            relayTo: _relayTo,
            callbackPath: callbackPath,
            signOutPath: signOutPath!,
          );
  }

  final blocks = Blocks(baseUrl: rpcUrl, sessionStore: session);

  group('OIDC forAuth ($label): sign in');
  String? userId;
  try {
    final user = await forAuth().signInRelay(provider, launcher: launcher);
    userId = user.userId;
    check(
      user.userId.isNotEmpty && user.signInProvider == provider,
      'signInRelay returns the user (userId=${user.userId}, '
      'signInProvider=${user.signInProvider})',
    );
    final me = await requireAuth(blocks);
    check(
      me.userId == user.userId && me.provider == provider,
      'an authenticated RPC sees the same user through $provider '
      '(got: ${me.userId}, ${me.provider})',
    );
  } catch (e) {
    check(false, 'sign in through $provider threw: $e');
    stderr.writeln('  launcher trace:\n    ${launcher.trace.join('\n    ')}');
  }

  group('OIDC forAuth ($label): restore on a fresh client');
  try {
    final restored = await forAuth().restore();
    check(
      restored != null && restored.userId == userId,
      'restore() returns the signed-in user (got: ${restored?.userId})',
    );
  } catch (e) {
    check(false, 'restore() threw: $e');
  }

  group('OIDC forAuth ($label): sign out');
  try {
    final logoutUrl = await forAuth().signOut();
    check(
      logoutUrl?.path == '/aws-blocks/auth/idp/$provider/logout',
      "signOut() returns the stub IdP's logout URL (got: ${logoutUrl?.path})",
    );
    final afterSignOut = await forAuth().restore();
    check(afterSignOut == null, 'restore() is null after sign-out');
  } catch (e) {
    check(false, 'sign out threw: $e');
  }
}
