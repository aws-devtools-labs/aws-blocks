#!/usr/bin/env bash
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0

# Counts the REST APIs in the current account and region against the EDGE
# quota (120 per region), for the REST API sweep in
# .github/workflows/cleanup-stacks.yml. A full E2E run holds about 16 EDGE APIs
# while it runs, and a saturated account fails every deploy that creates one.
#
# Usage: rest-api-quota.sh
#
# Writes "- REST APIs remaining: <total> total, <edge> EDGE (cap 120)" to stdout
# and $GITHUB_STEP_SUMMARY, plus a warning annotation once the EDGE count
# reaches REST_API_EDGE_WARN (default 80).
#
# A listing that fails or can't be parsed exits 1 with an error annotation
# carrying the CLI's message. It is never read as zero APIs: that is how the
# count went unseen while an account filled up.
#
# Tests: node --test scripts/ci/rest-api-quota.test.mjs

set -euo pipefail

cap=120
warn=${REST_API_EDGE_WARN:-80}
summary=${GITHUB_STEP_SUMMARY:-/dev/null}
err=$(mktemp)
trap 'rm -f "$err"' EXIT

# get-rest-apis pages through every API itself. One call gives both counts.
if apis=$(aws apigateway get-rest-apis --output json 2>"$err") &&
	counts=$(jq -er '(.items // []) | [length, (map(select(.endpointConfiguration.types // [] | index("EDGE"))) | length)] | @tsv' \
		<<<"$apis" 2>>"$err"); then
	read -r total edge <<<"$counts"
	echo "- REST APIs remaining: $total total, $edge EDGE (cap $cap)" | tee -a "$summary"
	if [ "$edge" -ge "$warn" ]; then
		echo "::warning::$edge/$cap EDGE REST APIs in use, approaching the hard quota"
	fi
	exit 0
fi

# The CLI's error starts with a blank line, so take the first non-blank one.
# Account ids are masked: the log of a public repository is public.
reason=$(grep -m 1 -v '^[[:space:]]*$' "$err" | head -c 500 | sed -E 's/[0-9]{12}/<account>/g' || true)
reason=${reason:-no error output}
echo "::error::could not count REST APIs, so the EDGE quota ($cap) is unchecked: ${reason//%/%25}"
echo "- REST APIs remaining: unknown, the listing failed: $reason" | tee -a "$summary"
exit 1
