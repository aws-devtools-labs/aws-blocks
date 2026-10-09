import 'dart:io';

/// Runs all E2E test suites against test-apps/native-bindings.
/// Set BLOCKS_URL env var to test against a deployed sandbox.
void main() async {
  final dart = Platform.resolvedExecutable;
  final testDir = '${Platform.script.resolve('.').toFilePath()}e2e';

  final tests = [
    'kv_store_test.dart',
    'todos_test.dart',
    'file_bucket_test.dart',
    'realtime_test.dart',
    'auth_basic_test.dart',
    'auth_cognito_test.dart',
    // Sign-up attributes through the Cognito-style block's `setAuthState`.
    'auth_sign_up_attributes_test.dart',
    // OIDC relay sign-in against `Auth`'s stub IdP. Against a deployed backend
    // the suite runs only with RUN_OIDC=1 (the backend serves the stub with
    // `unsafeAllowDeployed`, or a real IdP); otherwise it prints a visible SKIP
    // (see oidc_test.dart).
    'oidc_test.dart',
    // The JSON-RPC wire contract: positional params, a left-out optional's
    // slot kept as null (FX48).
    'rpc_wire_test.dart',
  ];

  var allPassed = true;

  for (final test in tests) {
    print('\n${'#' * 50}');
    print('# Running: $test');
    print('${'#' * 50}');

    final result = await Process.run(
      dart,
      ['run', '$testDir/$test'],
      environment: Platform.environment,
      workingDirectory: Directory.current.path,
    );

    stdout.write(result.stdout);
    stderr.write(result.stderr);

    if (result.exitCode != 0) {
      allPassed = false;
      print('\n⚠️  $test FAILED (exit ${result.exitCode})');
    }
  }

  print('\n${'=' * 50}');
  if (allPassed) {
    print('✅ ALL TEST SUITES PASSED');
  } else {
    print('❌ SOME TEST SUITES FAILED');
    exit(1);
  }
}
