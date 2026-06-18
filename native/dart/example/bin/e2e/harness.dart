import 'dart:io';
import '../../lib/blocks_client.dart';
export '../../lib/blocks_client.dart';

int _passed = 0;
int _failed = 0;

/// The endpoint the suite targets — `BLOCKS_URL` if set, otherwise the local
/// native-bindings dev server (`npm run dev:server`).
String blocksUrl() =>
    Platform.environment['BLOCKS_URL'] ?? 'http://localhost:3001/aws-blocks/api';

/// True when the suite is pointed at the local dev server (vs. a deployed
/// sandbox/production backend). Reuses the same `BLOCKS_URL` mechanism the
/// runner/CI already use to distinguish local from sandbox — the local job
/// sets `BLOCKS_URL=http://localhost:3001/...`, the sandbox job sets it to the
/// deployed `https://…execute-api…` URL.
///
/// Suites use this to gate dev-server-only affordances (e.g. AuthCognito's
/// `cognitoGetLastCode`, which reads a confirmation code the local stub stashes
/// in-process — real Cognito emails the code instead) so the sandbox run skips
/// those legs cleanly rather than failing.
bool isLocalEndpoint() {
  final host = Uri.parse(blocksUrl()).host;
  return host == 'localhost' || host == '127.0.0.1' || host == '0.0.0.0' || host == '::1';
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
    print('  ✓ ${label ?? "expected error"} — got BlocksRpcException(${e.code}): ${e.message}');
    return null;
  } catch (e) {
    _passed++;
    print('  ✓ ${label ?? "expected error"} — got ${e.runtimeType}: $e');
    return null;
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
