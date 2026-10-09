import 'harness.dart';

/// Cognito-style `Auth` E2E (native-bindings' `auth-cognito` block).
///
/// native-bindings configures: passwordPolicy { minLength: 8, requireDigits },
/// self sign-up, groups `admins` / `users`, MFA off.
///
/// The suite runs two complementary paths, selected by the target backend
/// (detected from BLOCKS_URL via [isLocalEndpoint]):
///
///   * LOCAL dev server — the full sign-up → confirmation-code → confirm → sign-in
///     dance. `Auth`'s local runtime hands the code to the backend's
///     `codeDelivery` hook, retrievable via `cognitoGetLastCode`. Real Cognito
///     emails the code instead, so this leg can ONLY be verified against the
///     local dev server.
///
///   * DEPLOYED sandbox/prod — a returning-customer sign-in with a
///     PRE-PROVISIONED, CONFIRMED user. No emailed code is needed: the user is
///     seeded out-of-band by `test-apps/native-bindings/aws-blocks/scripts/
///     seed-cognito-user.ts` (AdminCreateUser + AdminSetUserPassword). This is
///     the real returning-customer path against a real Cognito pool.
///
/// The returning-customer flow also runs locally — it self-provisions the user
/// through the dev sign-up/confirm flow — so the new assertions get exercised in
/// both run modes. Errors are asserted by their canonical name (`AuthErrors`).
void main() async {
  final blocks = createBlocks();
  final local = isLocalEndpoint();

  if (local) {
    await _signUpConfirmFlow(blocks);
  } else {
    group(
      'Auth (Cognito-style): sign up → emailed-code → confirm (dev-server only)',
    );
    skip(
      '$needsLocalCode. The returning-customer sign-in below covers the real '
      'Cognito path.',
    );
  }

  await _returningCustomerFlow(blocks, local: local);

  printResults();
}

/// Full local-only sign-up/confirm dance. Relies on the dev server's
/// `cognitoGetLastCode` hook, which real Cognito cannot satisfy.
Future<void> _signUpConfirmFlow(Blocks blocks) async {
  final username = uniqueUsername('cognitouser');
  final email = '$username@example.com';

  group('Auth (Cognito-style): sign up');
  final signUp = await blocks.api.cognitoSignUp(
    username: username,
    password: e2ePassword,
    email: email,
  );
  check(
    !signUp.isSignUpComplete,
    'signUp pending confirmation (isSignUpComplete=false)',
  );

  group('Auth (Cognito-style): get verification code');
  final codeResult = await blocks.api.cognitoGetLastCode(username: username);
  check(codeResult != null, 'code was delivered');
  check(
    codeResult?.purpose == DeliveredCodePurpose.signUp,
    'code is a sign-up code',
  );
  final code = codeResult!.code;

  group('Auth (Cognito-style): wrong code');
  await expectErrorNamed(
    () => blocks.api.cognitoConfirmSignUp(
      username: username,
      code: code == '000000' ? '111111' : '000000',
    ),
    AuthErrorNames.codeMismatch,
    label: 'confirmSignUp with a wrong code throws',
  );

  group('Auth (Cognito-style): confirm sign up');
  final confirm = await blocks.api.cognitoConfirmSignUp(
    username: username,
    code: code,
  );
  check(confirm.success, 'confirmSignUp returns success');

  group('Auth (Cognito-style): sign in');
  // With MFA off, sign-in completes in one step.
  final signIn = await blocks.api.cognitoSignIn(
    username: username,
    password: e2ePassword,
  );
  check(
    signIn is SignedInCognitoSignInResult,
    'signIn completes (status=signedIn)',
  );
  if (signIn is SignedInCognitoSignInResult) {
    check(signIn.user.username == username, 'signIn returns the user');
    check(
      signIn.user.attributes['email'] == email,
      'signIn returns the email attribute',
    );
  }

  group('Auth (Cognito-style): checkAuth (authenticated)');
  final authed = await blocks.api.cognitoCheckAuth();
  check(authed == true, 'checkAuth returns true when signed in');

  group('Auth (Cognito-style): get current user (authenticated)');
  final current = await blocks.api.cognitoGetCurrentUser();
  check(current != null, 'getCurrentUser returns user');
  check(
    current?.username == username,
    'current user matches (got: ${current?.username})',
  );

  group('Auth (Cognito-style): requireAuth (authenticated)');
  final required = await blocks.api.cognitoRequireAuth();
  check(required.username == username, 'requireAuth returns current user');

  group('Auth (Cognito-style): requireRole (not a member)');
  await expectErrorNamed(
    () => blocks.api.cognitoRequireRole(role: ApiCognitoRequireRoleRole.admins),
    AuthErrorNames.notAuthorized,
    label: 'requireRole throws for a group the user is not in',
  );

  group('Auth (Cognito-style): sign out');
  final out = await blocks.api.cognitoSignOut();
  check(out.success, 'signOut returns success');

  group('Auth (Cognito-style): get current user (signed out)');
  final afterSignOut = await blocks.api.cognitoGetCurrentUser();
  check(afterSignOut == null, 'getCurrentUser returns null after sign out');

  group('Auth (Cognito-style): resend sign-up code (idempotent path)');
  // Re-sign-up a fresh user to exercise resend without a confirmed account.
  final username2 = uniqueUsername('cognitouser2');
  await blocks.api.cognitoSignUp(
    username: username2,
    password: e2ePassword,
    email: '$username2@example.com',
  );
  final resend = await blocks.api.cognitoResendSignUpCode(username: username2);
  check(resend.success, 'resendSignUpCode returns success');

  group('Auth (Cognito-style): sign in before confirming');
  await expectErrorNamed(
    () => blocks.api.cognitoSignIn(username: username2, password: e2ePassword),
    AuthErrorNames.userNotConfirmed,
    label: 'signIn throws until the code is confirmed',
  );

  group('Auth (Cognito-style): wrong password');
  await expectErrorNamed(
    () => blocks.api.cognitoSignIn(username: username, password: 'Wrong5678!'),
    AuthErrorNames.notAuthorized,
    label: 'wrong password throws',
  );
}

/// Returning-customer flow: sign in a confirmed user, exercise authenticated
/// RPCs, verify the cookie session persists across requests, then sign out.
///
/// Against a deployed pool the user is pre-seeded (seed-cognito-user.ts). On the
/// local dev server there's no pre-seeded user, so we first provision it via the
/// real sign-up/confirm flow (the dev code hook makes that possible locally).
Future<void> _returningCustomerFlow(
  Blocks blocks, {
  required bool local,
}) async {
  final user = returningUser();
  final username = user.username;
  final password = user.password;

  group('Auth (Cognito-style, returning customer): provision');
  if (local) {
    await _provisionLocalUser(blocks, username, password);
    check(
      true,
      'provisioned returning user "$username" via dev sign-up/confirm',
    );
  } else {
    skip(
      'using pre-provisioned, confirmed user "$username" '
      '(seeded by seed-cognito-user.ts on the deployed pool)',
    );
  }

  group('Auth (Cognito-style, returning customer): sign in');
  final signIn = await blocks.api.cognitoSignIn(
    username: username,
    password: password,
  );
  check(
    signIn is SignedInCognitoSignInResult,
    'cognitoSignIn signs the confirmed user in',
  );

  group('Auth (Cognito-style, returning customer): authenticated RPC');
  final authed = await blocks.api.cognitoCheckAuth();
  check(authed == true, 'checkAuth returns true after sign in');
  final current = await blocks.api.cognitoGetCurrentUser();
  check(current != null, 'getCurrentUser returns the signed-in user');
  check(
    current?.username == username,
    'current user matches (got: ${current?.username})',
  );
  final required = await blocks.api.cognitoRequireAuth();
  check(required.username == username, 'requireAuth returns the current user');

  group(
    'Auth (Cognito-style, returning customer): session persists across requests',
  );
  // Re-issue authenticated RPCs after the initial calls — the cookie session
  // must still resolve, proving it persists across round-trips (not just within
  // one in-flight call).
  final stillAuthed = await blocks.api.cognitoCheckAuth();
  check(stillAuthed == true, 'checkAuth still true on a subsequent request');
  final stillCurrent = await blocks.api.cognitoGetCurrentUser();
  check(
    stillCurrent?.username == username,
    'getCurrentUser still resolves the same user',
  );

  group('Auth (Cognito-style, returning customer): sign out');
  final out = await blocks.api.cognitoSignOut();
  check(out.success, 'signOut returns success');
  final afterOut = await blocks.api.cognitoGetCurrentUser();
  check(afterOut == null, 'getCurrentUser returns null after sign out');
  final authedAfter = await blocks.api.cognitoCheckAuth();
  check(authedAfter == false, 'checkAuth returns false after sign out');
  await expectErrorNamed(
    () => blocks.api.cognitoRequireAuth(),
    AuthErrorNames.notAuthenticated,
    label: 'requireAuth throws after sign out',
  );
}

/// Provisions the returning-customer user on the LOCAL dev server via the real
/// sign-up → confirm flow, using the dev-only `cognitoGetLastCode` hook.
/// Idempotent across runs that share `.bb-data`: an existing user is reused.
Future<void> _provisionLocalUser(
  Blocks blocks,
  String username,
  String password,
) async {
  try {
    await blocks.api.cognitoSignUp(
      username: username,
      password: password,
      email: '$username@example.com',
    );
  } on BlocksRpcException catch (e) {
    final data = e.data;
    if (data is Map && data['name'] == AuthErrorNames.userAlreadyExists) {
      return; // provisioned by an earlier run
    }
    rethrow;
  }
  final codeResult = await blocks.api.cognitoGetLastCode(username: username);
  if (codeResult == null) {
    throw StateError(
      'local provisioning expected a dev code from cognitoGetLastCode but got null',
    );
  }
  await blocks.api.cognitoConfirmSignUp(
    username: username,
    code: codeResult.code,
  );
}
