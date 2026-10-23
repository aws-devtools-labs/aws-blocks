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
# sandbox-vpc is in none of them while the VPC smoke tests are switched off
# (see below).
#
# An unknown job name blocks every job the changes call for. It only fails
# this script when the changes call for none: a failure here skips every E2E
# job, and a skipped required check counts as passing.
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

# E2E VPC Smoke has nothing to run while test-apps/vpc-smoke's sandbox script
# only echoes: the job would install, build and redeploy the unchanged
# persistent test VPC, holding a runner and the account's blocks-test-vpc-<n>
# lock, and test nothing. So it is left out, also when the trailer names it,
# until the root test:e2e:sandbox:vpc script runs anything else. A pre or post
# hook on either script counts as running something. Before switching the
# tests on, read the concurrency note on e2e-sandbox-vpc in pr-checks.yml.
# Switching them on, or removing the suite, is tracked in
# https://github.com/aws-devtools-labs/aws-blocks/issues/987. The skip is a
# warning annotation, so a skipped E2E VPC Smoke doesn't read as a normal one.
# Prints the script `name`, or nothing when it has a pre or post hook.
script_without_hooks='.scripts as $s | if $s["pre" + $name] or $s["post" + $name] then "" else $s[$name] // "" end'
vpc_root=$(jq -r --arg name test:e2e:sandbox:vpc "$script_without_hooks" package.json 2>/dev/null) || vpc_root=''
vpc_app=$(jq -r --arg name test:e2e:sandbox "$script_without_hooks" test-apps/vpc-smoke/package.json 2>/dev/null) ||
	vpc_app=''
echo_only="^echo '[^']*'( && exit 0)?$"
if [ "$vpc_root" = 'cd test-apps/vpc-smoke && npm run test:e2e:sandbox' ] && [[ $vpc_app =~ $echo_only ]] &&
	[[ " $changed $selected " == *' sandbox-vpc '* ]]; then
	vpc_skip="E2E VPC Smoke is left out: test-apps/vpc-smoke's tests are switched off (https://github.com/aws-devtools-labs/aws-blocks/issues/987)."
	echo "::warning::$vpc_skip"
	echo "$vpc_skip" >> "$GITHUB_STEP_SUMMARY"
	without_vpc() {
		local key out=''
		for key in $1; do
			[ "$key" = sandbox-vpc ] || out="$out $key"
		done
		echo "$out"
	}
	changed=$(without_vpc "$changed")
	selected=$(without_vpc "$selected")
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
