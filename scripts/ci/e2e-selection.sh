#!/usr/bin/env bash
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0

# Picks the E2E jobs PR Checks runs (the detect-changes job in
# .github/workflows/pr-checks.yml, which documents the E2E trailer).
#
# Usage: e2e-selection.sh <base-ref>, run in a checkout of the PR head.
#
# Writes three JSON arrays of job names to $GITHUB_OUTPUT:
#   e2e      jobs to run
#   blocked  jobs the changes call for but the trailer leaves out; each fails
#            in its first step
#   run      e2e + blocked, the jobs that start at all
#
# An unknown job name blocks every job the changes call for. It only fails
# this script when the changes call for none: a failure here fails E2E Sandbox
# and E2E Production (the required ones) and skips the other E2E jobs, whereas
# blocking fails each of them.
#
# Tests: node --test scripts/ci/e2e-selection.test.mjs

set -euo pipefail
# The trailer is split into words below; don't expand them as globs.
set -f

base=$1
all='templates templates-windows sandbox sandbox-vpc compute-smoke production supabase hosting telemetry'

# Exit code 1 means a difference and >1 an error, so an error counts as a
# change. No pipe into `grep -q`: under pipefail, its early exit makes a large
# `git diff` die of SIGPIPE, which would read as "no change".
if git diff --quiet "$base...HEAD" -- packages test-apps; then
	changed=''
else
	changed=$all
fi

# Several E2E trailers are joined with commas; unfold joins a value that
# continues on the next line.
trailer=$(git log -1 --format='%(trailers:key=E2E,valueonly,unfold,separator=%x2C)' HEAD)
unknown=''
if [ -z "$trailer" ]; then
	selected=$changed
else
	echo "E2E trailer on the head commit: $trailer"
	selected=''
	for key in $(echo "$trailer" | tr ',[:upper:]' ' [:lower:]'); do
		if [ "$key" = all ]; then
			selected=$all
		elif [[ " $all " == *" $key "* ]]; then
			selected="$selected $key"
		else
			echo "::error::Unknown E2E job '$key' in the head commit's E2E trailer. Use 'all' or any of: $all"
			unknown=1
			selected=''
			break
		fi
	done
fi

blocked=''
for key in $changed; do
	[[ " $selected " == *" $key "* ]] || blocked="$blocked $key"
done

# shellcheck disable=SC2086 # split the job lists into arguments
e2e=$(jq -cn '$ARGS.positional | unique' --args $selected)
# shellcheck disable=SC2086
blocked=$(jq -cn '$ARGS.positional | unique' --args $blocked)
run=$(jq -cn --argjson a "$e2e" --argjson b "$blocked" '$a + $b | unique')

echo "E2E jobs: $e2e (account ${E2E_ACCOUNT:-?})" | tee -a "$GITHUB_STEP_SUMMARY"
if [ "$blocked" != '[]' ]; then
	echo "Blocked by the E2E trailer: $blocked" >> "$GITHUB_STEP_SUMMARY"
	echo "::error::The E2E trailer leaves out $blocked, which this PR's changes call for. Those jobs fail; push a commit without the trailer before merging."
fi
{
	echo "e2e=$e2e"
	echo "blocked=$blocked"
	echo "run=$run"
} >> "$GITHUB_OUTPUT"

# No source change: nothing is required, so failing here is safe.
if [ -n "$unknown" ] && [ -z "$changed" ]; then
	exit 1
fi
