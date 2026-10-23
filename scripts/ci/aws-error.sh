# shellcheck shell=bash
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0

# Turns a failed AWS CLI call's stderr into a log line, for the steps of
# .github/workflows/cleanup-stacks.yml and for rest-api-quota.sh. Source it:
#
#   . scripts/ci/aws-error.sh
#   if ! OUT=$(aws ... 2>"$ERR"); then
#     aws_annotate error "$ERR" "<what failed, and what that means for this run>"
#   fi
#
# Tests: node --test scripts/ci/rest-api-quota.test.mjs

# The reason in a CLI error file: its first non-blank line (AWS CLI v2 starts
# its error with a blank line), at most 500 bytes, with 12-digit numbers masked
# because the log of a public repository is public.
aws_error_reason() {
	local reason
	reason=$(grep -m 1 -v '^[[:space:]]*$' "$1" 2>/dev/null | sed -E 's/[0-9]{12}/<account>/g' | head -c 500 || true)
	printf '%s\n' "${reason:-no error output}"
}

# Prints "::<level>::<message>: <reason>". The reason is escaped for a workflow
# command, so a "%" in it reaches the annotation as written.
aws_annotate() {
	local reason
	reason=$(aws_error_reason "$2")
	reason=${reason//%/%25}
	reason=${reason//$'\r'/%0D}
	printf '::%s::%s: %s\n' "$1" "$3" "$reason"
}
