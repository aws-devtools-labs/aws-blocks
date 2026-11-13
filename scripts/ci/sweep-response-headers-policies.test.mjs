// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// Unit tests for the response headers policy sweep step of
// .github/workflows/cleanup-stacks.yml, run against a stub `aws` on PATH
// (nothing reaches AWS). The step must never delete a policy a stack still
// owns: a hosting deploy creates its policy minutes before the distribution
// that uses it, and CloudFront only refuses the delete once that distribution
// exists.
//
// Run: node --test scripts/ci/sweep-response-headers-policies.test.mjs
// The step runs `date -d`, so the tests need GNU date and skip elsewhere.

import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const WORKFLOW = readFileSync(fileURLToPath(new URL('../../.github/workflows/cleanup-stacks.yml', import.meta.url)), 'utf8');
const STEP = 'Cleanup orphaned CloudFront Response Headers Policies';

// Every StackStatus of the CloudFormation API.
const STACK_STATUSES = [
	'CREATE_IN_PROGRESS',
	'CREATE_FAILED',
	'CREATE_COMPLETE',
	'ROLLBACK_IN_PROGRESS',
	'ROLLBACK_FAILED',
	'ROLLBACK_COMPLETE',
	'DELETE_IN_PROGRESS',
	'DELETE_FAILED',
	'DELETE_COMPLETE',
	'UPDATE_IN_PROGRESS',
	'UPDATE_COMPLETE_CLEANUP_IN_PROGRESS',
	'UPDATE_COMPLETE',
	'UPDATE_FAILED',
	'UPDATE_ROLLBACK_IN_PROGRESS',
	'UPDATE_ROLLBACK_FAILED',
	'UPDATE_ROLLBACK_COMPLETE_CLEANUP_IN_PROGRESS',
	'UPDATE_ROLLBACK_COMPLETE',
	'REVIEW_IN_PROGRESS',
	'IMPORT_IN_PROGRESS',
	'IMPORT_COMPLETE',
	'IMPORT_ROLLBACK_IN_PROGRESS',
	'IMPORT_ROLLBACK_FAILED',
	'IMPORT_ROLLBACK_COMPLETE',
];

// A stub `aws` that serves canned output from its fixture dir and logs every call.
//   <service>.<op>.err present             -> its text on stderr, exit 254
//   cloudfront list-response-headers-policies -> policies.tsv (id, last modified, name)
//   ec2 describe-regions                   -> regions.txt
//   cloudformation list-stacks --region R  -> ids of the stacks.tsv lines (region, stack id,
//                                             status) in R whose status is in
//                                             --stack-status-filter; fails with
//                                             list-stacks-R.err's text if present
//   cloudformation list-stack-resources    -> the policy ids resources.tsv (stack id, policy
//                                             id) gives the stack, tab-separated; fails when
//                                             the stack id is in resources-fail.txt, or on
//                                             its first call when in resources-fail-once.txt
//   cloudfront get-response-headers-policy -> ETag E-<id>
//   cloudfront delete-response-headers-policy --id I --if-match E
//                                          -> appends I to deleted.txt (E must be E-<id>);
//                                             fails as in use when I is in in-use.txt, or
//                                             throttled when I is in delete-fails.txt
const STUB = `#!/usr/bin/env bash
d=$STUB_DIR
echo "$*" >> "$d/calls.txt"
key="$1.$2"
if [ -f "$d/$key.err" ]; then cat "$d/$key.err" >&2; exit 254; fi
arg() { local want=$1; shift; while [ $# -gt 0 ]; do [ "$1" = "$want" ] && { echo "$2"; return; }; shift; done; }
listed() { grep -qxF -- "$1" "$d/$2" 2>/dev/null; }
case "$key" in
cloudfront.list-response-headers-policies) cat "$d/policies.tsv" 2>/dev/null || true ;;
ec2.describe-regions) cat "$d/regions.txt" ;;
cloudformation.list-stacks)
	r=$(arg --region "$@")
	if [ -f "$d/list-stacks-$r.err" ]; then cat "$d/list-stacks-$r.err" >&2; exit 254; fi
	statuses=" "; on=0
	for a in "$@"; do
		case "$a" in --stack-status-filter) on=1 ;; --*) on=0 ;; *) [ "$on" -eq 1 ] && statuses="$statuses$a " ;; esac
	done
	ids=()
	while IFS=$'\\t' read -r region id status; do
		[ "$region" = "$r" ] && [[ $statuses == *" $status "* ]] && ids+=("$id")
	done < <(cat "$d/stacks.tsv" 2>/dev/null)
	(IFS=$'\\t'; echo "\${ids[*]}") ;;
cloudformation.list-stack-resources)
	s=$(arg --stack-name "$@")
	if listed "$s" resources-fail.txt; then printf '\\nAn error occurred (Throttling) when calling the ListStackResources operation: Rate exceeded\\n' >&2; exit 254; fi
	if listed "$s" resources-fail-once.txt && ! listed "$s" resources-failed.txt; then
		echo "$s" >> "$d/resources-failed.txt"
		printf '\\nAn error occurred (Throttling) when calling the ListStackResources operation: Rate exceeded\\n' >&2; exit 254
	fi
	ids=()
	while IFS=$'\\t' read -r stack id; do [ "$stack" = "$s" ] && ids+=("$id"); done < <(cat "$d/resources.tsv" 2>/dev/null)
	(IFS=$'\\t'; echo "\${ids[*]}") ;;
cloudfront.get-response-headers-policy) echo "E-$(arg --id "$@")" ;;
cloudfront.delete-response-headers-policy)
	id=$(arg --id "$@")
	if listed "$id" in-use.txt; then
		printf '\\nAn error occurred (ResponseHeadersPolicyInUse) when calling the DeleteResponseHeadersPolicy operation: Cannot delete the response headers policy because it is attached to one or more cache behaviors in a CloudFront distribution.\\n' >&2
		exit 254
	fi
	if listed "$id" delete-fails.txt; then
		printf '\\nAn error occurred (Throttling) when calling the DeleteResponseHeadersPolicy operation: User: arn:aws:sts::123456789012:assumed-role/ci/run: Rate exceeded\\n' >&2
		exit 254
	fi
	[ "$(arg --if-match "$@")" = "E-$id" ] || { echo "stub aws: wrong --if-match: $*" >&2; exit 2; }
	echo "$id" >> "$d/deleted.txt" ;;
*) echo "stub aws: unexpected call: $*" >&2; exit 2 ;;
esac
`;

const dirs = [];
after(() => {
	for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

/** The step's `if:` and its dedented `run:` script. */
function step() {
	const lines = WORKFLOW.split('\n');
	const start = lines.findIndex((l) => l.trim() === `- name: ${STEP}`);
	assert.notEqual(start, -1, `step "${STEP}" not found in cleanup-stacks.yml`);
	const runAt = lines.findIndex((l, i) => i > start && l.trim() === 'run: |');
	const body = [];
	for (const line of lines.slice(runAt + 1)) {
		if (line.trim() !== '' && !line.startsWith(' '.repeat(10))) break;
		body.push(line.slice(10));
	}
	return { header: lines.slice(start, runAt).join('\n'), script: body.join('\n') };
}

const HOUR = 3600_000;
const now = Date.now();
/** A policies.tsv line: id, a last-modified time `hoursAgo` hours back as the CLI prints it, and name. */
const policy = (id, hoursAgo, name = `${id}HostingSecurityHeaders1C1C4C18`) =>
	`${id}\t${new Date(now - hoursAgo * HOUR).toISOString().replace('Z', '+00:00')}\t${name}`;
/** A stack id (ARN) in `region`. */
const stackId = (name, region = 'us-east-1') =>
	`arn:aws:cloudformation:${region}:123456789012:stack/${name}/0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0`;
const lines = (...rows) => `${rows.join('\n')}\n`;

/** A fixture dir holding the stub `aws` (and a no-op `sleep`) plus `files`. */
function fixture(files = {}) {
	const dir = mkdtempSync(join(tmpdir(), 'sweep-response-headers-policies-'));
	dirs.push(dir);
	const bin = join(dir, 'bin');
	mkdirSync(bin);
	writeFileSync(join(bin, 'aws'), STUB);
	writeFileSync(join(bin, 'sleep'), '#!/usr/bin/env bash\n');
	chmodSync(join(bin, 'aws'), 0o755);
	chmodSync(join(bin, 'sleep'), 0o755);
	for (const [name, content] of Object.entries({ 'regions.txt': 'us-east-1\tus-west-2\n', ...files })) {
		writeFileSync(join(dir, name), content);
	}
	return dir;
}

function run(dir) {
	const file = join(dir, 'step.sh');
	writeFileSync(file, step().script);
	const r = spawnSync('bash', [file], {
		cwd: ROOT,
		encoding: 'utf8',
		env: { ...process.env, PATH: `${join(dir, 'bin')}:${process.env.PATH}`, STUB_DIR: dir, GITHUB_STEP_SUMMARY: join(dir, 'summary.md') },
	});
	const read = (f) => (existsSync(join(dir, f)) ? readFileSync(join(dir, f), 'utf8') : '');
	const deleted = read('deleted.txt').split('\n').filter(Boolean).sort();
	return { status: r.status, stdout: r.stdout, stderr: r.stderr, summary: read('summary.md'), deleted, calls: read('calls.txt') };
}

const GNU_DATE = spawnSync('date', ['-d', '@0', '+%s'], { encoding: 'utf8' }).stdout?.trim() === '0';

describe('response headers policy sweep step', { skip: !GNU_DATE && 'needs GNU date' }, () => {
	it('keeps the policies of a deploy whose distribution is not created yet', () => {
		// The PR #1259 hosting legs: each stack is CREATE_IN_PROGRESS and its policy
		// is two minutes old. One stack already lists its policy's id, the other
		// doesn't yet; neither policy is attached to a distribution, so CloudFront
		// would let both deletes through.
		const nextjs = stackId('blocks-hosting-ssr-runner-akpb2y-pr-1259-nextjs-web-function');
		const nuxt = stackId('blocks-hosting-ssr-nuxt-runner-2nci9k-pr-1259-nuxt-web-function');
		const dir = fixture({
			'policies.tsv': lines(policy('028d12d7', 2 / 60), policy('2d61d0b9', 2 / 60)),
			'stacks.tsv': lines(`us-east-1\t${nextjs}\tCREATE_IN_PROGRESS`, `us-east-1\t${nuxt}\tCREATE_IN_PROGRESS`),
			'resources.tsv': lines(`${nextjs}\t028d12d7`),
		});
		const r = run(dir);
		assert.equal(r.status, 0, r.stderr + r.stdout);
		assert.deepEqual(r.deleted, []);
		assert.match(r.summary, /^- Skipped \(< 6h since last change\): 2$/m);
		assert.match(r.summary, /^- Orphaned policies deleted: 0$/m);
	});

	it('keeps an old policy a stack owns, in any region and any status but DELETE_COMPLETE', () => {
		const statuses = STACK_STATUSES.filter((s) => s !== 'DELETE_COMPLETE');
		const stacks = statuses.map((s, i) => [stackId(`bb-test-${i}`, i % 2 ? 'us-west-2' : 'us-east-1'), s]);
		const dir = fixture({
			'policies.tsv': lines(...statuses.map((_, i) => policy(`p${i}`, 30))),
			'stacks.tsv': lines(...stacks.map(([id, s]) => `${id.split(':')[3]}\t${id}\t${s}`)),
			'resources.tsv': lines(...stacks.map(([id], i) => `${id}\tp${i}`)),
		});
		const r = run(dir);
		assert.equal(r.status, 0, r.stderr + r.stdout);
		assert.deepEqual(r.deleted, []);
		assert.match(r.summary, new RegExp(`^- Skipped \\(owned by a stack\\): ${statuses.length}$`, 'm'));
	});

	it('lists the stacks in every status but DELETE_COMPLETE', () => {
		const dir = fixture({ 'policies.tsv': lines(policy('p1', 30)) });
		const r = run(dir);
		assert.equal(r.status, 0, r.stderr + r.stdout);
		const listStacks = r.calls.split('\n').filter((c) => c.startsWith('cloudformation list-stacks'));
		assert.equal(listStacks.length, 2, 'one listing per region');
		for (const call of listStacks) {
			const filter = call.split('--stack-status-filter ')[1].split(' --')[0].split(' ').sort();
			assert.deepEqual(filter, STACK_STATUSES.filter((s) => s !== 'DELETE_COMPLETE').sort());
		}
	});

	it('deletes an old policy no stack owns, and one whose stack is DELETE_COMPLETE', () => {
		const gone = stackId('blocks-hosting-spa-runner-5rh515-pr-1157-spa');
		const dir = fixture({
			'policies.tsv': lines(policy('orphan1', 30), policy('orphan2', 7)),
			'stacks.tsv': lines(`us-east-1\t${gone}\tDELETE_COMPLETE`),
			'resources.tsv': lines(`${gone}\torphan2`),
		});
		const r = run(dir);
		assert.equal(r.status, 0, r.stderr + r.stdout);
		assert.deepEqual(r.deleted, ['orphan1', 'orphan2']);
		assert.match(r.stdout, /^🗑️ Deleted orphaned policy: orphan1HostingSecurityHeaders1C1C4C18 \(orphan1\)$/m);
		assert.match(r.summary, /^- Orphaned policies deleted: 2$/m);
		assert.doesNotMatch(r.stdout, /::(warning|error)::/);
	});

	it('skips an old policy a distribution still uses', () => {
		const dir = fixture({ 'policies.tsv': lines(policy('attached', 30)), 'in-use.txt': 'attached\n' });
		const r = run(dir);
		assert.equal(r.status, 0, r.stderr + r.stdout);
		assert.deepEqual(r.deleted, []);
		assert.match(r.summary, /^- Skipped \(in use by a distribution\): 1$/m);
		assert.match(r.summary, /^- Failed \(will retry next run\): 0$/m);
	});

	it('reports a delete that fails for another reason, with the account id masked', () => {
		const dir = fixture({ 'policies.tsv': lines(policy('throttled', 30)), 'delete-fails.txt': 'throttled\n' });
		const r = run(dir);
		assert.equal(r.status, 0, r.stderr + r.stdout);
		assert.match(r.stdout, /Failed to delete .* \(throttled\), will retry next run: An error occurred \(Throttling\)/);
		assert.match(r.summary, /^- Failed \(will retry next run\): 1$/m);
		assert.doesNotMatch(r.stdout, /123456789012/);
	});

	it('retries a stack resource listing that fails once', () => {
		const flaky = stackId('bb-test-flaky');
		const dir = fixture({
			'policies.tsv': lines(policy('orphan', 30), policy('owned', 30)),
			'stacks.tsv': lines(`us-east-1\t${flaky}\tUPDATE_COMPLETE`),
			'resources.tsv': lines(`${flaky}\towned`),
			'resources-fail-once.txt': `${flaky}\n`,
		});
		const r = run(dir);
		assert.equal(r.status, 0, r.stderr + r.stdout);
		assert.deepEqual(r.deleted, ['orphan']);
		assert.match(r.summary, /^- Skipped \(owned by a stack\): 1$/m);
	});

	it('deletes nothing when a stack resource listing keeps failing', () => {
		const owner = stackId('bb-test-owner');
		const broken = stackId('bb-test-broken', 'us-west-2');
		const dir = fixture({
			'policies.tsv': lines(policy('orphan', 30), policy('owned', 30)),
			'stacks.tsv': lines(`us-east-1\t${owner}\tCREATE_COMPLETE`, `us-west-2\t${broken}\tCREATE_IN_PROGRESS`),
			'resources.tsv': lines(`${owner}\towned`),
			'resources-fail.txt': `${broken}\n`,
		});
		const r = run(dir);
		assert.equal(r.status, 0, r.stderr + r.stdout);
		assert.deepEqual(r.deleted, []);
		assert.match(r.stdout, /list-stack-resources failed for bb-test-broken in us-west-2, .*: An error occurred \(Throttling\)/);
		assert.equal(r.calls.split('\n').filter((c) => c.includes(`list-stack-resources --region us-west-2 --stack-name ${broken}`)).length, 3);
		assert.match(r.summary, /^- Skipped \(owned by a stack\): 1$/m);
		assert.match(r.summary, /^- Deferred to next run \(incomplete ownership set\): 1$/m);
		assert.match(r.stdout, /^::warning::Response headers policy sweep deferred 1 candidate\(s\)/m);
		assert.doesNotMatch(r.stdout, /123456789012/);
	});

	it("deletes nothing when a region's stacks cannot be listed", () => {
		const dir = fixture({
			'policies.tsv': lines(policy('orphan', 30)),
			'list-stacks-us-west-2.err': '\nAn error occurred (AccessDenied) when calling the ListStacks operation: denied\n',
		});
		const r = run(dir);
		assert.equal(r.status, 0, r.stderr + r.stdout);
		assert.deepEqual(r.deleted, []);
		assert.match(r.stdout, /list-stacks failed in us-west-2, .*: An error occurred \(AccessDenied\)/);
		assert.match(r.summary, /^- Deferred to next run \(incomplete ownership set\): 1$/m);
	});

	it('deletes nothing when the regions cannot be listed', () => {
		const dir = fixture({
			'policies.tsv': lines(policy('orphan', 30)),
			'ec2.describe-regions.err': '\nAn error occurred (UnauthorizedOperation) when calling the DescribeRegions operation: denied\n',
		});
		const r = run(dir);
		assert.equal(r.status, 0, r.stderr + r.stdout);
		assert.deepEqual(r.deleted, []);
		assert.match(r.stdout, /^::warning::ec2 describe-regions failed, .*: An error occurred \(UnauthorizedOperation\)/m);
		assert.match(r.summary, /^- Deferred to next run \(incomplete ownership set\): 1$/m);
	});

	it('counts a last-modified time that does not parse as young', () => {
		const dir = fixture({ 'policies.tsv': lines('p1\tNone\tName1', 'p2\tyesterday-ish\tName2') });
		const r = run(dir);
		assert.equal(r.status, 0, r.stderr + r.stdout);
		assert.deepEqual(r.deleted, []);
		assert.match(r.summary, /^- Skipped \(< 6h since last change\): 2$/m);
	});

	it('reads no stacks when no policy is past the age gate', () => {
		const dir = fixture({ 'policies.tsv': lines(policy('young', 5)) });
		const r = run(dir);
		assert.equal(r.status, 0, r.stderr + r.stdout);
		assert.doesNotMatch(r.calls, /^(ec2|cloudformation) /m);
		assert.match(r.summary, /^- Skipped \(< 6h since last change\): 1$/m);
	});

	it('says none were found when the account lists no custom policy', () => {
		const dir = fixture({ 'policies.tsv': 'None\n' });
		const r = run(dir);
		assert.equal(r.status, 0, r.stderr + r.stdout);
		assert.match(r.stdout, /No custom Response Headers Policies found/);
		assert.deepEqual(r.deleted, []);
	});
});

describe('wiring', () => {
	it('runs on every leg, even after an earlier step failed', () => {
		assert.match(step().header, /if: always\(\)$/m);
	});
});
