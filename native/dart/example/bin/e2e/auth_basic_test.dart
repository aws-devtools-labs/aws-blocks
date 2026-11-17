import 'harness.dart';

/// Email + password `Auth` E2E (native-bindings' `auth-basic` block).
///
/// Every self-service sign-up confirms the email address with a code; with
/// auto sign-in (on by default) confirming the code signs the user in. Locally
/// the backend reads the code back (`basicGetLastCode`); against a deployed
/// backend Cognito emails it, so the sign-up legs are skipped there and the
/// suite signs in the pre-provisioned user instead (see [signInTestUser]).
///
/// Errors are asserted by their canonical name (`AuthErrors`).
void main() async {
  final blocks = createBlocks();
  final local = isLocalEndpoint();

  if (local) {
    await _signUpFlow(blocks);
  } else {
    group('Auth (email + password): sign up → emailed code → confirm');
    skip(needsLocalCode);
  }

  group('Auth (email + password): sign in');
  final user = await signInTestUser(blocks, 'basicuser');
  await blocks.api.basicSignOut();
  final signIn = await blocks.api.basicSignIn(
    username: user.username,
    password: user.password,
  );
  check(
    signIn.status == NativeSignInResultStatus.signedIn,
    'signIn completes (status=${signIn.status.name})',
  );
  check(signIn.user?.username == user.username, 'signIn returns the username');
  check(signIn.user?.userId.isNotEmpty ?? false, 'signIn returns userId');
  check(signIn.user?.userSub.isNotEmpty ?? false, 'signIn returns userSub');

  group('Auth (email + password): checkAuth (authenticated)');
  final authed = await blocks.api.basicCheckAuth();
  check(authed == true, 'checkAuth returns true when signed in');

  group('Auth (email + password): requireAuth (authenticated)');
  final required = await blocks.api.basicRequireAuth();
  check(required.username == user.username, 'requireAuth returns current user');

  group('Auth (email + password): get current user (authenticated)');
  final current = await blocks.api.basicGetCurrentUser();
  check(current != null, 'getCurrentUser returns user');
  check(current?.username == user.username, 'current user matches');

  group('Auth (email + password): wrong password');
  await expectErrorNamed(
    () =>
        blocks.api.basicSignIn(username: user.username, password: 'Wrong5678!'),
    AuthErrorNames.notAuthorized,
    label: 'wrong password throws',
  );

  group('Auth (email + password): duplicate sign-up');
  await expectErrorNamed(
    () => blocks.api.basicSignUp(
      username: user.username,
      password: e2ePassword,
      email: '${user.username}@example.com',
    ),
    AuthErrorNames.userAlreadyExists,
    label: 'signing up an existing username throws',
  );

  group('Auth (email + password): weak password');
  final weak = uniqueUsername('weak');
  await expectErrorNamed(
    () => blocks.api.basicSignUp(
      username: weak,
      password: 'pass1234',
      email: '$weak@example.com',
    ),
    AuthErrorNames.invalidPassword,
    label: 'a password that breaks the policy throws',
  );

  group('Auth (email + password): sign out');
  final out = await blocks.api.basicSignOut();
  check(out.success, 'signOut returns success');

  group('Auth (email + password): get current user (signed out)');
  final afterSignOut = await blocks.api.basicGetCurrentUser();
  check(afterSignOut == null, 'getCurrentUser returns null after sign out');

  group('Auth (email + password): checkAuth (signed out)');
  final authedAfter = await blocks.api.basicCheckAuth();
  check(authedAfter == false, 'checkAuth returns false after sign out');

  group('Auth (email + password): requireAuth (signed out) throws');
  await expectErrorNamed(
    () => blocks.api.basicRequireAuth(),
    AuthErrorNames.notAuthenticated,
    label: 'requireAuth throws when not authenticated',
  );

  printResults();
}

/// Sign-up → emailed code → confirm (auto sign-in), plus the code-related
/// failures. Local dev server only.
Future<void> _signUpFlow(Blocks blocks) async {
  final username = uniqueUsername('basicnew');

  group('Auth (email + password): sign up');
  final signUp = await blocks.api.basicSignUp(
    username: username,
    password: e2ePassword,
    email: '$username@example.com',
  );
  check(!signUp.isSignUpComplete, 'signUp is pending the emailed code');

  group('Auth (email + password): sign in before confirming');
  await expectErrorNamed(
    () => blocks.api.basicSignIn(username: username, password: e2ePassword),
    AuthErrorNames.userNotConfirmed,
    label: 'signIn throws until the code is confirmed',
  );

  group('Auth (email + password): emailed code');
  final code = await blocks.api.basicGetLastCode(username: username);
  check(code != null, 'a code was delivered');
  check(
    code?.purpose == DeliveredCodePurpose.signUp,
    'the code is a sign-up code',
  );

  group('Auth (email + password): wrong code');
  final wrong = code?.code == '000000' ? '111111' : '000000';
  await expectErrorNamed(
    () => blocks.api.basicConfirmSignUp(username: username, code: wrong),
    AuthErrorNames.codeMismatch,
    label: 'confirmSignUp with a wrong code throws',
  );

  group('Auth (email + password): resend the code');
  final resend = await blocks.api.basicResendSignUpCode(username: username);
  check(resend.success, 'resendSignUpCode returns success');
  final resent = await blocks.api.basicGetLastCode(username: username);
  check(resent != null, 'a new code was delivered');

  group('Auth (email + password): confirm signs the user in');
  final confirmed = await blocks.api.basicConfirmSignUp(
    username: username,
    code: resent!.code,
  );
  check(
    confirmed.status == NativeSignInResultStatus.signedIn,
    'confirmSignUp auto-signs the user in (status=${confirmed.status.name})',
  );
  check(
    confirmed.user?.username == username,
    'the signed-in user is the new user',
  );
  final authed = await blocks.api.basicCheckAuth();
  check(authed == true, 'checkAuth returns true after confirming');
  await blocks.api.basicSignOut();
}
