#!/usr/bin/env bash
# Compiles every codegen fixture's Swift golden as its own module against the
# in-repo BlocksRuntime, and fails if any doesn't compile. The goldens are what
# the Swift generator emits for each spec, so an error here is an error in a
# customer's generated client. The golden tests only compare text, so without
# this a golden that doesn't compile still passes.
#
# Usage: compile-fixture-goldens.sh [FIXTURES_DIR]
#   FIXTURES_DIR  defaults to native/codegen-fixtures. Each `*/swift/` under it
#                 holding `Api.swift` (and usually `Models.swift`) is compiled.
#   SWIFTC        the compiler command (default: `xcrun swiftc`). macOS only:
#                 BlocksRuntime uses Apple frameworks (CryptoKit, Security, os).
#
# BlocksRuntime is built once from Sources/BlocksRuntime into a scratch
# directory, as a library module for the package's minimum macOS. Each golden is
# then compiled and linked as a separate library module that imports it, the
# way an app that keeps its generated client in its own module builds it. The
# `public` surface, access control and cross-module rules all apply. Swift 5
# language mode, as in Package.swift.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SWIFT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
FIXTURES_DIR="$(cd "${1:-$SWIFT_DIR/../codegen-fixtures}" && pwd)"
read -r -a SWIFTC_CMD <<< "${SWIFTC:-xcrun swiftc}"

# Package.swift: `platforms: [.iOS(.v16), .macOS(.v13)]`.
TARGET="$(uname -m)-apple-macos13.0"
COMMON=(-swift-version 5 -target "$TARGET" -parse-as-library)

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

runtime_sources=()
while IFS= read -r file; do runtime_sources+=("$file"); done \
  < <(find "$SWIFT_DIR/Sources/BlocksRuntime" -name '*.swift' | sort)
if [ "${#runtime_sources[@]}" -eq 0 ]; then
  echo "error: no BlocksRuntime sources under $SWIFT_DIR/Sources/BlocksRuntime" >&2
  exit 1
fi
mkdir -p "$WORK/runtime"
if ! "${SWIFTC_CMD[@]}" "${COMMON[@]}" -module-name BlocksRuntime -emit-library -emit-module \
    -emit-module-path "$WORK/runtime/BlocksRuntime.swiftmodule" \
    -o "$WORK/runtime/libBlocksRuntime.dylib" \
    "${runtime_sources[@]}" > "$WORK/runtime.log" 2>&1; then
  cat "$WORK/runtime.log" >&2
  echo "error: BlocksRuntime didn't compile" >&2
  exit 1
fi

count=0
warnings=0
failed=()
for dir in "$FIXTURES_DIR"/*/swift; do
  [ -f "$dir/Api.swift" ] || continue
  fixture="$(basename "$(dirname "$dir")")"
  count=$((count + 1))
  # A module name is an identifier: `17-transferables` -> `Fixture_17_transferables`.
  module="Fixture_$(printf '%s' "$fixture" | tr -c 'A-Za-z0-9\n' '_')"
  out="$WORK/$module"
  mkdir -p "$out" "$out/stubs"
  # Declared native modules the golden imports (`x-blocks-native-packages`): compile-only stubs.
  stub_flags=()
  stub_dir="$SCRIPT_DIR/fixture-stubs/$fixture"
  if [ -d "$stub_dir" ]; then
    for stub in "$stub_dir"/*.swift; do
      stub_module="$(basename "$stub" .swift)"
      if ! "${SWIFTC_CMD[@]}" "${COMMON[@]}" -module-name "$stub_module" -emit-library -emit-module \
          -emit-module-path "$out/stubs/$stub_module.swiftmodule" -o "$out/stubs/lib$stub_module.dylib" \
          "$stub" > "$out/stub-$stub_module.log" 2>&1; then
        cat "$out/stub-$stub_module.log" >&2
        echo "error: fixture stub $stub_module didn't compile" >&2
        exit 1
      fi
      stub_flags+=(-I "$out/stubs" -L "$out/stubs" "-l$stub_module")
    done
  fi
  sources=("$dir/Api.swift")
  # Models.swift is empty when the spec has no component schemas.
  [ -s "$dir/Models.swift" ] && sources=("$dir/Models.swift" "${sources[@]}")
  if "${SWIFTC_CMD[@]}" "${COMMON[@]}" -module-name "$module" -emit-library -emit-module \
      -emit-module-path "$out/$module.swiftmodule" -o "$out/lib$module.dylib" \
      -I "$WORK/runtime" -L "$WORK/runtime" -lBlocksRuntime ${stub_flags[@]+"${stub_flags[@]}"} \
      "${sources[@]}" > "$out/compile.log" 2>&1; then
    echo "ok - $fixture"
    warnings=$((warnings + $(grep -c ': warning: ' "$out/compile.log" || true)))
  else
    echo "not ok - $fixture" >&2
    sed 's/^/    /' "$out/compile.log" >&2
    failed+=("$fixture")
  fi
done

if [ "$count" -eq 0 ]; then
  echo "error: no */swift/Api.swift goldens under $FIXTURES_DIR" >&2
  exit 1
fi
if [ "${#failed[@]}" -gt 0 ]; then
  echo "FAIL: ${#failed[@]} of $count Swift fixture golden(s) don't compile: ${failed[*]}" >&2
  exit 1
fi

echo "OK: $count Swift fixture golden(s) compile as their own module against BlocksRuntime ($warnings warning(s), advisory)"
