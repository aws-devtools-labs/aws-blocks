#!/usr/bin/env bash
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Covers the codegen configuration surface, which no SwiftPM test target can reach:
# `swift-code-generator` is depended on only by the two plugin targets.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PKG_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

swift build --package-path "$PKG_DIR" --product swift-code-generator >/dev/null 2>&1 || {
  echo "FAIL: could not build swift-code-generator" >&2; exit 1
}
TOOL="$(swift build --package-path "$PKG_DIR" --product swift-code-generator --show-bin-path)/swift-code-generator"

cat > "$WORK/blocks.spec.json" <<'JSON'
{
  "openrpc": "1.3.2",
  "info": { "title": "t", "version": "1.0.0" },
  "methods": [
    { "name": "api.getHandle", "params": [],
      "result": { "name": "R", "schema": { "x-blocks-transferable": "example-iot/device-handle" } } }
  ],
  "x-blocks-native-packages": { "schemaVersion": 1, "packages": { "example-iot-native": {
    "platforms": { "swift": { "package": {
      "identity": "example-iot-native", "product": "ExampleIotNative", "module": "ExampleIotNative" } } } } } },
  "x-blocks-native-bindings": { "schemaVersion": 1, "bindings": [
    { "id": "h", "kind": "transferable", "tag": "example-iot/device-handle",
      "package": "example-iot-native", "export": "deviceHandle",
      "abi": "blocks-transferable-v1", "genericArity": 0 } ] }
}
JSON

FAILED=0
check() {
  local name="$1" want_exit="$2" want="$3" config="$4" args=()
  rm -rf "$WORK/out"
  rm -f "$WORK/blocks.codegen.json"
  if [[ "$config" != "NONE" ]]; then
    printf '%s' "$config" > "$WORK/blocks.codegen.json"
    args=("$WORK/blocks.codegen.json")
  fi
  local out got_exit=0
  out="$("$TOOL" "$WORK/blocks.spec.json" "$WORK/out" ${args[@]+"${args[@]}"} 2>&1)" || got_exit=$?
  local body=""
  if [[ -f "$WORK/out/API.swift" ]]; then body="$(cat "$WORK/out/API.swift")"; fi
  if [[ "$got_exit" != "$want_exit" ]]; then
    echo "FAIL $name: exit $got_exit, want $want_exit" >&2; echo "$out" >&2; FAILED=1; return
  fi
  if ! grep -qF -- "$want" <<<"$out$body"; then
    echo "FAIL $name: expected '$want'" >&2; echo "$out" >&2; FAILED=1; return
  fi
  echo "ok $name"
}

check "no config generates the typed binding"        0 "ExampleIotNative.DeviceHandle" NONE
check "every documented key is accepted"             0 "AWSBLOCKS-NATIVE-001" '{"optOutNativePackages":["example-iot-native"]}'
check "valid config opts the package out"            0 "BlocksRuntime.UnknownTransferable" '{"optOutNativePackages":["example-iot-native"]}'
check "empty opt-out list keeps the typed binding"   0 "ExampleIotNative.DeviceHandle" '{"optOutNativePackages":[]}'
check "mistyped key is named"                        1 "declares unknown key(s): optOutNativePackage" '{"optOutNativePackage":["example-iot-native"]}'
check "mistyped key beside a correct one is named"   1 "declares unknown key(s): optOutNativePackage" '{"optOutNativePackages":[],"optOutNativePackage":["example-iot-native"]}'
check "an absent key is named"                      1 "optOutNativePackages" '{}'
check "mistyped identity is reported"                0 "AWSBLOCKS-NATIVE-006" '{"optOutNativePackages":["exampl-iot-native"]}'
check "a JSON array is rejected as not an object"    1 "is not a JSON object" '["example-iot-native"]'
check "malformed JSON is named as such"              1 "is not valid codegen configuration" '{"optOutNativePackages":'

# The README tells a customer to write this file, so the CLI must not ignore it.
rm -rf "$WORK/out"
printf '%s' '{"optOutNativePackages":["example-iot-native"]}' > "$WORK/blocks.codegen.json"
UNPASSED_RC=0
UNPASSED="$("$TOOL" "$WORK/blocks.spec.json" "$WORK/out" 2>&1)" || UNPASSED_RC=$?
# REMEDY is the text after the message's own fixed prefix, so the assertions below
# cannot match an interpolated path. A prefix change leaves the slice equal to the
# whole message, which the != check below catches.
REMEDY="${UNPASSED#*was not passed; }"
if [[ $UNPASSED_RC -ne 0 ]] && [[ ! -e "$WORK/out" ]] && [[ "$REMEDY" != "$UNPASSED" ]] \
  && grep -qF "exists but was not passed" <<<"$UNPASSED" \
  && grep -qF "a member of the target, like the spec" <<<"$REMEDY" \
  && grep -qF "third argument, after the output directory" <<<"$REMEDY" \
  && ! grep -qF ".copy(" <<<"$REMEDY" \
  && ! grep -qiE "target'?s? resources" <<<"$REMEDY"; then
  echo "ok an unpassed sidecar config is refused, naming both remedies"
else
  echo "FAIL unpassed sidecar: generated anyway, or the remedy names no step the reader can take" >&2
  echo "$UNPASSED" | tail -3 >&2; FAILED=1
fi

rm -rf "$WORK/out"
printf '%s' '{"optOutNativePackages":["example-iot-native"]}' > "$WORK/blocks.codegen.json"
PASSED_RC=0
PASSED="$("$TOOL" "$WORK/blocks.spec.json" "$WORK/out" "$WORK/blocks.codegen.json" 2>&1)" || PASSED_RC=$?
if [[ $PASSED_RC -eq 0 ]] && [[ -f "$WORK/out/API.swift" ]] && [[ -f "$WORK/out/Models.swift" ]] \
  && grep -qF "BlocksRuntime.UnknownTransferable" "$WORK/out/API.swift"; then
  echo "ok the remedy the refusal names generates, and honours the opt-out"
else
  echo "FAIL remedy: following the refusal's own instruction did not generate, or ignored the opt-out" >&2
  echo "$PASSED" | tail -3 >&2; FAILED=1
fi

rm -f "$WORK/blocks.codegen.json"

cat > "$WORK/nocat.spec.json" <<'JSON'
{ "openrpc": "1.3.2", "info": { "title": "t", "version": "1.0.0" },
  "methods": [ { "name": "api.get", "params": [],
    "result": { "name": "R", "schema": { "type": "string" } } } ] }
JSON
printf '%s' '{"optOutNativePackages":["example-iot-native"]}' > "$WORK/nocat.codegen.json"
rm -rf "$WORK/outnc"
NOCAT_RC=0
NOCAT="$("$TOOL" "$WORK/nocat.spec.json" "$WORK/outnc" "$WORK/nocat.codegen.json" 2>&1)" || NOCAT_RC=$?
if [[ $NOCAT_RC == 0 ]] && grep -qF "AWSBLOCKS-NATIVE-006" <<<"$NOCAT"; then
  echo "ok an opt-out against a catalog-free spec warns rather than fails"
else
  echo "FAIL catalog-free opt-out: expected exit 0 with AWSBLOCKS-NATIVE-006" >&2
  echo "$NOCAT" | tail -3 >&2; FAILED=1
fi

rm -rf "$WORK/amb"; mkdir -p "$WORK/amb"
cp "$WORK/blocks.spec.json" "$WORK/amb/blocks.spec.json"
printf '%s' '{"optOutNativePackages":["example-iot-native"]}' > "$WORK/amb/blocks.codegen.json"
printf '%s' '{"optOutNativePackages":[]}' > "$WORK/amb/other.json"
AMB="$("$TOOL" "$WORK/amb/blocks.spec.json" "$WORK/amb/out" "$WORK/amb/other.json" 2>&1)" || true
if grep -qF "is present but ignored" <<<"$AMB"; then
  echo "ok a sidecar overridden by an explicit config is reported"
else
  echo "FAIL overridden sidecar: the ignored file was not named" >&2; echo "$AMB" | tail -3 >&2; FAILED=1
fi
AMB3="$(cd "$WORK/amb" && "$TOOL" blocks.spec.json out3 ../amb/blocks.codegen.json 2>&1)" || true
if grep -qF "is present but ignored" <<<"$AMB3"; then
  echo "FAIL relative detour: the sidecar warned about itself" >&2; echo "$AMB3" | tail -3 >&2; FAILED=1
else
  echo "ok a sidecar reached by a relative detour warns about nothing"
fi

AMB2="$("$TOOL" "$WORK/amb/blocks.spec.json" "$WORK/amb/out2" "$WORK/amb/blocks.codegen.json" 2>&1)" || true
if grep -qF "is present but ignored" <<<"$AMB2"; then
  echo "FAIL overridden sidecar: warned when the sidecar itself was passed" >&2; FAILED=1
else
  echo "ok passing the sidecar itself warns about nothing"
fi

EXPECTED_CODES="AWSBLOCKS-NATIVE-001 AWSBLOCKS-NATIVE-003 AWSBLOCKS-NATIVE-004 AWSBLOCKS-NATIVE-005 AWSBLOCKS-NATIVE-006"
ACTUAL_CODES="$(grep -rhoE "AWSBLOCKS-NATIVE-[0-9]+" \
  "$PKG_DIR/Sources" "$PKG_DIR/Plugins" "$PKG_DIR/.changeset" | sort -u | tr '\n' ' ')" || true
if [[ "$(tr -s ' ' <<<"$ACTUAL_CODES" | sed 's/ $//')" == "$EXPECTED_CODES" ]]; then
  echo "ok Swift emits exactly the documented diagnostic codes"
else
  echo "FAIL diagnostic codes: Swift emits [$ACTUAL_CODES], documented [$EXPECTED_CODES]" >&2
  echo "     002 is allocated to a Dart diagnostic on origin/main; coordinate before reusing a number." >&2
  FAILED=1
fi

# Guards that the plugin forwards the config path: a config naming an undeclared
# package is rejected by the generator, which can only happen if the path arrived.
APP="$WORK/app"
mkdir -p "$APP/Sources/App"
cat > "$APP/Package.swift" <<PKG
// swift-tools-version: 5.9
import PackageDescription
let package = Package(
    name: "app",
    platforms: [.iOS(.v16), .macOS(.v13)],
    dependencies: [.package(path: "$PKG_DIR")],
    targets: [
        .target(
            name: "App",
            dependencies: [.product(name: "BlocksRuntime", package: "swift")],
            path: "Sources/App",
            // Intentionally no \`resources:\` entry — this fixture proves the plugin
            // forwards the sidecar without one.
            plugins: [.plugin(name: "BlocksCodegenBuildPlugin", package: "swift")]
        )
    ]
)
PKG
cp "$WORK/blocks.spec.json" "$APP/Sources/App/blocks.spec.json"
printf '%s' '{"optOutNativePackages":["no-such-package"]}' > "$APP/Sources/App/blocks.codegen.json"
# Without a Swift source SwiftPM treats the directory as a C target and fails on a
# missing `include` directory.
echo 'let appMarker = 0' > "$APP/Sources/App/Marker.swift"

PLUGIN_OUT="$(swift build --package-path "$APP" 2>&1)" || true
if grep -qF "opted-out package 'no-such-package' has nothing to opt out of" <<<"$PLUGIN_OUT"; then
  echo "ok plugin forwarded the config path to the generator"
else
  echo "FAIL plugin forwards the config: the generator never read it" >&2
  echo "$PLUGIN_OUT" | tail -5 >&2
  FAILED=1
fi

mkdir -p "$APP/Sources/App/elsewhere"
mv "$APP/Sources/App/blocks.codegen.json" "$APP/Sources/App/elsewhere/blocks.codegen.json"
rm -rf "$APP/.build"
PLUGIN_OUT="$(swift build --package-path "$APP" 2>&1)" || true
# Purely negative on its own, so without this liveness gate a build whose plugin never
# ran would also print ok. The typed binding is what proves the generator ran and did
# not apply the out-of-scope opt-out; the build itself exits non-zero here because the
# app declares no dependency on the module the untouched binding imports.
SCOPED_API="$(find "$APP/.build" -name API.swift -print -quit 2>/dev/null || true)"
if [[ -z "$SCOPED_API" ]] || ! grep -qF "ExampleIotNative.DeviceHandle" "$SCOPED_API"; then
  echo "FAIL config scoping: no generated typed binding, so the generator never ran" >&2
  echo "$PLUGIN_OUT" | tail -5 >&2
  FAILED=1
elif grep -qF "opted-out package 'no-such-package' has nothing to opt out of" <<<"$PLUGIN_OUT"; then
  echo "FAIL config scoping: a config outside the spec's directory was forwarded" >&2
  FAILED=1
else
  echo "ok a config outside the spec's directory is ignored"
fi

# The command plugin writes generated source into the package directory, so an ignored
# config there lands committed source that contradicts the customer's own config.
CMD="$WORK/cmd"
mkdir -p "$CMD/Sources/App"
cp "$APP/Package.swift" "$CMD/Package.swift"
cp "$WORK/blocks.spec.json" "$CMD/Sources/App/blocks.spec.json"
echo 'let appMarker = 0' > "$CMD/Sources/App/Marker.swift"
printf '%s' '{"optOutNativePackages":["no-such-package"]}' > "$CMD/Sources/App/blocks.codegen.json"

CMD_OUT="$(cd "$CMD" && swift package --allow-writing-to-package-directory \
  generate-code-from-blocks-spec --target App 2>&1)" || true
if grep -qF "opted-out package 'no-such-package' has nothing to opt out of" <<<"$CMD_OUT"; then
  echo "ok command plugin forwarded the config path to the generator"
else
  echo "FAIL command plugin forwards the config: the generator never read it" >&2
  echo "$CMD_OUT" | tail -5 >&2
  FAILED=1
fi

if [[ $FAILED == 0 ]]; then echo "codegen-config.test.sh: all checks passed"; fi
exit $FAILED
