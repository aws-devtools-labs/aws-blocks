// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// Unit tests for how the steps of .github/workflows/cleanup-stacks.yml report a
// listing they can't read: an IAM role listing fails the leg, and a stack or
// CloudFront listing is a warning with the CLI's reason. Neither may read as
// "nothing to sweep". The REST API step has its own tests in
// rest-api-quota.test.mjs. Every step runs against a stub `aws` on PATH;
// nothing reaches AWS.
//
// Run: node --test scripts/ci/cleanup-listings.test.mjs
// The steps run `date -d`, so the tests need GNU date and skip elsewhere.

import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const WORKFLOW = fileURLToPath(new URL('../../.github/workflows/cleanup-stacks.yml', import.meta.url));

const denied = (op) =>
	`\nAn error occurred (AccessDenied) when calling the ${op} operation: ` +
	`User: arn:aws:sts::123456789012:assumed-role/ci/run is not authorized to perform this action\n`;

// A stub `aws` that logs every call. For `aws <service> <op> ...`:
//   <service>.<op>.err present -> its text on stderr, exit 254
//   <service>.<op>.out present -> its text on stdout
//   otherwise                  -> no output (a JMESPath length() query prints 0)
// delete-* and detach-* calls are also logged to writes.txt.
const STUB = `#!/usr/bin/env bash
d=$STUB_DIR
echo "$*" >> "$d/calls.txt"
key="$1.$2"
case "$2" in delete-* | detach-*) echo "$*" >> "$d/writes.txt" ;; esac
if [ -f "$d/$key.err" ]; then cat "$d/$key.err" >&2; exit 254; fi
if [ -f "$d/$key.out" ]; then cat "$d/$key.out"; exit 0; fi
case " $* " in *'length('*) echo 0 ;; esac
exit 0
`;

const dirs = [];
after(() => {
	for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

/** A fixture dir holding the stub `aws` (and a no-op `sleep`) plus `files`. */
function fixture(files = {}) {
	const dir = mkdtempSync(join(tmpdir(), 'cleanup-listings-'));
	dirs.push(dir);
	const bin = join(dir, 'bin');
	mkdirSync(bin);
	writeFileSync(join(bin, 'aws'), STUB);
	writeFileSync(join(bin, 'sleep'), '#!/usr/bin/env bash\n');
	chmodSync(join(bin, 'aws'), 0o755);
	chmodSync(join(bin, 'sleep'), 0o755);
	for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
	return dir;
}

/** The `run:` script of the named step, dedented. */
function stepScript(name) {
	const lines = readFileSync(WORKFLOW, 'utf8').split('\n');
	const start = lines.findIndex((l) => l.trim() === `- name: ${name}`);
	assert.notEqual(start, -1, `step "${name}" not found in cleanup-stacks.yml`);
	const runAt = lines.findIndex((l, i) => i > start && l.trim() === 'run: |');
	const body = [];
	for (const line of lines.slice(runAt + 1)) {
		if (line.trim() !== '' && !line.startsWith(' '.repeat(10))) break;
		body.push(line.slice(10));
	}
	return body.join('\n');
}

function runStep(name, files) {
	const dir = fixture(files);
	const file = join(dir, 'step.sh');
	writeFileSync(file, stepScript(name));
	const r = spawnSync('bash', [file], {
		cwd: ROOT,
		encoding: 'utf8',
		env: {
			...process.env,
			PATH: `${join(dir, 'bin')}:${process.env.PATH}`,
			STUB_DIR: dir,
			GITHUB_STEP_SUMMARY: join(dir, 'summary.md'),
		},
	});
	const read = (f) => (existsSync(join(dir, f)) ? readFileSync(join(dir, f), 'utf8') : '');
	return { status: r.status, stdout: r.stdout, stderr: r.stderr, summary: read('summary.md'), writes: read('writes.txt') };
}

const GNU_DATE = spawnSync('date', ['-d', '@0', '+%s'], { encoding: 'utf8' }).stdout?.trim() === '0';
const NO_ACCOUNT = /123456789012/;

describe('cleanup-stacks.yml listing failures', { skip: !GNU_DATE && 'needs GNU date' }, () => {
	const IAM = 'Cleanup orphaned API Gateway CloudWatch IAM roles';
	// Two roles, neither a sweep candidate (no test-app prefix).
	const roles = JSON.stringify({
		Roles: ['ci-role', 'other-role'].map((RoleName) => ({
			RoleName,
			CreateDate: '2020-01-01T00:00:00Z',
			AssumeRolePolicyDocument: { Statement: [{ Principal: { Service: 'lambda.amazonaws.com' } }] },
		})),
	});
	const iamOk = { 'ec2.describe-regions.out': 'us-east-1\n', 'apigateway.get-account.out': 'None\n', 'iam.list-roles.out': roles };

	it('IAM step: counts the roles and passes when every listing works', () => {
		const r = runStep(IAM, iamOk);
		assert.equal(r.status, 0, r.stdout + r.stderr);
		assert.match(r.summary, /^- IAM roles in account: 2 \(quota 3000\)$/m);
		assert.doesNotMatch(r.stdout, /::(warning|error)::/);
	});

	it('IAM step: fails the leg, with the CLI error, when the roles cannot be listed', () => {
		const r = runStep(IAM, { ...iamOk, 'iam.list-roles.err': denied('ListRoles') });
		assert.notEqual(r.status, 0, 'the step must fail when iam list-roles fails');
		assert.match(r.stdout, /^::error::iam list-roles failed, .*: An error occurred \(AccessDenied\) when calling the ListRoles/m);
		assert.doesNotMatch(r.stdout + r.summary, NO_ACCOUNT);
		// The summary still prints, and says the count is unknown rather than "?".
		assert.match(r.summary, /^- IAM roles in account: unknown, the listing failed \(quota 3000\)$/m);
		assert.equal(r.writes, '');
	});

	it('IAM step: fails the leg, with the CLI error, when the regions cannot be listed', () => {
		const r = runStep(IAM, { ...iamOk, 'ec2.describe-regions.err': denied('DescribeRegions') });
		assert.notEqual(r.status, 0, 'the step must fail when ec2 describe-regions fails');
		assert.match(r.stdout, /^::error::ec2 describe-regions failed, .*: An error occurred \(AccessDenied\)/m);
		assert.doesNotMatch(r.stdout, NO_ACCOUNT);
		assert.match(r.summary, /^- IAM roles in account: 2 \(quota 3000\)$/m);
		assert.equal(r.writes, '');
	});

	it('IAM step: warns with the reason, and deletes nothing, when one region cannot list its stacks', () => {
		const candidate = JSON.stringify({
			Roles: [
				{
					RoleName: 'bb-test-x-CloudWatchRole',
					CreateDate: '2020-01-01T00:00:00Z',
					AssumeRolePolicyDocument: { Statement: [{ Principal: { Service: 'apigateway.amazonaws.com' } }] },
				},
			],
		});
		const r = runStep(IAM, {
			...iamOk,
			'iam.list-roles.out': candidate,
			'cloudformation.list-stacks.err': denied('ListStacks'),
		});
		assert.equal(r.status, 0, r.stdout + r.stderr);
		assert.match(r.stdout, /^::warning::list-stacks failed in us-east-1, .*: An error occurred \(AccessDenied\)/m);
		assert.match(r.stdout, /^::warning::IAM role sweep deferred 1 candidate/m);
		assert.equal(r.writes, '');
	});

	it('e2e stack step: warns with the reason when the stacks cannot be listed', () => {
		const r = runStep('Find and delete stale e2e stacks', { 'cloudformation.list-stacks.err': denied('ListStacks') });
		assert.equal(r.status, 0, r.stdout + r.stderr);
		assert.match(
			r.stdout,
			/^::warning::list-stacks failed for blocks-test-\* stacks, .*: An error occurred \(AccessDenied\) when calling the ListStacks/m,
		);
		assert.doesNotMatch(r.stdout, NO_ACCOUNT);
		assert.equal(r.writes, '');
	});

	it('Amplify step: warns with the reason when the stacks cannot be listed', () => {
		const r = runStep('Find and delete stale Amplify sandbox stacks', {
			'cloudformation.list-stacks.err': denied('ListStacks'),
		});
		assert.equal(r.status, 0, r.stdout + r.stderr);
		assert.match(r.stdout, /^::warning::list-stacks failed, .*Amplify.*: An error occurred \(AccessDenied\)/m);
		assert.doesNotMatch(r.stdout, NO_ACCOUNT);
		assert.equal(r.writes, '');
	});

	const CF = 'Cleanup orphaned CloudFront Response Headers Policies';

	it('CloudFront step: warns with the reason, not "none found", when the policies cannot be listed', () => {
		const r = runStep(CF, { 'cloudfront.list-response-headers-policies.err': denied('ListResponseHeadersPolicies') });
		assert.equal(r.status, 0, r.stdout + r.stderr);
		assert.match(r.stdout, /^::warning::cloudfront list-response-headers-policies failed, .*: An error occurred \(AccessDenied\)/m);
		assert.doesNotMatch(r.stdout, /No custom Response Headers Policies found/);
		assert.doesNotMatch(r.stdout, NO_ACCOUNT);
	});

	it('CloudFront step: says none were found when the listing is empty', () => {
		const r = runStep(CF, {});
		assert.equal(r.status, 0, r.stdout + r.stderr);
		assert.match(r.stdout, /No custom Response Headers Policies found/);
		assert.doesNotMatch(r.stdout, /::(warning|error)::/);
	});
});

describe('cleanup-stacks.yml legs', () => {
	// The publish leg was dropped: its role can't list REST APIs or IAM roles.
	it('runs one leg per E2E account and none for publish', () => {
		const workflow = readFileSync(WORKFLOW, 'utf8');
		const program = workflow.match(/jq -cn --argjson n "\$ACCOUNTS" \\\n\s*'([^']+)'/)?.[1];
		assert.ok(program, 'the legs matrix expression was not found');
		const r = spawnSync('jq', ['-cn', '--argjson', 'n', '2', program], { encoding: 'utf8' });
		assert.equal(r.status, 0, r.stderr);
		assert.deepEqual(JSON.parse(r.stdout), [
			{ name: 'e2e account 1', environment: 'e2e', index: 0 },
			{ name: 'e2e account 2', environment: 'e2e', index: 1 },
		]);
		assert.doesNotMatch(workflow, /environment == 'publish'|secrets\.AWS_ROLE_ARN\b/);
	});
});
