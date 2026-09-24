#!/usr/bin/env bash
# Post the bench report as a SINGLE sticky PR comment: find a prior comment carrying our marker and
# edit it in place, else create one. Keyed by a hidden HTML marker so re-runs update one comment
# instead of spamming the thread. Best-effort — the caller runs it continue-on-error, so a comment
# failure never reds the bench (the report is also in the Actions run summary).
#
# Env: GH_TOKEN (repo token w/ pull-requests:write), REPO (owner/name), PR (number), BODY_FILE (path
# to the rendered markdown). Requires `gh` (present on GitHub-hosted runners).
set -euo pipefail

MARKER='<!-- agent-bench-report -->'

: "${REPO:?REPO required}"
: "${PR:?PR required}"
: "${BODY_FILE:?BODY_FILE required}"

if [ ! -s "$BODY_FILE" ]; then
	echo "pr-comment: body file '$BODY_FILE' missing or empty — nothing to post" >&2
	exit 0
fi

# Prepend the marker so the next run can find this comment. A temp file keeps the body intact.
TMP="$(mktemp)"
trap 'rm -f "$TMP" "${TMP}.json"' EXIT
printf '%s\n\n' "$MARKER" > "$TMP"
cat "$BODY_FILE" >> "$TMP"

# Find existing marker comments.
# Fetch the comment list, capturing the gh api exit SEPARATELY from the jq filter. A transient 5xx or
# a token-permission problem must not look like an empty list — if it did, EXISTING_ID would be empty
# and we'd fall into the create branch and post a DUPLICATE sticky comment. So on an API failure we
# log and skip commenting this run (the report is still in the Actions summary; the next successful
# run reconciles). A genuinely empty list still proceeds to create.
# `set +e` around the call: under `set -e` a non-zero gh api would abort the script at the assignment
# before we could read $?, so disable errexit just for it, capture the code, then restore.
set +e
COMMENTS_JSON="$(gh api "repos/${REPO}/issues/${PR}/comments" --paginate 2>/dev/null)"
API_RC=$?
set -e
if [ "$API_RC" -ne 0 ]; then
	echo "pr-comment: gh api list failed (rc=${API_RC}) — skipping comment this run to avoid a duplicate; the report is in the Actions summary" >&2
	exit 0
fi
# Match the marker ANYWHERE in the body (contains, not startswith): we prepend it, but `contains`
# survives GitHub normalizing a leading newline or future content before the marker. Null-safe:
# `(.body // "")` so a null/absent body can't abort the filter. Keep only numeric ids and SORT them
# numerically (`sort -n`): a GitHub comment id increases monotonically with creation, so the lowest id
# is the oldest comment — sorting makes "keep the oldest, delete the newer" deterministic rather than
# relying on the API's (documented but unpinned) ascending-creation-order default.
MARKER_IDS="$(printf '%s' "$COMMENTS_JSON" | jq -r --arg m "$MARKER" 'map(select((.body // "") | contains($m))) | .[].id' 2>/dev/null | grep -E '^[0-9]+$' | sort -n || true)"
# `head -1` on the sorted list = lowest id = oldest comment (the keeper). grep/sort exiting non-zero
# on an empty list would fail the substitution under `set -o pipefail`, so the `|| true` is
# load-bearing; ${DUP_COUNT:-0} below also defends an empty capture. Do NOT drop the `|| true`.
EXISTING_ID="$(printf '%s\n' "$MARKER_IDS" | head -1 || true)"
DUP_COUNT="$(printf '%s\n' "$MARKER_IDS" | grep -cE '^[0-9]+$' || true)"

if [ -n "${EXISTING_ID}" ]; then
	echo "pr-comment: updating existing comment ${EXISTING_ID}" >&2
	# REST PATCH avoids gh's GraphQL comment path; --input reads the JSON body from a file.
	jq -n --rawfile b "$TMP" '{body: $b}' > "${TMP}.json"
	gh api "repos/${REPO}/issues/comments/${EXISTING_ID}" -X PATCH --input "${TMP}.json" >/dev/null
	# Self-heal: if a race or prior bug left more than one marker comment, delete the extras (every id
	# after the oldest in the numerically-sorted list) so the sticky-comment invariant is restored.
	if [ "${DUP_COUNT:-0}" -gt 1 ]; then
		echo "pr-comment: ${DUP_COUNT} marker comments found — deleting $((DUP_COUNT - 1)) duplicate(s), keeping ${EXISTING_ID}" >&2
		printf '%s\n' "$MARKER_IDS" | tail -n +2 | while read -r dup_id; do
			gh api "repos/${REPO}/issues/comments/${dup_id}" -X DELETE >/dev/null 2>&1 \
				&& echo "pr-comment: deleted duplicate ${dup_id}" >&2 \
				|| echo "pr-comment: could not delete duplicate ${dup_id} (left for a human)" >&2
		done
	fi
else
	echo "pr-comment: creating new comment" >&2
	jq -n --rawfile b "$TMP" '{body: $b}' > "${TMP}.json"
	gh api "repos/${REPO}/issues/${PR}/comments" -X POST --input "${TMP}.json" >/dev/null
fi
echo "pr-comment: done" >&2
