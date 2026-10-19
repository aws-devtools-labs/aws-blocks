import 'harness.dart';

/// AuthBasic E2E — username/password auth with no email-verification step.
/// native-bindings' AuthBasic goes straight from signUp -> signIn (unlike the
/// comprehensive backend's confirm-code flow).
void main() async {
  final blocks = createBlocks();
  final suffix = DateTime.now().millisecondsSinceEpoch.toString();
  final username = 'basicuser_$suffix';
  final password = 'pass1234';

  group('AuthBasic: sign up');
  final r1 = await blocks.api.basicSignUp(
    username: username,
    password: password,
  );
  check(r1.success, 'signUp returns success');

  group('AuthBasic: sign in');
  final user = await blocks.api.basicSignIn(
    username: username,
    password: password,
  );
  check(user.username == username, 'signIn returns correct username');
  check(user.userId.isNotEmpty, 'signIn returns userId');

  group('AuthBasic: checkAuth (authenticated)');
  final authed = await blocks.api.basicCheckAuth();
  check(authed == true, 'checkAuth returns true when signed in');

  group('AuthBasic: requireAuth (authenticated)');
  final required = await blocks.api.basicRequireAuth();
  check(required.username == username, 'requireAuth returns current user');

  group('AuthBasic: get current user (authenticated)');
  final current = await blocks.api.basicGetCurrentUser();
  check(current != null, 'getCurrentUser returns user');
  check(current?.username == username, 'current user matches');

  group('AuthBasic: sign out');
  final r3 = await blocks.api.basicSignOut();
  check(r3.success, 'signOut returns success');

  group('AuthBasic: get current user (signed out)');
  final afterSignOut = await blocks.api.basicGetCurrentUser();
  check(afterSignOut == null, 'getCurrentUser returns null after sign out');

  group('AuthBasic: checkAuth (signed out)');
  final authedAfter = await blocks.api.basicCheckAuth();
  check(authedAfter == false, 'checkAuth returns false after sign out');

  group('AuthBasic: requireAuth (signed out) throws');
  await expectError(
    () => blocks.api.basicRequireAuth(),
    label: 'requireAuth throws when not authenticated',
  );

  group('AuthBasic: wrong password');
  await expectError(
    () => blocks.api.basicSignIn(username: username, password: 'wrong5678'),
    label: 'wrong password throws error',
  );

  printResults();
}
