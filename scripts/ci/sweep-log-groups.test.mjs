// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// Unit tests for the log-group sweep step of .github/workflows/cleanup-stacks.yml,
// run against a stub `aws` on PATH (nothing reaches AWS), plus a check that the
// CI role in test-infra/github-oidc-stack.ts may delete exactly the log groups
// the step targets.
//
// Run: node --test scripts/ci/sweep-log-groups.test.mjs

import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const WORKFLOW = readFileSync(fileURLToPath(new URL('../../.github/workflows/cleanup-stacks.yml', import.meta.url)), 'utf8');
const STEP = 'Cleanup orphaned Lambda and RDS log groups';
const OIDC_STACK = readFileSync(fileURLToPath(new URL('../../test-infra/github-oidc-stack.ts', import.meta.url)), 'utf8');

// What AWS CLI v2 writes to stderr for a rejected call: a blank line, then the
// message. The account id must not reach the (public) log.
const DENIED =
	'\nAn error occurred (AccessDeniedException) when calling the ListFunctions operation: ' +
	'User: arn:aws:sts::123456789012:assumed-role/ci/run is not authorized to perform: lambda:ListFunctions\n';

// A stub `aws` that serves canned output from its fixture dir and logs every call.
//   logs describe-log-groups --log-group-name-prefix P -> lines of log-groups.tsv starting with P
//                                                          (every line when no-filter is present)
//   lambda list-functions                               -> functions.txt (after sleeping
//                                                          list-delay's seconds, if present)
//   rds describe-db-clusters                            -> clusters.txt
//   <service>.err present                               -> its text on stderr, exit 254
//   logs delete-log-group --log-group-name N            -> appends N to deleted.txt, or fails
//                                                          with delete-error.txt's text when N is
//                                                          listed in delete-fails.txt
const STUB = `#!/usr/bin/env bash
d=$STUB_DIR
echo "$*" >> "$d/calls.txt"
if [ -f "$d/$1.err" ]; then cat "$d/$1.err" >&2; exit 254; fi
arg() { local want=$1; shift; while [ $# -gt 0 ]; do [ "$1" = "$want" ] && { echo "$2"; return; }; shift; done; }
case "$1 $2" in
'logs describe-log-groups')
	p=$(arg --log-group-name-prefix "$@")
	[ -f "$d/no-filter" ] && p=''
	while IFS= read -r line || [ -n "$line" ]; do case "$line" in "$p"*) printf '%s\\n' "$line" ;; esac; done < "$d/log-groups.tsv" ;;
'lambda list-functions')
	[ -f "$d/list-delay" ] && sleep "$(cat "$d/list-delay")"
	cat "$d/functions.txt" 2>/dev/null || true ;;
'rds describe-db-clusters') cat "$d/clusters.txt" 2>/dev/null || true ;;
'logs delete-log-group')
	n=$(arg --log-group-name "$@")
	if grep -qxF -- "$n" "$d/delete-fails.txt" 2>/dev/null; then
		cat "$d/delete-error.txt" >&2 2>/dev/null || printf '\\nAn error occurred (ThrottlingException) when calling the DeleteLogGroup operation: Rate exceeded\\n' >&2
		exit 254
	fi
	echo "$n" >> "$d/deleted.txt" ;;
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
/** A log-groups.tsv line: name and creation time `hoursAgo` hours back (epoch ms). */
const group = (name, hoursAgo) => `${name}\t${now - hoursAgo * HOUR}`;

/** A fixture dir holding the stub `aws` plus `files`. */
function fixture(files = {}) {
	const dir = mkdtempSync(join(tmpdir(), 'sweep-log-groups-'));
	dirs.push(dir);
	const bin = join(dir, 'bin');
	mkdirSync(bin);
	writeFileSync(join(bin, 'aws'), STUB);
	chmodSync(join(bin, 'aws'), 0o755);
	for (const [name, content] of Object.entries({ 'log-groups.tsv': '', ...files })) {
		writeFileSync(join(dir, name), content);
	}
	return dir;
}

function run(dir, env = {}) {
	const file = join(dir, 'step.sh');
	writeFileSync(file, step().script);
	const r = spawnSync('bash', [file], {
		cwd: ROOT,
		encoding: 'utf8',
		env: { ...process.env, ...env, PATH: `${join(dir, 'bin')}:${process.env.PATH}`, STUB_DIR: dir, GITHUB_STEP_SUMMARY: join(dir, 'summary.md') },
	});
	const read = (f) => (existsSync(join(dir, f)) ? readFileSync(join(dir, f), 'utf8') : '');
	const deleted = read('deleted.txt').split('\n').filter(Boolean).sort();
	return { status: r.status, stdout: r.stdout, stderr: r.stderr, summary: read('summary.md'), deleted, calls: read('calls.txt') };
}

describe('log-group sweep step', () => {
	it('deletes a test Lambda log group past the age gate whose function is gone', () => {
		const dir = fixture({
			'log-groups.tsv': [
				group('/aws/lambda/blocks-hosting-spa-runner-CustomCDKBucketDeploymen-3bOuJo9tyZrM', 30),
				group('/aws/lambda/bb-test-prod-pr-1-run-BlocksGsiProviderframeworkon-Ab12Cd34Ef56', 25),
				group('/aws/lambda/amplify-amplifyinteroptes-CustomS3AutoDeleteObject-VM3hLVdOWzZG', 72),
			].join('\n'),
		});
		const r = run(dir);
		assert.equal(r.status, 0, r.stderr + r.stdout);
		assert.deepEqual(r.deleted, [
			'/aws/lambda/amplify-amplifyinteroptes-CustomS3AutoDeleteObject-VM3hLVdOWzZG',
			'/aws/lambda/bb-test-prod-pr-1-run-BlocksGsiProviderframeworkon-Ab12Cd34Ef56',
			'/aws/lambda/blocks-hosting-spa-runner-CustomCDKBucketDeploymen-3bOuJo9tyZrM',
		]);
		assert.match(r.summary, /Orphaned log groups deleted: 3/);
	});

	it('keeps a log group whose function still exists', () => {
		const dir = fixture({
			'log-groups.tsv': group('/aws/lambda/bb-test-abc-DefaultComputeHandler-Xy12', 30),
			'functions.txt': 'bb-test-abc-DefaultComputeHandler-Xy12\n',
		});
		const r = run(dir);
		assert.equal(r.status, 0, r.stderr);
		assert.deepEqual(r.deleted, []);
		assert.match(r.summary, /Skipped \(owner still exists\): 1/);
	});

	it('keeps a log group younger than the age gate', () => {
		const dir = fixture({
			'log-groups.tsv': [
				group('/aws/lambda/bb-test-abc-Fn-Xy12', 23),
				'/aws/lambda/bb-test-abc-Fn-NoTime\tNone',
				'/aws/lambda/bb-test-abc-Fn-BadTime\tyesterday',
				'None',
			].join('\n'),
		});
		const r = run(dir);
		assert.equal(r.status, 0, r.stderr);
		assert.deepEqual(r.deleted, []);
		assert.match(r.summary, /Skipped \(< 24h old\): 3/);
	});

	it('re-checks the test prefix itself, not only the listing filter', () => {
		const dir = fixture({
			'no-filter': '',
			'log-groups.tsv': [
				group('/aws/lambda/customer-fn', 30),
				group('/aws/lambda/customer-bb-test-fn', 30),
				group('/aws/lambda/my-app-Fn-Xy12', 30),
				group('/aws/rds/cluster/prod-db/postgresql', 30),
				group('/aws/rds/cluster/prod-bb-test-db/postgresql', 30),
				group('/aws/lambda/bb-test-a-Fn-1', 30),
			].join('\n'),
		});
		const r = run(dir);
		assert.equal(r.status, 0, r.stderr);
		assert.deepEqual(r.deleted, ['/aws/lambda/bb-test-a-Fn-1']);
	});

	it('never lists or deletes a log group outside the test prefixes', () => {
		const dir = fixture({
			'log-groups.tsv': [
				group('/aws/lambda/my-app-CustomCDKBucketDeploymen-3bOuJo9tyZrM', 30),
				group('/aws/lambda/customer-fn', 30),
				group('/aws/rds/cluster/prod-db/postgresql', 30),
				group('/aws/bedrock-agentcore/runtimes/bbtestprodrun-DEFAULT', 30),
				group('bb-test-abc-HostingWebComputedefaultLogGroup-Xy12', 30),
			].join('\n'),
		});
		const r = run(dir);
		assert.equal(r.status, 0, r.stderr);
		assert.deepEqual(r.deleted, []);
		for (const prefix of r.calls.match(/--log-group-name-prefix \S+/g) ?? []) {
			assert.match(prefix, /^--log-group-name-prefix \/aws\/(lambda|rds\/cluster)\/(bb-|blocks-|amplify-)/);
		}
	});

	it('deletes an RDS engine log group only when its cluster is gone', () => {
		const dir = fixture({
			'log-groups.tsv': [
				group('/aws/rds/cluster/bb-test-runner-zqv0uv-pr-testappdbbbtestrunnerzqv-otzvyki0opg5/postgresql', 30),
				group('/aws/rds/cluster/bb-test-prod-pr-9-1-run-testappdbbbtestprodPR9-AAAA/postgresql', 30),
			].join('\n'),
			// Cluster ids are case-insensitive: a mixed-case id in the group name
			// still matches the lower-case id describe-db-clusters returns.
			'clusters.txt': 'bb-test-prod-pr-9-1-run-testappdbbbtestprodpr9-aaaa\n',
		});
		const r = run(dir);
		assert.equal(r.status, 0, r.stderr);
		assert.deepEqual(r.deleted, ['/aws/rds/cluster/bb-test-runner-zqv0uv-pr-testappdbbbtestrunnerzqv-otzvyki0opg5/postgresql']);
	});

	for (const service of ['lambda', 'rds', 'logs']) {
		it(`deletes nothing and fails when the ${service} listing fails`, () => {
			const dir = fixture({ 'log-groups.tsv': group('/aws/lambda/bb-test-abc-Fn-Xy12', 30), [`${service}.err`]: DENIED });
			const r = run(dir);
			assert.equal(r.status, 1);
			assert.deepEqual(r.deleted, []);
			assert.doesNotMatch(r.calls, /delete-log-group/);
			assert.match(r.stdout, /::error::/);
			assert.doesNotMatch(r.stdout + r.summary, /123456789012/, 'account id is masked');
		});
	}

	it('counts a failed delete and keeps going', () => {
		const dir = fixture({
			'log-groups.tsv': [group('/aws/lambda/bb-test-a-Fn-1', 30), group('/aws/lambda/bb-test-b-Fn-2', 30)].join('\n'),
			'delete-fails.txt': '/aws/lambda/bb-test-a-Fn-1\n',
		});
		const r = run(dir);
		assert.equal(r.status, 0, r.stderr);
		assert.deepEqual(r.deleted, ['/aws/lambda/bb-test-b-Fn-2']);
		assert.match(r.summary, /Failed \(retried next run\): 1/);
		assert.match(r.stdout, /::warning::.*ThrottlingException/);
	});

	it('does not count a group that is already gone as failed', () => {
		const dir = fixture({
			'log-groups.tsv': group('/aws/lambda/bb-test-a-Fn-1', 30),
			'delete-fails.txt': '/aws/lambda/bb-test-a-Fn-1\n',
			'delete-error.txt': '\nAn error occurred (ResourceNotFoundException) when calling the DeleteLogGroup operation: The specified log group does not exist.\n',
		});
		const r = run(dir);
		assert.equal(r.status, 0, r.stderr);
		assert.match(r.summary, /Failed \(retried next run\): 0/);
	});

	it('fails, naming the role, when a delete is denied', () => {
		const dir = fixture({
			'log-groups.tsv': [group('/aws/lambda/bb-test-a-Fn-1', 30), group('/aws/lambda/bb-test-b-Fn-2', 30)].join('\n'),
			'delete-fails.txt': '/aws/lambda/bb-test-a-Fn-1\n',
			'delete-error.txt': DENIED.replace('ListFunctions', 'DeleteLogGroup'),
		});
		const r = run(dir);
		assert.equal(r.status, 1);
		assert.deepEqual(r.deleted, ['/aws/lambda/bb-test-b-Fn-2'], 'the other deletes still run');
		assert.match(r.stdout, /::error::the CI role may not delete/);
		assert.doesNotMatch(r.stdout, /123456789012/);
	});

	it('defers the rest once the time budget is spent', () => {
		const dir = fixture({ 'log-groups.tsv': [group('/aws/lambda/bb-test-a-Fn-1', 30), group('/aws/lambda/bb-test-b-Fn-2', 30)].join('\n') });
		const r = run(dir, { LOG_GROUP_SWEEP_BUDGET_SECONDS: '0' });
		assert.equal(r.status, 0, r.stderr);
		assert.deepEqual(r.deleted, []);
		assert.match(r.summary, /Deferred to next run \(time budget\): 2/);
	});

	it('starts the time budget after the listings, so a slow listing still leaves time to delete', () => {
		// Bash SECONDS counts whole seconds, so a budget of N is N-1 to N seconds: 2 keeps a margin.
		const dir = fixture({ 'log-groups.tsv': group('/aws/lambda/bb-test-a-Fn-1', 30), 'list-delay': '3' });
		const r = run(dir, { LOG_GROUP_SWEEP_BUDGET_SECONDS: '2' });
		assert.equal(r.status, 0, r.stderr);
		assert.deepEqual(r.deleted, ['/aws/lambda/bb-test-a-Fn-1']);
	});

	it('defaults to a 5-minute budget', () => {
		assert.match(step().script, /\$\{LOG_GROUP_SWEEP_BUDGET_SECONDS:-300\}/);
	});
});

describe('wiring', () => {
	const scriptPrefixes = (name) => {
		const m = step().script.match(new RegExp(`^${name}=\\(([^)]*)\\)`, 'm'));
		assert.ok(m, `${name} not found in the step script`);
		return m[1].trim().split(/\s+/).sort();
	};
	const stackPrefixes = (name) => {
		const m = OIDC_STACK.match(new RegExp(`const ${name} = \\[([^\\]]*)\\]`));
		assert.ok(m, `${name} not found in test-infra/github-oidc-stack.ts`);
		return [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]).sort();
	};

	it('the CI role may delete exactly the log groups the script targets', () => {
		assert.deepEqual(stackPrefixes('LOG_GROUP_LAMBDA_PREFIXES'), scriptPrefixes('LAMBDA_PREFIXES'));
		assert.deepEqual(stackPrefixes('LOG_GROUP_RDS_PREFIXES'), scriptPrefixes('RDS_PREFIXES'));
	});

	it('runs on every E2E leg, even after an earlier step failed', () => {
		assert.match(step().header, /if: always\(\) && matrix\.environment == 'e2e'/);
	});
});
