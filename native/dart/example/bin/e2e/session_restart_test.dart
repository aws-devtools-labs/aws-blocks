// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import 'dart:io';

import 'package:blocks_runtime/blocks_runtime.dart';
import 'package:http/http.dart' as http;

import 'harness.dart';
import 'oidc_test.dart' show HttpRelayLauncher;

/// A session survives a process restart with no app code beyond building
/// `Blocks` (native-bindings' `auth-basic` and `auth-oidc` blocks).
///
/// A pure Dart program has no per-application storage to default to, so it
/// registers one default store at startup, as the README shows; every client
/// built without a `sessionStore:` then shares it. Each phase below is a
/// separate `dart` process, so nothing carries over in memory:
///
/// 1. sign-in: sign in on both blocks.
/// 2. memory: a process that registers nothing is signed out, as before.
/// 3. restore: a new process is still signed in on both blocks; it signs out
///    of `auth-basic` only.
/// 4. one-block-signed-out: `auth-basic` is signed out, `auth-oidc` is still
///    signed in, so each block's cookie is kept and removed on its own. It
///    signs out of `auth-oidc`.
/// 5. signed-out: nothing is restored.
///
/// The store lives in a temporary directory, never the user's home.
///
/// Local dev server only: signing up reads back the emailed code, and the OIDC
/// leg uses `Auth`'s stub IdP.
void main(List<String> args) async {
  if (args.length == 3) {
    await _phase(args[0], root: args[1], username: args[2]);
    return;
  }

  group('Session persistence across process restarts');
  if (!isLocalEndpoint()) {
    skip(needsLocalCode);
    printResults();
    return;
  }

  final root = await Directory.systemTemp.createTemp('blocks_session_e2e');
  final username = uniqueUsername('restart');
  try {
    for (final phase in [
      'sign-in',
      'memory',
      'restore',
      'one-block-signed-out',
      'signed-out',
    ]) {
      final result = await Process.run(Platform.resolvedExecutable, [
        'run',
        Platform.script.toFilePath(),
        phase,
        root.path,
        username,
      ], environment: Platform.environment);
      final output = '${result.stdout}${result.stderr}';
      stdout.write(output);
      check(
        result.exitCode == 0 && output.contains('PHASE OK $phase'),
        'phase "$phase" passes in its own process (exit ${result.exitCode})',
      );
    }
  } finally {
    await root.delete(recursive: true);
  }
  printResults();
}

/// One process of the scenario. Exits non-zero when any check fails.
Future<void> _phase(
  String phase, {
  required String root,
  required String username,
}) async {
  print('\n  [$phase] pid $pid');
  if (phase != 'memory') {
    // What a command-line app does once at startup to keep its session.
    registerDefaultSessionStore(
      () => PersistentSessionStore(
        store: FileTokenStore(
          applicationId: 'com.example.native_bindings_e2e',
          rootDirectory: root,
        ),
      ),
    );
  }
  final blocks = createBlocks();
  final store = BlocksClient(baseUrl: blocksUrl()).sessionStore;

  var ok = true;
  void expect(bool condition, String message) {
    ok &= condition;
    check(condition, '[$phase] $message');
  }

  Future<AuthState> basic() => blocks.authBasicApi.getAuthState();
  Future<AuthState> oidc() => blocks.oidcAuthStateApi.getAuthState();
  // The block's OIDC client, as an app gets it. It shares the generated
  // client's session store, so on a restart it reads the same stored cookies.
  Future<OidcClient> oidcClient() => blocks.oidcAuthApi.getClient();

  switch (phase) {
    case 'sign-in':
      expect(store is PersistentSessionStore, 'the default store persists');
      await signUpAndConfirm(blocks, username);
      expect(
        (await basic()).state == AuthStateState.signedIn,
        'auth-basic signed in',
      );
      final oidcUser = await _signInOidc(await oidcClient(), store);
      expect(oidcUser.userId.isNotEmpty, 'auth-oidc signIn completes');
      expect(
        (await oidc()).state == AuthStateState.signedIn,
        'auth-oidc signed in',
      );
    case 'memory':
      expect(store is InMemorySessionStore, 'nothing registered: memory');
      expect(
        (await basic()).state == AuthStateState.signedOut,
        'auth-basic signed out without a persistent store',
      );
      expect(
        (await oidc()).state == AuthStateState.signedOut,
        'auth-oidc signed out without a persistent store',
      );
    case 'restore':
      final state = await basic();
      expect(
        state.state == AuthStateState.signedIn &&
            state.user?.username == username,
        'auth-basic still signed in as $username after the restart '
        '(state=${state.state.toJson()})',
      );
      expect(
        (await oidc()).state == AuthStateState.signedIn,
        'auth-oidc still signed in after the restart',
      );
      final restored = await (await oidcClient()).restore();
      expect(
        restored != null && restored.userId.isNotEmpty,
        'OidcClient.restore() returns the user after the restart',
      );
      await blocks.api.basicSignOut();
      expect(
        (await basic()).state == AuthStateState.signedOut,
        'auth-basic signs out',
      );
    case 'one-block-signed-out':
      expect(
        (await basic()).state == AuthStateState.signedOut,
        'auth-basic stays signed out after the restart',
      );
      expect(
        (await oidc()).state == AuthStateState.signedIn,
        'auth-oidc is still signed in: only auth-basic signed out',
      );
      await (await oidcClient()).signOut();
    case 'signed-out':
      expect(
        (await basic()).state == AuthStateState.signedOut &&
            (await oidc()).state == AuthStateState.signedOut,
        'both blocks signed out after the restart',
      );
      expect(
        await (await oidcClient()).restore() == null,
        'OidcClient.restore() finds no session',
      );
  }

  // Store the last cookie change before the process exits.
  if (store is PersistentSessionStore) await store.flush();
  if (ok) print('  PHASE OK $phase');
  printResults();
}

/// Signs in on `auth-oidc` through the stub IdP with the client
/// `oidcAuthApi.getClient()` returned, checking it holds the default store
/// [expected].
Future<OidcUser> _signInOidc(OidcClient oidc, SessionStore expected) async {
  if (!identical(oidc.sessionStore, expected)) {
    throw StateError('getClient() did not share the default session store');
  }
  final httpClient = http.Client();
  try {
    return await oidc.signIn(
      'google',
      launcher: HttpRelayLauncher(httpClient),
      relayTo: 'nativebindings://auth',
    );
  } finally {
    httpClient.close();
  }
}
