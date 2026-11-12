import 'dart:io';
import 'dart:math';
import '../../lib/blocks_client.dart';
export '../../lib/blocks_client.dart';

int _passed = 0;
int _failed = 0;

/// The endpoint the suite targets — `BLOCKS_URL` if set, otherwise the local
/// native-bindings dev server (`npm run dev:server`).
String blocksUrl() =>
    Platform.environment['BLOCKS_URL'] ??
    'http://localhost:3001/aws-blocks/api';

/// True when the suite is pointed at the local dev server (vs. a deployed
/// sandbox/production backend). Reuses the same `BLOCKS_URL` mechanism the
/// runner/CI already use to distinguish local from sandbox — the local job
/// sets `BLOCKS_URL=http://localhost:3001/...`, the sandbox job sets it to the
/// deployed `https://…execute-api…` URL.
///
/// Suites use this to gate dev-server-only affordances (e.g. the
/// `basicGetLastCode` / `cognitoGetLastCode` hooks, which read the verification
/// code `Auth`'s local runtime hands to the backend — real Cognito emails the
/// code instead) so the sandbox run skips those legs cleanly rather than
/// failing.
bool isLocalEndpoint() {
  final host = Uri.parse(blocksUrl()).host;
  return host == 'localhost' ||
      host == '127.0.0.1' ||
      host == '0.0.0.0' ||
      host == '::1';
}

/// Creates a Blocks client pointing at test-apps/native-bindings.
/// Default: http://localhost:3001/aws-blocks/api (the native-bindings dev server,
/// `npm run dev:server`).
/// Override with BLOCKS_URL env var for sandbox/production testing.
Blocks createBlocks() {
  final url = blocksUrl();
  print('Using endpoint: $url');
  return Blocks(baseUrl: url);
}

/// Canonical `Auth` error names (the `name` the server puts on a JSON-RPC
/// error, `error.data.name`), from the mapping table in
/// `packages/auth-common/src/errors.ts` (`AuthErrors`).
abstract final class AuthErrorNames {
  static const notAuthenticated = 'NotAuthenticatedException';
  static const notAuthorized = 'NotAuthorizedException';
  static const userAlreadyExists = 'UsernameExistsException';
  static const userNotConfirmed = 'UserNotConfirmedException';
  static const invalidPassword = 'InvalidPasswordException';
  static const codeMismatch = 'CodeMismatchException';
}

/// A password that satisfies `Auth`'s default policy (>= 8, upper, lower,
/// digit, symbol).
const e2ePassword = 'Passw0rd!';

/// Why a leg that needs an emailed verification code does not run against a
/// deployed backend.
const needsLocalCode =
    'needs the emailed verification code, which only the local dev server '
    'hands back (Cognito emails it)';

final _random = Random();

/// A username no other suite (or earlier run) has used.
String uniqueUsername(String label) =>
    '${label}_dart_${DateTime.now().millisecondsSinceEpoch}_'
    '${1000 + _random.nextInt(9000)}';

/// The pre-provisioned, confirmed user a deployed backend signs in instead of
/// signing up (seeded into every user pool of the stack by
/// `test-apps/native-bindings/aws-blocks/scripts/seed-cognito-user.ts`). These
/// defaults MUST match that script. Override both sides with
/// COGNITO_TEST_USERNAME / COGNITO_TEST_PASSWORD. Not a secret — a
/// deterministic fixture for a throwaway test pool.
({String username, String password}) returningUser() => (
  username:
      Platform.environment['COGNITO_TEST_USERNAME'] ?? 'e2e-returning-user',
  password: Platform.environment['COGNITO_TEST_PASSWORD'] ?? 'Returning1Pass!',
);

/// Signs [username] up on the email + password block, reads the emailed code
/// back from the local dev server and confirms it. Auto sign-in leaves the
/// user signed in. Local dev server only.
Future<NativeSignInResult> signUpAndConfirm(
  Blocks blocks,
  String username, {
  String password = e2ePassword,
}) async {
  await blocks.api.basicSignUp(
    username: username,
    password: password,
    email: '$username@example.com',
  );
  final code = await blocks.api.basicGetLastCode(username: username);
  if (code == null) {
    throw StateError(
      'No verification code was delivered to $username — is BLOCKS_URL the '
      'local dev server?',
    );
  }
  return blocks.api.basicConfirmSignUp(username: username, code: code.code);
}

/// Leaves a user signed in on the email + password block and returns their
/// credentials: a fresh, confirmed user on the local dev server, the
/// pre-provisioned [returningUser] on a deployed backend.
Future<({String username, String password})> signInTestUser(
  Blocks blocks,
  String label,
) async {
  if (isLocalEndpoint()) {
    final username = uniqueUsername(label);
    final result = await signUpAndConfirm(blocks, username);
    if (result.status != NativeSignInResultStatus.signedIn) {
      throw StateError('auto sign-in did not complete: ${result.nextStep}');
    }
    return (username: username, password: e2ePassword);
  }
  final user = returningUser();
  final result = await blocks.api.basicSignIn(
    username: user.username,
    password: user.password,
  );
  if (result.status != NativeSignInResultStatus.signedIn) {
    throw StateError('sign-in did not complete: ${result.nextStep}');
  }
  return user;
}

/// Records an intentionally-skipped leg (not a failure). Prints a clear marker
/// so the run output shows why a path didn't execute against this backend.
void skip(String message) {
  print('  ⊘ SKIP: $message');
}

void group(String name) {
  print('\n--- $name ---');
}

void check(bool condition, String message) {
  if (!condition) {
    _failed++;
    print('  ✗ $message');
  } else {
    _passed++;
    print('  ✓ $message');
  }
}

Future<T?> expectError<T>(Future<T> Function() fn, {String? label}) async {
  try {
    await fn();
    _failed++;
    print('  ✗ ${label ?? "expected error"} — no error thrown');
    return null;
  } on BlocksRpcException catch (e) {
    _passed++;
    print(
      '  ✓ ${label ?? "expected error"} — got BlocksRpcException(${e.code}): ${e.message}',
    );
    return null;
  } catch (e) {
    _passed++;
    print('  ✓ ${label ?? "expected error"} — got ${e.runtimeType}: $e');
    return null;
  }
}

/// Like [expectError], but passes only when the call throws a
/// [BlocksRpcException] whose server error name (`error.data.name`) is [name].
/// Errors cross the wire by name, so suites assert on it rather than on the
/// message.
Future<void> expectErrorNamed(
  Future<Object?> Function() fn,
  String name, {
  required String label,
}) async {
  try {
    await fn();
    _failed++;
    print('  ✗ $label — no error thrown (expected $name)');
  } on BlocksRpcException catch (e) {
    final data = e.data;
    final actual = data is Map ? data['name'] : null;
    check(actual == name, '$label — $name (got $actual: ${e.message})');
  } catch (e) {
    _failed++;
    print('  ✗ $label — expected BlocksRpcException $name, got $e');
  }
}

void printResults() {
  print('\n${'=' * 40}');
  print('Results: $_passed passed, $_failed failed');
  if (_failed > 0) {
    print('❌ SOME TESTS FAILED');
    exit(1);
  } else {
    print('✅ All tests passed!');
  }
}
