#!/usr/bin/env bash
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0

# Runs an E2E script against a booted emulator, and retries it exactly once when
# the first failure looks like the device fell out from under the run rather than
# a test disagreeing with the code.
#
# The distinction is the point. The Android leg is a required check, so a real
# failure has to fail the first time and stay failed. But the device can also
# leave adb's view mid-run while the emulator itself is fine — observed
# 2026-11-17, where adb reported the device offline two seconds into the suite,
# 21 of 55 tests reported, and the emulator was still healthy enough to save a
# snapshot at shutdown. That costs a manual re-run and tells nobody anything.
#
# A retry that passes is always announced, never silent: a product bug that only
# shows up sometimes must not look like a clean run.
#
# Usage: run-with-retry.sh <script-to-run>
#
# Env:
#   ANDROID_E2E_DIAGNOSTICS_DIR  where attempt logs and device state are written
#                                (default: $RUNNER_TEMP/android-e2e-diagnostics)
#   ANDROID_E2E_WAIT_ATTEMPTS    polls for the device between attempts (default 60)
#   ANDROID_E2E_WAIT_SECONDS     seconds per poll (default 5)
#   ANDROID_E2E_LOGCAT_LINES     logcat lines kept per attempt (default 5000)
set -u -o pipefail

SCRIPT=${1:?usage: run-with-retry.sh <script-to-run>}
DIAG=${ANDROID_E2E_DIAGNOSTICS_DIR:-${RUNNER_TEMP:-/tmp}/android-e2e-diagnostics}
WAIT_ATTEMPTS=${ANDROID_E2E_WAIT_ATTEMPTS:-60}
WAIT_SECONDS=${ANDROID_E2E_WAIT_SECONDS:-5}
LOGCAT_LINES=${ANDROID_E2E_LOGCAT_LINES:-5000}

mkdir -p "$DIAG"

# Output that means the device, not the code, ended the run. Every entry has been
# seen in practice: "device offline" and AdbCommandRejectedException from the
# 2026-11-17 failure, alongside the truncated-run line UTP prints when it loses
# the device; "Can't find service" from a device whose system services were not
# up yet; the install and authorization lines from adb losing a device around
# APK installation.
INFRA_SIGNATURES='device offline|AdbCommandRejectedException|DeviceDisconnectedException|Test run failed to complete|Failed to install|INSTALL_FAILED|Can.t find service|device unauthorized|device still (connecting|authorizing)'

# True when adb lists at least one device in the `device` state.
device_present() {
    adb devices 2>/dev/null | awk 'NR > 1 && $2 == "device" { found = 1 } END { exit !found }'
}

# Writes what can still be read about the device. Host-side state first, because
# an absent device is itself the finding; on-device state only while reachable.
collect_diagnostics() {
    local label=$1
    # Declared separately: bash expands every word of a `local` before running
    # it, so a second assignment on the same line cannot read the first.
    local out="$DIAG/$label-device.txt"
    {
        echo "## date"
        date -u +%FT%TZ
        echo "## adb devices -l"
        adb devices -l 2>&1
    } > "$out"
    if device_present; then
        {
            echo "## getprop sys.boot_completed"
            adb shell getprop sys.boot_completed 2>&1
            echo "## getprop init.svc.adbd"
            adb shell getprop init.svc.adbd 2>&1
            echo "## uptime"
            adb shell uptime 2>&1
        } >> "$out"
        # Bounded to the most recent lines: an unbounded `-b all` dump of a
        # device that has run the suite is tens of megabytes, and what matters
        # is the tail around the failure.
        adb logcat -b all -t "$LOGCAT_LINES" > "$DIAG/$label-logcat.txt" 2>&1 || true
    else
        echo "## device is not in adb's device list, so no on-device diagnostics" >> "$out"
    fi
}

run_attempt() {
    local label=$1
    bash "$SCRIPT" 2>&1 | tee "$DIAG/$label.log"
    return "${PIPESTATUS[0]}"
}

run_attempt attempt-1 && exit 0
status=$?
collect_diagnostics attempt-1

if ! grep -qiE "$INFRA_SIGNATURES" "$DIAG/attempt-1.log"; then
    echo "::error::E2E suite failed and nothing in its output points at the device, so this is being treated as a real failure. Not retrying."
    exit "$status"
fi

matched=$(grep -oiE "$INFRA_SIGNATURES" "$DIAG/attempt-1.log" | sort -u | tr '\n' ' ')
echo "::warning::First attempt failed with device-level output ($matched). Waiting for the device, then retrying once. Both attempts are in the diagnostics artifact."

for _ in $(seq 1 "$WAIT_ATTEMPTS"); do
    device_present && break
    sleep "$WAIT_SECONDS"
done

if ! device_present; then
    echo "::error::The device never came back (waited $((WAIT_ATTEMPTS * WAIT_SECONDS))s), so the suite could not be retried."
    collect_diagnostics after-wait
    exit "$status"
fi

# Captured through `||` rather than read from `$?` after an `if`: an `if` whose
# condition fails and which has no else branch is itself a success, so `$?` would
# be 0 and a failing retry would report a passing job.
status=0
run_attempt attempt-2 || status=$?

if [ "$status" -eq 0 ]; then
    echo "::warning::The retry passed. The first attempt failed on: $matched — if this recurs, treat it as a real defect rather than a flake."
    exit 0
fi
collect_diagnostics attempt-2
exit "$status"
