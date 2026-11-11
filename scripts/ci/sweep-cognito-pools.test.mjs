// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// Unit tests for scripts/ci/sweep-cognito-pools.mjs, run against a fake `aws`
// CLI, plus a check that cleanup-stacks.yml runs it on every leg.
//
// Run: node --test scripts/ci/sweep-cognito-pools.test.mjs

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { accountsOf, isMissingStackError, taggedForCi } from './sweep-cognito-pools.mjs';

const SCRIPT = fileURLToPath(new URL('./sweep-cognito-pools.mjs', import.meta.url));
const WORKFLOW = fileURLToPath(new URL('../../.github/workflows/cleanup-stacks.yml', import.meta.url));
const ACCOUNT = '111111111111';
const ROLE_ARNS = JSON.stringify([`arn:aws:iam::${ACCOUNT}:role/e2e`, 'arn:aws:iam::222222222222:role/e2e']);
const OLD = new Date(Date.now() - 24 * 3600_000).toISOString();
const NEW = new Date(Date.now() - 30 * 60_000).toISOString();

// A stand-in for the AWS CLI, serving sts / cognito-idp / cloudformation from
// a JSON state file and logging each call.
const FAKE_AWS = `#!/usr/bin/env node
const fs = require('node:fs');
const statePath = process.env.FAKE_AWS_STATE;
const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_AWS_LOG, JSON.stringify(args) + '\\n');
const arg = (k) => args[args.indexOf(k) + 1];
const fail = (msg) => { process.stderr.write(msg + '\\n'); process.exit(254); };
const out = (v) => process.stdout.write(JSON.stringify(v));
const pool = () => state.pools.find((p) => p.Id === arg('--user-pool-id') || p.Id === arg('--physical-resource-id'));
switch (args[0] + ' ' + args[1]) {
	case 'sts get-caller-identity':
		out(state.account);
		break;
	case 'cognito-idp list-user-pools': {
		// Pages of state.pageSize (default 60); the token is the next page's start index.
		const size = state.pageSize || 60;
		const start = Number(args.includes('--next-token') ? arg('--next-token') : 0);
		const page = start / size + 1;
		if (state.listError && (!state.listErrorPage || state.listErrorPage === page)) fail(state.listError);
		if (state.listDelayMs) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, state.listDelayMs);
		const pools = state.pools.slice(start, start + size).map(({ Id, Name, CreationDate }) => ({ Id, Name, CreationDate }));
		out({ UserPools: pools, ...(start + size < state.pools.length ? { NextToken: String(start + size) } : {}) });
		break;
	}
	case 'cognito-idp describe-user-pool': {
		const p = pool();
		out({ UserPool: { Id: p.Id, Name: p.Name, UserPoolTags: p.tags || {}, DeletionProtection: p.protection || 'INACTIVE', Domain: p.domain } });
		break;
	}
	case 'cloudformation describe-stack-resources': {
		const p = pool();
		if (p.ownerError) fail(p.ownerError);
		if (p.ownerOutput !== undefined) {
			process.stdout.write(p.ownerOutput);
			break;
		}
		if (!p.stack) fail('An error occurred (ValidationError) when calling the DescribeStackResources operation: Stack for ' + p.Id + ' does not exist');
		out({ StackResources: [{ StackId: p.stack.id, PhysicalResourceId: p.Id }] });
		break;
	}
	case 'cloudformation describe-stacks': {
		const p = state.pools.find((x) => x.stack && x.stack.id === arg('--stack-name'));
		out(p.stack.status);
		break;
	}
	case 'cognito-idp delete-user-pool-domain': {
		const p = pool();
		if (p.domainError) fail(p.domainError);
		p.domain = undefined;
		fs.writeFileSync(statePath, JSON.stringify(state));
		break;
	}
	case 'cognito-idp delete-user-pool': {
		const p = pool();
		if (p.domain) fail('An error occurred (InvalidParameterException): User pool cannot be deleted. It has a domain configured that should be deleted first.');
		state.pools = state.pools.filter((x) => x !== p);
		fs.writeFileSync(statePath, JSON.stringify(state));
		break;
	}
	default:
		fail('unexpected call: ' + args.join(' '));
}
`;

function run({ pools = [], account = ACCOUNT, roleArns = ROLE_ARNS, env: extraEnv = {}, ...extra } = {}) {
	const dir = mkdtempSync(join(tmpdir(), 'cognito-sweep-'));
	const bin = join(dir, 'bin');
	mkdirSync(bin);
	writeFileSync(join(bin, 'aws'), FAKE_AWS);
	chmodSync(join(bin, 'aws'), 0o755);
	const statePath = join(dir, 'state.json');
	const logPath = join(dir, 'calls.log');
	const summaryPath = join(dir, 'summary.md');
	writeFileSync(statePath, JSON.stringify({ pools, account, ...extra }));
	writeFileSync(logPath, '');
	writeFileSync(summaryPath, '');
	const env = {
		...process.env,
		PATH: `${bin}:${process.env.PATH}`,
		FAKE_AWS_STATE: statePath,
		FAKE_AWS_LOG: logPath,
		GITHUB_STEP_SUMMARY: summaryPath,
		...extraEnv,
	};
	if (roleArns === null) delete env.AWS_ROLE_ARNS;
	else env.AWS_ROLE_ARNS = roleArns;
	const r = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8', env });
	const calls = readFileSync(logPath, 'utf8')
		.split('\n')
		.filter(Boolean)
		.map((l) => JSON.parse(l));
	const state = JSON.parse(readFileSync(statePath, 'utf8'));
	return {
		...r,
		out: r.stdout + r.stderr,
		calls,
		left: state.pools.map((p) => p.Name),
		summary: readFileSync(summaryPath, 'utf8'),
	};
}

const deletes = (calls) =>
	calls.filter((c) => c[1] === 'delete-user-pool').map((c) => c[c.indexOf('--user-pool-id') + 1]);
const BLOCKS_TAGS = { 'blocks:purpose': 'e2e-test' };
const AMPLIFY_TAGS = { 'amplify:deployment-type': 'sandbox' };
const blocksPool = (over = {}) => ({
	Id: 'us-east-1_bb1',
	Name: 'bb-test-prod-pr-1327-1-altbgg-test-app-authC',
	CreationDate: OLD,
	tags: BLOCKS_TAGS,
	...over,
});
const amplifyPool = (over = {}) => ({
	Id: 'us-east-1_amp1',
	Name: 'amplifyAuthUserPool4BA7F805-viQ0rPu77agW',
	CreationDate: OLD,
	tags: AMPLIFY_TAGS,
	...over,
});

describe('sweep-cognito-pools.mjs', () => {
	it('deletes old, CI-tagged, test-named pools that no live stack owns', () => {
		const r = run({ pools: [blocksPool(), amplifyPool()] });
		assert.equal(r.status, 0, r.out);
		assert.deepEqual(deletes(r.calls), ['us-east-1_bb1', 'us-east-1_amp1']);
		assert.match(r.summary, /Orphans deleted: 2/);
	});

	it('treats a pool whose owning stack is DELETE_COMPLETE as an orphan', () => {
		const r = run({ pools: [blocksPool({ stack: { id: 'arn:stack/gone', status: 'DELETE_COMPLETE' } })] });
		assert.deepEqual(deletes(r.calls), ['us-east-1_bb1']);
	});

	it('leaves a pool a live stack owns to the stack sweep', () => {
		for (const status of ['CREATE_COMPLETE', 'DELETE_FAILED', 'DELETE_IN_PROGRESS']) {
			const r = run({ pools: [blocksPool({ stack: { id: 'arn:stack/live', status } })] });
			assert.equal(r.status, 0, r.out);
			assert.deepEqual(deletes(r.calls), [], status);
			assert.match(r.summary, /a live stack owns it\): 1/);
		}
	});

	it('never touches a pool younger than the minimum age (an in-flight test)', () => {
		const r = run({ pools: [blocksPool({ CreationDate: NEW }), amplifyPool({ CreationDate: NEW })] });
		assert.deepEqual(deletes(r.calls), []);
		// Not even described: nothing is read about an in-flight test's pool.
		assert.equal(r.calls.filter((c) => c[1] === 'describe-user-pool').length, 0);
	});

	it('ignores pools whose names are not CI-shaped', () => {
		const r = run({
			pools: [
				blocksPool({ Id: 'p1', Name: 'my-app-prod-auth' }),
				blocksPool({ Id: 'p2', Name: 'customer-pool' }),
				amplifyPool({ Id: 'p3', Name: 'amplifyAuthUserPool-short' }),
			],
		});
		assert.deepEqual(deletes(r.calls), []);
		assert.match(r.summary, /User pools listed: 3 \(1 page\)/);
		assert.match(r.summary, /Test-named pools: 0/);
	});

	it('skips a test-named pool without the CI tags', () => {
		const r = run({
			pools: [
				blocksPool({ tags: {} }),
				blocksPool({ Id: 'p2', tags: { 'blocks:purpose': 'extending-guide-validation' } }),
				amplifyPool({ tags: { 'amplify:deployment-type': 'branch' } }),
			],
		});
		assert.deepEqual(deletes(r.calls), []);
		assert.match(r.summary, /not tagged as CI\): 3/);
	});

	it('skips a pool whose owner it cannot read (throttling), never deleting it', () => {
		const r = run({
			pools: [
				blocksPool({
					ownerError:
						'An error occurred (Throttling) when calling the DescribeStackResources operation: Rate exceeded',
				}),
			],
		});
		assert.equal(r.status, 0, r.out);
		assert.deepEqual(deletes(r.calls), []);
		assert.match(r.summary, /unreadable\): 1/);
	});

	it('deletes a pool only on the ValidationError for a missing stack', () => {
		// The fake answers a stackless pool with the real ValidationError shape.
		const r = run({ pools: [blocksPool()] });
		assert.deepEqual(deletes(r.calls), ['us-east-1_bb1']);
	});

	it('skips a pool when the owner lookup fails with any other error, even one saying "does not exist"', () => {
		for (const ownerError of [
			'An error occurred (AccessDenied) when calling the DescribeStackResources operation: User is not authorized; the role does not exist',
			'An error occurred (Throttling) when calling the DescribeStackResources operation: Rate exceeded; resource does not exist yet',
			'Could not connect to the endpoint URL: endpoint does not exist',
			// A ValidationError, but about a different id.
			'An error occurred (ValidationError) when calling the DescribeStackResources operation: Stack for us-east-1_other does not exist',
		]) {
			const r = run({ pools: [blocksPool({ ownerError })] });
			assert.equal(r.status, 0, r.out);
			assert.deepEqual(deletes(r.calls), [], ownerError);
			assert.match(r.summary, /unreadable\): 1/, ownerError);
		}
	});

	const skipsUnnamedOwner = (ownerOutput) => {
		const r = run({ pools: [blocksPool({ ownerOutput })] });
		assert.equal(r.status, 0, r.out);
		assert.deepEqual(deletes(r.calls), []);
		assert.deepEqual(r.left, ['bb-test-prod-pr-1327-1-altbgg-test-app-authC']);
		assert.match(r.out, /describe-stack-resources returned no stack for us-east-1_bb1/);
		assert.match(r.summary, /unreadable\): 1/);
	};

	it('skips a pool when the owner lookup returns no stack resources', () => {
		skipsUnnamedOwner(JSON.stringify({ StackResources: [] }));
	});

	it('skips a pool when the owner lookup output cannot be parsed', () => {
		skipsUnnamedOwner('not json');
	});

	it('flags the summary when the time budget stops the listing after page 1', () => {
		const r = run({
			pools: [blocksPool({ Id: 'us-east-1_page1' }), blocksPool({ Id: 'us-east-1_page2' })],
			pageSize: 1,
			listDelayMs: 1500,
			env: { COGNITO_SWEEP_BUDGET_SECONDS: '1' },
		});
		assert.equal(r.status, 0, r.out);
		assert.equal(r.calls.filter((c) => c[1] === 'list-user-pools').length, 1);
		assert.match(r.summary, /User pools listed: 1 \(1 page, listing truncated by time budget\)/);
	});

	it('reports, and never changes, a pool with deletion protection on', () => {
		const r = run({ pools: [blocksPool({ protection: 'ACTIVE' })] });
		assert.deepEqual(deletes(r.calls), []);
		assert.equal(r.calls.filter((c) => c[1] === 'update-user-pool').length, 0);
		assert.match(r.out, /::warning title=Cognito pool sweep::.*deletion protection on/);
	});

	it('deletes the domain first, and keeps the pool when that fails', () => {
		const ok = run({ pools: [blocksPool({ domain: 'bb-test-x' })] });
		assert.deepEqual(deletes(ok.calls), ['us-east-1_bb1']);
		assert.deepEqual(ok.left, []);
		const bad = run({ pools: [blocksPool({ domain: 'bb-test-x', domainError: 'AccessDenied' })] });
		assert.deepEqual(deletes(bad.calls), []);
		assert.match(bad.out, /::warning title=Cognito pool sweep::Could not delete domain/);
	});

	it('refuses to run outside the E2E accounts, deleting nothing', () => {
		const r = run({ pools: [blocksPool()], account: '999999999999' });
		assert.equal(r.status, 1, r.out);
		assert.match(r.out, /::error title=Cognito pool sweep::The caller's account is not an E2E account/);
		assert.doesNotMatch(r.out, /999999999999/, 'never prints the account id');
		assert.deepEqual(
			r.calls.map((c) => c[1]),
			['get-caller-identity'],
		);
	});

	it('refuses to run without AWS_ROLE_ARNS', () => {
		for (const roleArns of [null, '', 'not json', '[]']) {
			const r = run({ pools: [blocksPool()], roleArns });
			assert.equal(r.status, 1, r.out);
			assert.deepEqual(r.calls, []);
		}
	});

	it('warns, and deletes nothing, when the pools cannot be listed', () => {
		const r = run({ pools: [blocksPool()], listError: 'An error occurred (AccessDeniedException)' });
		assert.equal(r.status, 0, r.out);
		assert.match(r.out, /::warning title=Cognito pool sweep::Could not list user pools \(page 1\)/);
		assert.match(r.summary, /User pools listed: unknown/);
		assert.doesNotMatch(r.summary, /Test-named pools/);
		assert.deepEqual(deletes(r.calls), []);
	});

	it('reads every page of pools, sweeping a stale orphan on page 2', () => {
		const filler = Array.from({ length: 3 }, (_, i) => blocksPool({ Id: `f${i}`, Name: `customer-pool-${i}` }));
		const r = run({ pools: [...filler, blocksPool({ Id: 'us-east-1_page2' })], pageSize: 3 });
		assert.equal(r.status, 0, r.out);
		const lists = r.calls.filter((c) => c[1] === 'list-user-pools');
		assert.equal(lists.length, 2);
		assert.equal(lists[1][lists[1].indexOf('--next-token') + 1], '3');
		assert.deepEqual(deletes(r.calls), ['us-east-1_page2']);
		assert.match(r.summary, /User pools listed: 4 \(2 pages\)/);
		assert.match(r.summary, /Test-named pools: 1/);
	});

	it('sweeps nothing when a later page fails to list', () => {
		const r = run({
			pools: [blocksPool({ Id: 'us-east-1_page1' }), blocksPool({ Id: 'us-east-1_page2' })],
			pageSize: 1,
			listError: 'An error occurred (TooManyRequestsException)',
			listErrorPage: 2,
		});
		assert.equal(r.status, 0, r.out);
		assert.match(r.out, /::warning title=Cognito pool sweep::Could not list user pools \(page 2\)/);
		assert.match(r.summary, /User pools listed: unknown \(page 2 failed after 1 listed\)/);
		assert.deepEqual(deletes(r.calls), []);
		assert.equal(r.calls.filter((c) => c[1] === 'describe-user-pool').length, 0);
	});
});

describe('helpers', () => {
	it('reads the account ids out of the role ARNs', () => {
		assert.deepEqual(accountsOf(ROLE_ARNS), [ACCOUNT, '222222222222']);
		assert.deepEqual(accountsOf('["arn:aws:iam::123:role/x"]'), []);
	});

	it('requires the tag that matches the pool name', () => {
		assert.equal(taggedForCi('bb-test-x', { 'blocks:purpose': 'vpc-smoke-e2e' }), true);
		assert.equal(taggedForCi('bb-test-x', AMPLIFY_TAGS), false);
		assert.equal(taggedForCi('amplifyAuthUserPool4BA7F805-viQ0rPu77agW', BLOCKS_TAGS), false);
	});

	it('recognises only the missing-stack ValidationError for the given id', () => {
		const id = 'us-east-1_XpDNmUrOu';
		const real = `An error occurred (ValidationError) when calling the DescribeStackResources operation: Stack for ${id} does not exist`;
		assert.equal(isMissingStackError(real, id), true);
		assert.equal(isMissingStackError(real, 'us-east-1_Other'), false);
		// The id is matched literally, not as a regex.
		assert.equal(isMissingStackError(real, 'us-east-1.XpDNmUrOu'), false);
		assert.equal(
			isMissingStackError(`An error occurred (AccessDenied) when calling it: Stack for ${id} does not exist`, id),
			false,
		);
		assert.equal(isMissingStackError('An error occurred (ValidationError): Stack for x does not exist', id), false);
	});
});

describe('cleanup-stacks.yml', () => {
	it('runs the pool sweep on every leg, with the role ARNs it checks the account against', () => {
		const steps = parse(readFileSync(WORKFLOW, 'utf8')).jobs.cleanup.steps;
		const step = steps.find((s) => String(s.run ?? '').includes('scripts/ci/sweep-cognito-pools.mjs'));
		assert.ok(step, 'a step runs sweep-cognito-pools.mjs');
		assert.equal(step.if, 'always()');
		assert.equal(step.env.AWS_ROLE_ARNS, '${{ secrets.AWS_ROLE_ARNS }}');
		// After the stack sweeps, so a pool whose stack was just deleted is not
		// raced, and it runs after them either way (always()).
		const at = steps.indexOf(step);
		assert.ok(at > steps.findIndex((s) => s.name === 'Find and delete stale Amplify sandbox stacks'));
	});
});
