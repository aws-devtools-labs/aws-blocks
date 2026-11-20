#!/usr/bin/env bash
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0

# Test for compile-fixture-goldens.sh. Run from anywhere. macOS only (the
# script compiles BlocksRuntime with `xcrun swiftc`); CI runs it in the macOS
# `fixture-goldens` job.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMPILE="$SCRIPT_DIR/compile-fixture-goldens.sh"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

fail() { echo "FAIL: $1" >&2; exit 1; }

# golden <fixtures-dir> <fixture> <Api.swift body> [Models.swift body]: write <fixture>/swift/.
# Models.swift is written empty when no body is given, as the generator does for a spec with no schemas.
golden() {
  mkdir -p "$1/$2/swift"
  printf '%s\n' "$3" > "$1/$2/swift/Api.swift"
  if [ $# -ge 4 ]; then printf '%s\n' "$4" > "$1/$2/swift/Models.swift"; else : > "$1/$2/swift/Models.swift"; fi
}

# --- Case 1: clean goldens pass, each is counted, and they can use BlocksRuntime ---
CLEAN="$WORK/clean"
golden "$CLEAN" 01-ok 'import Foundation
import BlocksRuntime

public class Api {
    private let client: BlocksClient
    public init(server: BlocksServer) { self.client = BlocksClient(server: server) }
}'
golden "$CLEAN" 02-with-models 'import Foundation

public func first(_ notes: [Note]) -> Note? { notes.first }' 'import Foundation

public struct Note: Codable {
    public let id: String
    public init(id: String) { self.id = id }
}'
# Same type name as 02: each golden is its own module, so they don't clash.
golden "$CLEAN" 03-same-names 'public struct Note {}'
out="$(bash "$COMPILE" "$CLEAN" 2>&1)" || fail "Case 1: clean goldens should pass: $out"
case "$out" in *"OK: 3 Swift fixture golden(s) compile as their own module against BlocksRuntime"*) ;; *) fail "Case 1: unexpected output: $out" ;; esac

# --- Case 2: a type error fails, naming the golden and line it came from ---
BROKEN="$WORK/broken"
golden "$BROKEN" 01-ok 'public let answer = 42'
golden "$BROKEN" 17-nested 'public enum GetChannel {
    public struct ResultMessage {}
}
public func get() -> ResultMessage? { nil }'
if out="$(bash "$COMPILE" "$BROKEN" 2>&1)"; then
  fail "Case 2: a golden that doesn't compile should fail the run"
fi
case "$out" in *"17-nested/swift/Api.swift:4:"*"cannot find type 'ResultMessage' in scope"*) ;; *) fail "Case 2: error not attributed to its golden: $out" ;; esac
case "$out" in *"FAIL: 1 of 2 Swift fixture golden(s) don't compile: 17-nested"*) ;; *) fail "Case 2: unexpected summary: $out" ;; esac

# --- Case 3: it's a separate module, so a type the golden uses from another module must be public ---
ACCESS="$WORK/access"
golden "$ACCESS" 01-public-runtime-api 'import BlocksRuntime
public func make() -> BlocksRequest { BlocksRequest(method: "m", params: [], id: 1) }'
bash "$COMPILE" "$ACCESS" > /dev/null 2>&1 || fail "Case 3: BlocksRuntime's public API should be visible to a golden"
golden "$ACCESS" 02-uses-internal 'import BlocksRuntime
func peek() { _ = BlocksRuntimeSession.self }'
if out="$(bash "$COMPILE" "$ACCESS" 2>&1)"; then
  fail "Case 3: a golden using an internal BlocksRuntime type should fail"
fi
case "$out" in *"FAIL: 1 of 2 Swift fixture golden(s) don't compile: 02-uses-internal"*) ;; *) fail "Case 3: unexpected summary: $out" ;; esac

# --- Case 4: Models.swift and Api.swift are one module, so they see each other's internal names ---
SPLIT="$WORK/split"
golden "$SPLIT" 01-split 'public func make() -> Note { Note() }' 'public struct Note {}'
bash "$COMPILE" "$SPLIT" > /dev/null 2>&1 || fail "Case 4: Api.swift should see Models.swift's types"

# --- Case 5: the package's minimum macOS applies (an API newer than macOS 13 fails) ---
AVAIL="$WORK/avail"
golden "$AVAIL" 01-too-new 'import Foundation
@available(macOS 99, *) public func future() {}
public func call() { future() }'
if bash "$COMPILE" "$AVAIL" > /dev/null 2>&1; then
  fail "Case 5: an API unavailable on macOS 13 should fail"
fi

# --- Case 5b: a golden compiles in Swift 6 mode, so a Sendable it can't keep fails ---
SENDABLE="$WORK/sendable"
golden "$SENDABLE" 01-wrong-sendable 'public final class Box { public var count = 0 }
public struct Holder: Sendable { public let box: Box }'
if out="$(bash "$COMPILE" "$SENDABLE" 2>&1)"; then
  fail "Case 5b: a struct claiming Sendable over a mutable class should fail: $out"
fi
case "$out" in *"FAIL: 1 of 1 Swift fixture golden(s) don't compile: 01-wrong-sendable"*) ;; *) fail "Case 5b: unexpected summary: $out" ;; esac
# The diagnostic's wording and case vary by Swift version (`non-Sendable` / `non-sendable`), so match either form.
printf '%s' "$out" | grep -qiE "non-sendable type 'Box'|does not conform to the 'Sendable' protocol" \
  || fail "Case 5b: the Sendable error should be reported: $out"

# --- Case 6: no goldens is an error, not a vacuous pass ---
mkdir -p "$WORK/empty"
if bash "$COMPILE" "$WORK/empty" > /dev/null 2>&1; then
  fail "Case 6: an empty fixtures directory should fail"
fi

# --- Case 7: an expected codegen error is skipped, not compiled or counted ---
REFUSED="$WORK/refused"
golden "$REFUSED" 01-ok 'public let answer = 42'
mkdir -p "$REFUSED/02-refused/swift"
printf 'not Swift\n' > "$REFUSED/02-refused/swift/codegen-error.txt"
out="$(bash "$COMPILE" "$REFUSED" 2>&1)" || fail "Case 7: an expected codegen error should pass: $out"
case "$out" in *"OK: 1 Swift fixture golden(s) compile"*) ;; *) fail "Case 7: unexpected output: $out" ;; esac
case "$out" in *"Skipped 1 fixture(s) whose Swift golden is an expected codegen-error.txt"*) ;; *) fail "Case 7: the skip should be reported: $out" ;; esac

# --- Case 8: a fixture with both Api.swift and a codegen error fails ---
golden "$REFUSED" 02-refused 'public let answer = 42'
if out="$(bash "$COMPILE" "$REFUSED" 2>&1)"; then
  fail "Case 8: Api.swift beside codegen-error.txt should fail the run: $out"
fi
case "$out" in *"has both Api.swift and codegen-error.txt"*) ;; *) fail "Case 8: unexpected output: $out" ;; esac

echo "PASS: compile-fixture-goldens.sh"
