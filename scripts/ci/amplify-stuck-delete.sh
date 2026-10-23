#!/usr/bin/env bash
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0

# Unblocks an Amplify Gen 2 sandbox stack stuck in DELETE_FAILED, for the
# Amplify sweep in .github/workflows/cleanup-stacks.yml.
#
# Usage: amplify-stuck-delete.sh <root-stack>
#        amplify-stuck-delete.sh --leftovers
#
# Amplify's managed DynamoDB table is a custom resource
# (Custom::AmplifyDynamoDBTable) in a nested model stack: root -> data ->
# amplifyData<Model>NestedStack. When a sandbox deploy fails elsewhere while
# the table is being created, CloudFormation cancels the resource and gives
# it a placeholder physical id, but Amplify's table manager has already
# created the table under its real name (<Model>-<apiId>-<env>). On delete,
# the table manager calls dynamodb:DescribeTable on the placeholder name,
# which its own role is not allowed to do, so the delete fails on every retry
# and the whole tree stays in DELETE_FAILED, holding its AppSync API against
# the regional quota.
#
# This script walks the nested stacks below the root to the ones that hold
# the failed resources. It deletes such a nested stack again with
# --retain-resources when every failed resource in it shows exactly that
# signature, judged from the stack's events:
#   - the create failed and never reached CREATE_COMPLETE or UPDATE_COMPLETE;
#   - the delete failed on the dynamodb:DescribeTable denial for its own
#     (placeholder) physical id.
# Any other failed resource is reported and left for the plain retry. The
# root is never deleted here: the caller's plain delete-stack does that on
# its next run, once the nested stack is gone.
#
# Retaining the resource does not delete the real table, and no sweep deletes
# DynamoDB tables (the sweeper role has no DynamoDB access). So each retained
# resource is reported with the real table name, resolved from the nested
# stack's template and parameters, as a table to delete by hand.
#
# With --leftovers it reports those tables again, on every run: it reads the
# retained resources of the deleted model stacks. CloudFormation keeps a
# deleted stack's record, resources and template for 90 days, so a leftover
# table is reported for that long. The role can't read DynamoDB, so whether
# the table still exists is not checked.
#
# Why the nested stack and not the root: --retain-resources on the root can
# only name the data stack, which would orphan the AppSync API the sweep
# exists to free. FORCE_DELETE_STACK on the root also skips the nested stacks
# that are not DELETE_FAILED themselves (auth, table manager) and leaves them
# behind.
#
# Each retained resource, and each failed resource left in place, is appended
# to $AMPLIFY_RETAINED_FILE (when set) as a Markdown list line for the step
# summary. Stacks are printed by name, never by ARN: the ARN carries the
# account id, and the log of a public repository is public. For the same
# reason all output, including the AWS CLI's error messages (which echo ARNs),
# has 12-digit numbers masked.
#
# Exit status: 0 when nothing was deleted here (the caller retries the root
# plainly), 3 when a nested stack delete was started (the caller deletes the
# root on its next run, after the nested delete has finished), 1 on bad usage.
# With --leftovers it never deletes, and exits 0.
#
# Tests: node --test scripts/ci/amplify-stuck-delete.test.mjs

set -euo pipefail

if [ "$#" -ne 1 ] || [ -z "$1" ]; then
	echo "usage: amplify-stuck-delete.sh <root-stack> | --leftovers" >&2
	exit 1
fi

# Mask account ids in everything this script and the CLI print: re-run it
# through a foreground pipe (stderr merged into stdout), so its output can't
# interleave with the caller's and its exit status is kept. The guard holds
# the parent's pid, so a value inherited from the caller can't skip masking.
if [ "${_AMPLIFY_STUCK_DELETE_MASKED:-}" != "$PPID" ]; then
	set +e
	_AMPLIFY_STUCK_DELETE_MASKED=$$ bash "$0" "$@" 2>&1 | sed -u -E 's/[0-9]{12}/<account>/g'
	exit "${PIPESTATUS[0]}"
fi

root=$1
report=${AMPLIFY_RETAINED_FILE:-/dev/null}
table_type='Custom::AmplifyDynamoDBTable'
started=0
visited=' '

# The stack name from a name or an ARN (arn:...:stack/<name>/<uuid>).
name() {
	local n=${1#*:stack/}
	printf '%s' "${n%%/*}"
}

# "<logical id>\t<type>\t<physical id>" for each DELETE_FAILED resource of $1.
# list-stack-resources pages through every resource (describe-stack-resources
# stops at 100).
failed_resources() {
	aws cloudformation list-stack-resources --stack-name "$1" --output json </dev/null |
		jq -r '.StackResourceSummaries[]
			| select(.ResourceStatus == "DELETE_FAILED")
			| [.LogicalResourceId, .ResourceType, (.PhysicalResourceId // "")] | @tsv'
}

# Whether resource $1 (physical id $2) shows the signature above in the
# events JSON on stdin. Any error reads as "no", so an unreadable history
# never leads to a retain.
stuck_table() {
	jq -e --arg id "$1" --arg denial "not authorized to perform: dynamodb:DescribeTable on resource: arn:" \
		--arg table ":table/$2" '
		# The reason names this table: ":table/<id>" not followed by a name character.
		def names_table: (index($table)) as $i
			| $i != null and (.[($i + ($table | length)):] | test("^($|[^A-Za-z0-9._-])"));
		[.StackEvents[] | select(.LogicalResourceId == $id)] as $ev
		| ($ev | map(.ResourceStatus)) as $s
		| ($s | any(. == "CREATE_FAILED"))
			and ($s | all(. != "CREATE_COMPLETE" and . != "UPDATE_COMPLETE"))
			and ($ev | any(.ResourceStatus == "DELETE_FAILED"
				and ((.ResourceStatusReason // "") | contains($denial) and names_table)))' \
		>/dev/null 2>&1
}

# "<logical id>\t<real table name>" for each table resource named in the
# arguments of stack $1: its tableName property, with Ref resolved against
# the stack's parameters. A name that can't be resolved is left out.
table_names() {
	local stack=$1 template params id
	shift
	template=$(aws cloudformation get-template --stack-name "$stack" --output json </dev/null 2>/dev/null) || return 0
	params=$(aws cloudformation describe-stacks --stack-name "$stack" --query 'Stacks[0].Parameters' --output json \
		</dev/null 2>/dev/null) || return 0
	for id in "$@"; do
		jq -r --arg id "$id" --argjson params "${params:-null}" '
		def resolve($p):
			if type == "string" then .
			elif type == "object" and has("Ref") then ($p[.Ref] // error("unresolved"))
			elif type == "object" and has("Fn::Join") then
				.["Fn::Join"] as [$sep, $parts] | $parts | map(resolve($p)) | join($sep)
			else error("unsupported") end;
		((($params // []) | map({(.ParameterKey): .ParameterValue}) | add) // {}) as $p
		| (.TemplateBody | if type == "string" then fromjson else . end)
		| .Resources[$id].Properties.tableName | resolve($p) | "\($id)\t\(.)"' <<<"$template" 2>/dev/null || true
	done
}

stack_status() {
	aws cloudformation describe-stacks --stack-name "$1" --query 'Stacks[0].StackStatus' --output text </dev/null 2>/dev/null
}

# Walks stack $1 and the failed nested stacks below it.
walk() {
	local stack=$1 rows logical type physical keep=() blockers=() status events='' names k table
	local child_failed=0 buckets=0
	case "$visited" in *" $stack "*) return 0 ;; esac
	visited="$visited$stack "

	if ! rows=$(failed_resources "$stack"); then
		echo "::warning::could not list the resources of $(name "$stack"); left for the plain retry"
		return 0
	fi
	while IFS=$'\t' read -r logical type physical; do
		[ -z "$logical" ] && continue
		if [ "$type" = 'AWS::CloudFormation::Stack' ]; then
			child_failed=1
			if [ -n "$physical" ] && [ "$physical" != "$stack" ]; then
				walk "$physical"
			fi
			continue
		fi
		if [ "$stack" != "$root" ] && [ "$type" = "$table_type" ] && [ -n "$physical" ]; then
			# One events read per stack, however many tables failed in it.
			[ -z "$events" ] && events=$(aws cloudformation describe-stack-events --stack-name "$stack" --output json \
				</dev/null 2>/dev/null || echo '{}')
			if stuck_table "$logical" "$physical" <<<"$events"; then
				keep+=("$logical")
				continue
			fi
		fi
		# A bucket was just emptied by the caller, so the plain retry normally
		# clears it: it blocks a retain this run, with no warning.
		if [ "$type" = 'AWS::S3::Bucket' ]; then
			buckets=1
			echo "- blocked by bucket $logical in $(name "$stack") (emptied this run, retried next run)" >>"$report"
		else
			blockers+=("$logical ($type)")
		fi
	done <<<"$rows"

	if [ "${#blockers[@]}" -gt 0 ]; then
		echo "::warning::$(name "$stack") has DELETE_FAILED resource(s) left for the plain retry (not retained): ${blockers[*]}"
		for b in "${blockers[@]}"; do
			echo "- left in place: $b in $(name "$stack")" >>"$report"
		done
		return 0
	fi
	[ "$buckets" -ne 0 ] && return 0
	[ "${#keep[@]}" -eq 0 ] && return 0
	# Its own delete would race the failed nested stack's (the reason the root
	# is never deleted here). Amplify model stacks have no nested stacks.
	if [ "$child_failed" -ne 0 ]; then
		echo "  $(name "$stack") also has a failed nested stack; left for the plain retry"
		return 0
	fi

	# --retain-resources is only accepted on a stack in DELETE_FAILED.
	status=$(stack_status "$stack" || true)
	if [ "$status" != 'DELETE_FAILED' ]; then
		echo "  $(name "$stack") is ${status:-unreadable}, not DELETE_FAILED; left for the plain retry"
		return 0
	fi
	# Resolved before the delete, while the stack is still live. Later runs
	# report the table again from the deleted stack (--leftovers).
	names=$(table_names "$stack" "${keep[@]}")
	echo "  Deleting nested stack $(name "$stack"), retaining the stuck table resource(s): ${keep[*]}"
	if ! aws cloudformation delete-stack --stack-name "$stack" --retain-resources "${keep[@]}" </dev/null 2>&1; then
		echo "::warning::delete-stack with --retain-resources failed for $(name "$stack"); left for the plain retry"
		return 0
	fi
	started=1
	for k in "${keep[@]}"; do
		table=$(awk -F'\t' -v id="$k" '$1 == id { print $2; exit }' <<<"$names")
		table=${table:-"(name unresolved, see the stack template)"}
		echo "::warning::retained $k of $(name "$stack"); DynamoDB table $table may still exist, and no sweep deletes it"
		echo "- retained: $k ($table_type) in $(name "$stack"); delete DynamoDB table $table by hand if it still exists" >>"$report"
	done
}

# The tables retained on earlier runs: a table resource in DELETE_SKIPPED in a
# deleted nested stack of a sandbox. Only stacks that lived at least 5 hours
# are read. The retain only runs on a sandbox created more than 6 hours
# earlier (the step's STUCK_CUTOFF), and an ordinary teardown deletes its
# nested stacks within the hour, so this skips almost every deleted stack.
leftovers() {
	local listed candidates id stack when rows names logical table
	local ids=()
	if ! listed=$(aws cloudformation list-stacks --stack-status-filter DELETE_COMPLETE --output json </dev/null) ||
		! candidates=$(jq -r '
			def ts: .[0:19] + "Z" | fromdateiso8601;
			.StackSummaries[]
			| select(.ParentId != null and (.StackName | test("^amplify-amplify(gen2|interoptest)-")))
			| select(.DeletionTime != null and ((.DeletionTime | ts) - (.CreationTime | ts)) >= 5 * 3600)
			| [.StackId, .StackName, .DeletionTime[0:10]] | @tsv' <<<"$listed"); then
		echo "::warning::could not list deleted stacks, so tables retained on earlier runs are not reported this run"
		return 0
	fi
	while IFS=$'\t' read -r id stack when; do
		[ -z "$id" ] && continue
		if ! rows=$(aws cloudformation list-stack-resources --stack-name "$id" --output json </dev/null |
			jq -r --arg type "$table_type" '.StackResourceSummaries[]
				| select(.ResourceType == $type and .ResourceStatus == "DELETE_SKIPPED") | .LogicalResourceId'); then
			echo "::warning::could not list the resources of deleted stack $stack; its retained tables are not reported this run"
			continue
		fi
		[ -z "$rows" ] && continue
		mapfile -t ids <<<"$rows"
		names=$(table_names "$id" "${ids[@]}")
		for logical in "${ids[@]}"; do
			table=$(awk -F'\t' -v id="$logical" '$1 == id { print $2; exit }' <<<"$names")
			table=${table:-"(name unresolved, see the stack template)"}
			echo "::warning::$stack retained $logical when it was deleted on $when; DynamoDB table $table may still exist, and no sweep deletes it"
			echo "- leftover: $logical ($table_type) of $stack, deleted $when; delete DynamoDB table $table by hand if it still exists" >>"$report"
		done
	done <<<"$candidates"
}

if [ "$root" = '--leftovers' ]; then
	leftovers
	exit 0
fi
walk "$root"
[ "$started" -eq 1 ] && exit 3
exit 0
