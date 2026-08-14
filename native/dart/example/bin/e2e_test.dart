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
  ];

  // The OIDC relay suite needs a deployed HTTPS sandbox (the stub IdP rejects
  // non-HTTPS redirect_uris) AND the server-relay OidcClient (signInRelay /
  // PersistentSessionStore), which ships in PR #824 (feat/dart-oidc-server-relay),
  // not yet on main. Opt in with RUN_OIDC=1 once both are available.
  if (Platform.environment['RUN_OIDC'] == '1') {
    tests.add('oidc_test.dart');
  }

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
