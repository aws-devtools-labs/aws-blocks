#!/usr/bin/env bash
# Test for analyze-fixture-goldens.sh. Run from anywhere.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ANALYZE="$SCRIPT_DIR/analyze-fixture-goldens.sh"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

fail() { echo "FAIL: $1" >&2; exit 1; }

# golden <fixtures-dir> <fixture> <body>: write <fixture>/dart/client.dart.
golden() {
  mkdir -p "$1/$2/dart"
  printf '%s\n' "$3" > "$1/$2/dart/client.dart"
}

# --- Case 1: clean goldens pass, and every one is counted ---
CLEAN="$WORK/clean"
golden "$CLEAN" 01-ok "import 'package:blocks_runtime/blocks_runtime.dart';

final class Api {
  const Api(this.client);
  final BlocksClient client;
}"
golden "$CLEAN" 02-also-ok 'int answer() => 42;'
out="$(bash "$ANALYZE" "$CLEAN" 2>&1)" || fail "Case 1: clean goldens should pass: $out"
case "$out" in *"OK: 2 Dart fixture golden(s) analyze with 0 errors"*) ;; *) fail "Case 1: unexpected output: $out" ;; esac

# --- Case 2: a warning (unused local) is advisory, not a failure ---
WARN="$WORK/warn"
golden "$WARN" 01-warning 'void f() {
  final unused = 1;
}'
bash "$ANALYZE" "$WARN" > /dev/null 2>&1 || fail "Case 2: a warning must not fail the run"

# --- Case 3: an error fails, naming the golden and line it came from ---
BROKEN="$WORK/broken"
golden "$BROKEN" 01-ok 'int answer() => 42;'
golden "$BROKEN" 02-nullable 'class A {
  A(this.name) {
    if (!(name == null || name.length >= 2)) throw ArgumentError();
  }
  final String? name;
}'
if out="$(bash "$ANALYZE" "$BROKEN" 2>&1)"; then
  fail "Case 3: an analyzer error should fail the run"
fi
case "$out" in *"02-nullable/dart/client.dart:3:"*) ;; *) fail "Case 3: error not attributed to its golden: $out" ;; esac
case "$out" in *"FAIL: 1 analyzer error(s) in 2 Dart fixture golden(s)"*) ;; *) fail "Case 3: unexpected summary: $out" ;; esac

# --- Case 4: strict-casts applies (dynamic passed where a typed value is expected) ---
STRICT="$WORK/strict"
golden "$STRICT" 01-dynamic 'int take(int v) => v;
int f(Map<String, dynamic> json) => take(json["n"]);'
if bash "$ANALYZE" "$STRICT" > /dev/null 2>&1; then
  fail "Case 4: an implicit dynamic downcast should fail under strict-casts"
fi

# --- Case 5: no goldens is an error, not a vacuous pass ---
mkdir -p "$WORK/empty"
if bash "$ANALYZE" "$WORK/empty" > /dev/null 2>&1; then
  fail "Case 5: an empty fixtures directory should fail"
fi

# fake_dart <name> <analyze-body>: a `dart` that runs the real one, except for
# `analyze`, which runs <analyze-body> instead.
REAL_DART="$(command -v "${DART:-dart}")"
fake_dart() {
  cat > "$WORK/$1" <<SH
#!/usr/bin/env bash
if [ "\$1" = analyze ]; then
$2
fi
exec "$REAL_DART" "\$@"
SH
  chmod +x "$WORK/$1"
  printf '%s' "$WORK/$1"
}

# --- Case 6: an analyzer crash fails the run, even with no ERROR| line ---
CRASH_DART="$(fake_dart dart-crash '  echo "Bad state: the analysis server crashed" >&2
  exit 70')"
if out="$(DART="$CRASH_DART" bash "$ANALYZE" "$CLEAN" 2>&1)"; then
  fail "Case 6: an analyzer crash (exit 70) should fail the run: $out"
fi
case "$out" in *"FAIL: dart analyze did not complete (exit 70)"*) ;; *) fail "Case 6: unexpected output: $out" ;; esac
case "$out" in *"Bad state: the analysis server crashed"*) ;; *) fail "Case 6: the crash output should be shown: $out" ;; esac

# --- Case 7: exit 3 (errors) with no parseable ERROR| line fails the run ---
EXIT3_DART="$(fake_dart dart-exit3 '  echo "1 error found."
  exit 3')"
if out="$(DART="$EXIT3_DART" bash "$ANALYZE" "$CLEAN" 2>&1)"; then
  fail "Case 7: exit 3 without an ERROR| line should fail the run: $out"
fi
case "$out" in *"no ERROR| line could be parsed"*) ;; *) fail "Case 7: unexpected output: $out" ;; esac

# --- Case 8: exit 1 or 2 (infos, warnings) with no errors still passes ---
EXIT2_DART="$(fake_dart dart-exit2 '  echo "WARNING|STATIC_WARNING|UNUSED|x|1|1|1|advisory"
  exit 2')"
DART="$EXIT2_DART" bash "$ANALYZE" "$CLEAN" > /dev/null 2>&1 || fail "Case 8: exit 2 with no errors must pass"

echo "PASS: analyze-fixture-goldens.sh"
