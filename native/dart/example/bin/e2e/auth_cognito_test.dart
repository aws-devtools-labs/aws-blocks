import 'dart:io';

import 'harness.dart';

/// AuthCognito E2E.
///
/// native-bindings configures: passwordPolicy { minLength: 8, requireDigits },
/// email attribute, selfSignUp, MFA off.
///
/// The suite runs two complementary paths, selected by the target backend
/// (detected from BLOCKS_URL via [isLocalEndpoint]):
///
///   * LOCAL dev server — the full sign-up → confirmation-code → confirm → sign-in
///     dance. The dev server's `codeDelivery` hook stashes the last code,
///     retrievable via `cognitoGetLastCode`. Real Cognito emails the code
///     instead, so this leg can ONLY be verified against the local dev server.
///
///   * DEPLOYED sandbox/prod — a returning-customer sign-in with a
///     PRE-PROVISIONED, CONFIRMED user. No emailed code is needed: the user is
///     seeded out-of-band by `test-apps/native-bindings/aws-blocks/scripts/
///     seed-cognito-user.ts` (AdminCreateUser + AdminSetUserPassword). This is
///     the real returning-customer path against a real Cognito pool.
///
/// The returning-customer flow also runs locally — it self-provisions the user
/// through the dev sign-up/confirm flow — so the new assertions get exercised in
/// both run modes.

/// Default credentials for the pre-provisioned returning-customer user. These
/// MUST match the defaults in `seed-cognito-user.ts`. Override both sides with
/// COGNITO_TEST_USERNAME / COGNITO_TEST_PASSWORD. The password satisfies the
/// pool policy (>= 8 chars, contains a digit). Not a secret — a deterministic
/// test fixture for a throwaway test pool.
const _defaultReturningUsername = 'e2e-returning-user';
const _defaultReturningPassword = 'Returning1Pass!';

void main() async {
  final blocks = createBlocks();
  final local = isLocalEndpoint();

  if (local) {
    await _signUpConfirmFlow(blocks);
  } else {
    group('AuthCognito: sign up → emailed-code → confirm (dev-server only)');
    skip('cognitoGetLastCode is a dev-server affordance — real Cognito emails '
        'the confirmation code, so this leg cannot run against a deployed pool. '
        'The returning-customer sign-in below covers the real Cognito path.');
  }

  await _returningCustomerFlow(blocks, local: local);

  printResults();
}

/// Full local-only sign-up/confirm dance. Relies on the dev server's
/// `cognitoGetLastCode` hook, which real Cognito cannot satisfy.
Future<void> _signUpConfirmFlow(Blocks blocks) async {
  final suffix = DateTime.now().millisecondsSinceEpoch.toString();
  final username = 'cognitouser_$suffix';
  final password = 'Passw0rd!'; // upper+lower+digit+symbol, >=8 (Cognito default policy)
  final email = '$username@example.com';

  group('AuthCognito: sign up');
  final signUp = await blocks.api.cognitoSignUp(
    username: username,
    password: password,
    email: email,
  );
  check(!signUp.isSignUpComplete, 'signUp pending confirmation (isSignUpComplete=false)');

  group('AuthCognito: get verification code');
  final codeResult = await blocks.api.cognitoGetLastCode();
  check(codeResult != null, 'code was delivered');
  check(codeResult?.username == username, 'code is for correct user');
  final code = codeResult!.code;

  group('AuthCognito: confirm sign up');
  final confirm = await blocks.api.cognitoConfirmSignUp(username: username, code: code);
  check(confirm.success, 'confirmSignUp returns success');

  group('AuthCognito: sign in');
  // cognitoSignIn returns a dynamic sign-in result; with MFA off it completes.
  final signIn = await blocks.api.cognitoSignIn(username: username, password: password);
  check(signIn != null, 'signIn returns a result');

  group('AuthCognito: checkAuth (authenticated)');
  final authed = await blocks.api.cognitoCheckAuth();
  check(authed == true, 'checkAuth returns true when signed in');

  group('AuthCognito: get current user (authenticated)');
  final current = await blocks.api.cognitoGetCurrentUser();
  check(current != null, 'getCurrentUser returns user');
  check(current?.username == username, 'current user matches (got: ${current?.username})');

  group('AuthCognito: requireAuth (authenticated)');
  final required = await blocks.api.cognitoRequireAuth();
  check(required.username == username, 'requireAuth returns current user');

  group('AuthCognito: sign out');
  final out = await blocks.api.cognitoSignOut();
  check(out.success, 'signOut returns success');

  group('AuthCognito: get current user (signed out)');
  final afterSignOut = await blocks.api.cognitoGetCurrentUser();
  check(afterSignOut == null, 'getCurrentUser returns null after sign out');

  group('AuthCognito: resend sign-up code (idempotent path)');
  // Re-sign-up a fresh user to exercise resend without a confirmed account.
  final username2 = 'cognitouser2_$suffix';
  await blocks.api.cognitoSignUp(
    username: username2,
    password: password,
    email: '$username2@example.com',
  );
  final resend = await blocks.api.cognitoResendSignUpCode(username: username2);
  check(resend.success, 'resendSignUpCode returns success');

  group('AuthCognito: wrong password');
  await expectError(
    () => blocks.api.cognitoSignIn(username: username, password: 'Wrong5678!'),
    label: 'wrong password throws error',
  );
}

/// Returning-customer flow: sign in a confirmed user, exercise authenticated
/// RPCs, verify the cookie session persists across requests, then sign out.
///
/// Against a deployed pool the user is pre-seeded (seed-cognito-user.ts). On the
/// local dev server there's no pre-seeded user, so we first provision it via the
/// real sign-up/confirm flow (the dev code hook makes that possible locally).
Future<void> _returningCustomerFlow(Blocks blocks, {required bool local}) async {
  final username = Platform.environment['COGNITO_TEST_USERNAME'] ?? _defaultReturningUsername;
  final password = Platform.environment['COGNITO_TEST_PASSWORD'] ?? _defaultReturningPassword;

  group('AuthCognito (returning customer): provision');
  if (local) {
    await _provisionLocalUser(blocks, username, password);
    check(true, 'provisioned returning user "$username" via dev sign-up/confirm');
  } else {
    skip('using pre-provisioned, confirmed user "$username" '
        '(seeded by seed-cognito-user.ts on the deployed pool)');
  }

  group('AuthCognito (returning customer): sign in');
  final signIn = await blocks.api.cognitoSignIn(username: username, password: password);
  check(signIn != null, 'cognitoSignIn returns a result for the confirmed user');

  group('AuthCognito (returning customer): authenticated RPC');
  final authed = await blocks.api.cognitoCheckAuth();
  check(authed == true, 'checkAuth returns true after sign in');
  final current = await blocks.api.cognitoGetCurrentUser();
  check(current != null, 'getCurrentUser returns the signed-in user');
  check(current?.username == username, 'current user matches (got: ${current?.username})');
  final required = await blocks.api.cognitoRequireAuth();
  check(required.username == username, 'requireAuth returns the current user');

  group('AuthCognito (returning customer): session persists across requests');
  // Re-issue authenticated RPCs after the initial calls — the cookie session
  // must still resolve, proving it persists across round-trips (not just within
  // one in-flight call).
  final stillAuthed = await blocks.api.cognitoCheckAuth();
  check(stillAuthed == true, 'checkAuth still true on a subsequent request');
  final stillCurrent = await blocks.api.cognitoGetCurrentUser();
  check(stillCurrent?.username == username, 'getCurrentUser still resolves the same user');

  group('AuthCognito (returning customer): sign out');
  final out = await blocks.api.cognitoSignOut();
  check(out.success, 'signOut returns success');
  final afterOut = await blocks.api.cognitoGetCurrentUser();
  check(afterOut == null, 'getCurrentUser returns null after sign out');
  final authedAfter = await blocks.api.cognitoCheckAuth();
  check(authedAfter == false, 'checkAuth returns false after sign out');
}

/// Provisions the returning-customer user on the LOCAL dev server via the real
/// sign-up → confirm flow, using the dev-only `cognitoGetLastCode` hook.
Future<void> _provisionLocalUser(Blocks blocks, String username, String password) async {
  final signUp = await blocks.api.cognitoSignUp(
    username: username,
    password: password,
    email: '$username@example.com',
  );
  if (signUp.isSignUpComplete) return; // already confirmed
  final codeResult = await blocks.api.cognitoGetLastCode();
  if (codeResult == null) {
    throw StateError(
        'local provisioning expected a dev code from cognitoGetLastCode but got null');
  }
  await blocks.api.cognitoConfirmSignUp(username: username, code: codeResult.code);
}
