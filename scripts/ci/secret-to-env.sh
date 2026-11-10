#!/usr/bin/env bash
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0

# Exports every key of a JSON secret (read from stdin) to later steps of the job
# through $GITHUB_ENV, with every value masked in the log first.
#
# Usage: aws secretsmanager get-secret-value ... --query SecretString --output text \
#          | scripts/ci/secret-to-env.sh
#
# A value taken out of a JSON secret is not redacted on its own, and a mask only
# matches a single line, so each line of each value is masked separately (as in
# publish-kotlin-maven.yml). All values are masked before the first one is
# written. Each value is written as a KEY<<DELIM block with a random delimiter,
# so a multi-line value keeps its newlines and can't add a variable of its own.
# The script never prints a value or its input outside a mask command.
#
# Tested by scripts/ci/workflow-secrets.test.mjs. SECRET_TO_ENV_TRACE=1 makes it
# report the size of $GITHUB_ENV at each mask on stderr, for that test.

set -euo pipefail

if [ -z "${GITHUB_ENV:-}" ]; then
	echo "::error::GITHUB_ENV is not set; run this from a GitHub Actions step."
	exit 1
fi

secret=$(cat)

if [ -z "${secret//[[:space:]]/}" ] || ! jq -e 'type == "object"' > /dev/null 2>&1 <<< "$secret"; then
	echo "::error::The secret is not a JSON object of KEY: value pairs."
	exit 1
fi
if ! jq -e 'all(keys[]; test("^[A-Za-z_][A-Za-z0-9_]*$"))' > /dev/null <<< "$secret"; then
	echo "::error::Every key of the secret must be an environment variable name ([A-Za-z_][A-Za-z0-9_]*)."
	exit 1
fi

mask() {
	# GitHub masks match only one line. Never echo the whole value: a
	# multi-line value would print every line after the first.
	while IFS= read -r line; do
		if [ -n "$line" ]; then
			if [ -n "${SECRET_TO_ENV_TRACE:-}" ]; then
				echo "trace: mask $(wc -c < "$GITHUB_ENV" | tr -d ' ')" >&2
			fi
			printf '::add-mask::%s\n' "$line"
		fi
	done <<< "$1"
	return 0
}

value_of() {
	jq -r --arg k "$1" '.[$k] | if type == "string" then . else tojson end' <<< "$secret"
}

mapfile -t keys < <(jq -r 'keys_unsorted[]' <<< "$secret")

for key in "${keys[@]}"; do
	mask "$(value_of "$key")"
done

for key in "${keys[@]}"; do
	value=$(value_of "$key")
	delim="EOF_$(od -An -tx1 -N16 /dev/urandom | tr -d ' \n')"
	if grep -qxF "$delim" <<< "$value"; then
		echo "::error::Could not pick a delimiter for $key; re-run the job."
		exit 1
	fi
	printf '%s<<%s\n%s\n%s\n' "$key" "$delim" "$value" "$delim" >> "$GITHUB_ENV"
done
