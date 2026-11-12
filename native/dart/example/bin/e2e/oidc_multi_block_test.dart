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
/// is null afterwards.
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
    requireAuth: (blocks) async =>
        (await blocks.api.oidcRequireAuth()).provider,
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
    requireAuth: (blocks) async => (await blocks.api.ssoRequireAuth()).provider,
  );

  httpClient.close();
  printResults();
}

Future<void> _signInRestoreSignOut({
  required String label,
  required String rpcUrl,
  required http.Client httpClient,
  required HttpRelayLauncher launcher,
  required String provider,
  required List<String> providers,
  required Future<String> Function(Blocks blocks) requireAuth,
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
  try {
    final user = await forAuth().signInRelay(provider, launcher: launcher);
    check(
      user.userId.isNotEmpty && user.signInProvider == provider,
      'signInRelay returns the user (userId=${user.userId}, '
      'signInProvider=${user.signInProvider})',
    );
    final signedInWith = await requireAuth(blocks);
    check(
      signedInWith == provider,
      'an authenticated RPC sees provider $provider (got: $signedInWith)',
    );
  } catch (e) {
    check(false, 'sign in through $provider threw: $e');
    stderr.writeln('  launcher trace:\n    ${launcher.trace.join('\n    ')}');
  }

  group('OIDC forAuth ($label): restore on a fresh client');
  try {
    final restored = await forAuth().restore();
    check(
      restored != null && restored.signInProvider == provider,
      'restore() returns the signed-in user (got: ${restored?.userId})',
    );
  } catch (e) {
    check(false, 'restore() threw: $e');
  }

  group('OIDC forAuth ($label): sign out');
  try {
    final logoutUrl = await forAuth().signOut();
    check(
      logoutUrl != null && logoutUrl.path.endsWith('/idp/$provider/logout'),
      "signOut() returns the stub IdP's logout URL (got: ${logoutUrl?.path})",
    );
    final afterSignOut = await forAuth().restore();
    check(afterSignOut == null, 'restore() is null after sign-out');
  } catch (e) {
    check(false, 'sign out threw: $e');
  }
}
