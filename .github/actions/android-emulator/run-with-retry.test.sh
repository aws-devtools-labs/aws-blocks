#!/usr/bin/env bash
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0

# Tests run-with-retry.sh's one decision: retry, or report the failure as real.
# Getting that wrong either masks a defect on a required check or leaves a
# device-level blip costing a manual re-run, and neither is visible until it
# happens on someone's PR. A stub `adb` and a stub suite script stand in for the
# emulator, so this runs anywhere in under a second.
set -u -o pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
UNDER_TEST="$SCRIPT_DIR/run-with-retry.sh"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

failures=0

# A stub adb. ADB_STATE=device|offline decides what `adb devices` reports; every
# other subcommand succeeds silently, which is all the diagnostics calls need.
mkdir -p "$WORK/bin"
cat > "$WORK/bin/adb" <<'STUB'
#!/usr/bin/env bash
if [ "${1:-}" = "devices" ]; then
    echo "List of devices attached"
    if [ "${ADB_STATE:-device}" = "device" ]; then
        printf 'emulator-5554\tdevice\n'
    else
        printf 'emulator-5554\toffline\n'
    fi
fi
exit 0
STUB
chmod +x "$WORK/bin/adb"
export PATH="$WORK/bin:$PATH"

# A stub suite. Each line of OUTCOMES is one attempt: "0" passes, anything else
# is written to stdout and exits 1, so a case can differ per attempt.
write_suite() {
    local path=$1
    shift
    printf '%s\n' "$@" > "$WORK/outcomes"
    cat > "$path" <<'STUB'
#!/usr/bin/env bash
n=$(( $(cat "$WORK/attempts" 2>/dev/null || echo 0) + 1 ))
echo "$n" > "$WORK/attempts"
outcome=$(sed -n "${n}p" "$WORK/outcomes")
if [ "$outcome" = "0" ]; then
    echo "suite attempt $n passed"
    exit 0
fi
echo "$outcome"
exit 1
STUB
    chmod +x "$path"
}

# Runs the script under test in a clean state and records pass/fail of one check.
check() {
    local name=$1 want_status=$2 want_attempts=$3 adb_state=$4
    shift 4

    rm -rf "$WORK/diag" "$WORK/attempts"
    write_suite "$WORK/suite.sh" "$@"

    local status=0
    env WORK="$WORK" \
        ADB_STATE="$adb_state" \
        ANDROID_E2E_DIAGNOSTICS_DIR="$WORK/diag" \
        ANDROID_E2E_WAIT_ATTEMPTS=2 \
        ANDROID_E2E_WAIT_SECONDS=0 \
        bash "$UNDER_TEST" "$WORK/suite.sh" > "$WORK/out.log" 2>&1 || status=$?

    local attempts
    attempts=$(cat "$WORK/attempts" 2>/dev/null || echo 0)

    if [ "$status" = "$want_status" ] && [ "$attempts" = "$want_attempts" ]; then
        echo "ok   $name"
    else
        echo "FAIL $name: exit $status (want $want_status), ran $attempts attempt(s) (want $want_attempts)"
        sed 's/^/       | /' "$WORK/out.log"
        failures=$((failures + 1))
    fi
}

# A passing suite runs once and reports success.
check "pass: one attempt" 0 1 device "0"

# A failure that says nothing about the device is a real failure: report it
# immediately rather than spending a second run on it.
check "test failure: no retry" 1 1 device "RealtimeE2ETest > receivesPayload FAILED"

# The 2026-11-17 signature, recovered device: retry, and pass.
check "device offline then recovers: retries and passes" 0 2 device \
    "com.android.ddmlib.AdbCommandRejectedException: device offline" "0"

# Same signature, but the suite fails again: the second status is what counts.
check "device offline twice: fails after retry" 1 2 device \
    "device offline" "KvStoreE2ETest > roundTrip FAILED"

# A truncated run is a device-level signature of its own.
check "truncated run: retries" 0 2 device \
    "Test run failed to complete. Expected 55 tests, received 21" "0"

# The locally observed services-not-up case.
check "services not up: retries" 0 2 device \
    "cmd: Can't find service: package" "0"

# A device that never returns cannot be retried; the first failure stands and
# the suite is not run a second time.
check "device never returns: no retry" 1 1 offline \
    "device offline" "0"

# Exit codes other than 1 survive the no-retry path, so a crashed runner still
# reports its own status.
rm -rf "$WORK/diag" "$WORK/attempts"
cat > "$WORK/suite.sh" <<'STUB'
#!/usr/bin/env bash
echo "gradle died"
exit 143
STUB
chmod +x "$WORK/suite.sh"
status=0
env ADB_STATE=device ANDROID_E2E_DIAGNOSTICS_DIR="$WORK/diag" \
    bash "$UNDER_TEST" "$WORK/suite.sh" > "$WORK/out.log" 2>&1 || status=$?
if [ "$status" = "143" ]; then
    echo "ok   exit status is preserved"
else
    echo "FAIL exit status is preserved: got $status, want 143"
    failures=$((failures + 1))
fi

# Diagnostics are what make the next occurrence explainable, so a failing run
# must leave the attempt log behind.
if [ -s "$WORK/diag/attempt-1.log" ]; then
    echo "ok   diagnostics hold the attempt log"
else
    echo "FAIL diagnostics hold the attempt log: $WORK/diag/attempt-1.log is missing or empty"
    failures=$((failures + 1))
fi

if [ "$failures" -gt 0 ]; then
    echo "$failures check(s) failed"
    exit 1
fi
echo "all checks passed"
