// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// Unit tests for scripts/ci/e2e-teardown.mjs, run against a fake `aws` CLI,
// plus a check that every pr-checks.yml job that deploys a stack tears it down
// in an `if: always()` step (a cancelled job never reaches the suite's own
// test.after destroy).
//
// Run: node --test scripts/ci/e2e-teardown.test.mjs

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('./e2e-teardown.mjs', import.meta.url));
const WORKFLOW = fileURLToPath(new URL('../../.github/workflows/pr-checks.yml', import.meta.url));
const ID = 'runner-k3x9q2';

// A stand-in for the AWS CLI: serves list-stacks / describe-stacks /
// delete-stack from a JSON state file, logs each call, and applies scripted
// delete-stack failures in order.
const FAKE_AWS = `#!/usr/bin/env node
const fs = require('node:fs');
const statePath = process.env.FAKE_AWS_STATE;
const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_AWS_LOG, JSON.stringify(args) + '\\n');
const name = args[args.indexOf('--stack-name') + 1];
const fail = (msg) => { process.stderr.write(msg + '\\n'); process.exit(254); };
const save = () => fs.writeFileSync(statePath, JSON.stringify(state));
switch (args[1]) {
	case 'list-stacks':
		if (state.listError) fail(state.listError);
		if ((state.listErrors || []).length) { const e = state.listErrors.shift(); save(); fail(e); }
		process.stdout.write(JSON.stringify(state.stacks.filter((s) => s.StackStatus !== 'DELETE_COMPLETE')));
		break;
	case 'describe-stacks': {
		const s = state.stacks.find((x) => x.StackName === name && x.StackStatus !== 'DELETE_COMPLETE');
		if (!s) fail('An error occurred (ValidationError) when calling the DescribeStacks operation: Stack with id ' + name + ' does not exist');
		process.stdout.write(JSON.stringify(s.StackStatus));
		break;
	}
	case 'delete-stack': {
		const errs = (state.deleteErrors || {})[name] || [];
		if (errs.length) { const e = errs.shift(); save(); fail(e); }
		const s = state.stacks.find((x) => x.StackName === name);
		if (s) s.StackStatus = state.statusAfterDelete || 'DELETE_IN_PROGRESS';
		save();
		break;
	}
	default:
		fail('unexpected call: ' + args.join(' '));
}
`;

function run({ id = ID, stacks = [], jobStatus = 'cancelled', budget = '5', ...extra } = {}) {
	const dir = mkdtempSync(join(tmpdir(), 'e2e-teardown-'));
	const app = join(dir, 'app');
	mkdirSync(app);
	if (id !== null) {
		mkdirSync(join(app, '.blocks-sandbox'));
		writeFileSync(join(app, '.blocks-sandbox', 'sandbox-id.txt'), `${id}\n`);
	}
	const bin = join(dir, 'bin');
	mkdirSync(bin);
	writeFileSync(join(bin, 'aws'), FAKE_AWS);
	chmodSync(join(bin, 'aws'), 0o755);
	const statePath = join(dir, 'state.json');
	const logPath = join(dir, 'calls.log');
	writeFileSync(statePath, JSON.stringify({ stacks, ...extra }));
	writeFileSync(logPath, '');
	const r = spawnSync(process.execPath, [SCRIPT, app], {
		encoding: 'utf8',
		env: {
			...process.env,
			PATH: `${bin}:${process.env.PATH}`,
			FAKE_AWS_STATE: statePath,
			FAKE_AWS_LOG: logPath,
			JOB_STATUS: jobStatus,
			E2E_TEARDOWN_BUDGET_SECONDS: budget,
			E2E_TEARDOWN_POLL_MS: '10',
		},
	});
	const calls = readFileSync(logPath, 'utf8')
		.split('\n')
		.filter(Boolean)
		.map((l) => JSON.parse(l));
	const state = JSON.parse(readFileSync(statePath, 'utf8'));
	return { ...r, out: r.stdout + r.stderr, calls, state };
}

const deletes = (calls) => calls.filter((c) => c[1] === 'delete-stack').map((c) => c[c.indexOf('--stack-name') + 1]);
const stack = (StackName, StackStatus = 'CREATE_COMPLETE', ParentId = null) => ({ StackName, StackStatus, ParentId });

describe('e2e-teardown.mjs', () => {
	it('does nothing and calls no AWS API when nothing was synthesized', () => {
		const r = run({ id: null });
		assert.equal(r.status, 0, r.out);
		assert.deepEqual(r.calls, []);
		assert.match(r.out, /nothing was deployed/);
	});

	it('is a no-op when the suite already destroyed its stack', () => {
		const r = run({ stacks: [stack(`bb-test-prod-pr-9-1-${ID}`, 'DELETE_COMPLETE')], jobStatus: 'success' });
		assert.equal(r.status, 0, r.out);
		assert.deepEqual(
			r.calls.map((c) => c[1]),
			['list-stacks'],
		);
		assert.match(r.out, /nothing left/);
	});

	it("deletes only this checkout's root stacks", () => {
		const r = run({
			stacks: [
				stack(`bb-test-prod-pr-9-1-${ID}`, 'CREATE_IN_PROGRESS'),
				stack(`bb-test-${ID}-pr-9-1`),
				// Same PR, a newer run: a different id. Must survive.
				stack('bb-test-prod-pr-9-1-runner-zzzzzz', 'CREATE_IN_PROGRESS'),
				// A nested stack of ours: CloudFormation deletes it with its parent.
				stack(`bb-test-${ID}-pr-9-1-Nested-ABC`, 'CREATE_COMPLETE', 'arn:parent'),
				// The id only as a substring of another token.
				stack(`bb-test-prod-pr-9-1-x${ID}`),
			],
		});
		assert.equal(r.status, 0, r.out);
		assert.deepEqual(deletes(r.calls).sort(), [`bb-test-${ID}-pr-9-1`, `bb-test-prod-pr-9-1-${ID}`].sort());
		assert.match(r.out, /::warning title=E2E teardown::.*bb-test-prod-pr-9-1-runner-k3x9q2/);
	});

	it('leaves a stack that is already being deleted alone', () => {
		const r = run({ stacks: [stack(`bb-test-${ID}-pr-9-1`, 'DELETE_IN_PROGRESS')] });
		assert.equal(r.status, 0, r.out);
		assert.deepEqual(deletes(r.calls), []);
	});

	it('retries a delete CloudFormation rejects while an operation is in progress', () => {
		const name = `bb-test-${ID}-pr-9-1`;
		const busy = `An error occurred (ValidationError) when calling the DeleteStack operation: Stack:${name} is in UPDATE_ROLLBACK_IN_PROGRESS state and can not be deleted`;
		const r = run({ stacks: [stack(name, 'UPDATE_ROLLBACK_IN_PROGRESS')], deleteErrors: { [name]: [busy, busy] } });
		assert.equal(r.status, 0, r.out);
		assert.deepEqual(deletes(r.calls), [name, name, name]);
		assert.equal(r.state.stacks[0].StackStatus, 'DELETE_IN_PROGRESS');
	});

	it('retries a throttled delete', () => {
		const name = `bb-test-${ID}-pr-9-1`;
		const r = run({
			stacks: [stack(name)],
			deleteErrors: { [name]: ['An error occurred (Throttling) when calling the DeleteStack operation: Rate exceeded'] },
		});
		assert.equal(r.status, 0, r.out);
		assert.deepEqual(deletes(r.calls), [name, name]);
	});

	it('fails at once, visibly, when the delete is denied', () => {
		const name = `bb-test-${ID}-pr-9-1`;
		const r = run({
			stacks: [stack(name)],
			deleteErrors: { [name]: ['An error occurred (AccessDenied) when calling the DeleteStack operation: denied'] },
		});
		assert.equal(r.status, 1, r.out);
		assert.deepEqual(deletes(r.calls), [name]);
		assert.match(r.out, /::error title=E2E teardown::.*AccessDenied/);
	});

	it('gives up within its time budget instead of hanging', () => {
		const name = `bb-test-${ID}-pr-9-1`;
		const busy = 'An error occurred (ValidationError) when calling the DeleteStack operation: Stack is in UPDATE_IN_PROGRESS state and can not be deleted';
		const started = Date.now();
		const r = run({
			stacks: [stack(name, 'UPDATE_IN_PROGRESS')],
			deleteErrors: { [name]: Array(10_000).fill(busy) },
			budget: '1',
		});
		assert.equal(r.status, 1, r.out);
		assert.ok(Date.now() - started < 15_000);
		assert.match(r.out, /::error title=E2E teardown::.*UPDATE_IN_PROGRESS/);
	});

	it('re-issues the delete of a stack the suite left DELETE_FAILED', () => {
		const name = `bb-test-${ID}-pr-9-1`;
		const r = run({ stacks: [stack(name, 'DELETE_FAILED')], jobStatus: 'failure' });
		assert.equal(r.status, 0, r.out);
		assert.deepEqual(deletes(r.calls), [name]);
		assert.match(r.out, /::warning title=E2E teardown::.*this failure job left it DELETE_FAILED/);
	});

	it('fails when an accepted delete never starts', () => {
		const name = `bb-test-${ID}-pr-9-1`;
		const r = run({ stacks: [stack(name, 'CREATE_COMPLETE')], statusAfterDelete: 'CREATE_COMPLETE', budget: '1' });
		assert.equal(r.status, 1, r.out);
		assert.match(r.out, /::error title=E2E teardown::.*is CREATE_COMPLETE after DeleteStack/);
	});

	it('warns when a stack cancelled mid-create is still finishing its create', () => {
		const name = `bb-test-${ID}-pr-9-1`;
		const r = run({ stacks: [stack(name, 'CREATE_IN_PROGRESS')], statusAfterDelete: 'CREATE_IN_PROGRESS', budget: '1' });
		assert.equal(r.status, 0, r.out);
		assert.deepEqual(deletes(r.calls), [name]);
		assert.match(r.out, /::warning title=E2E teardown::DeleteStack .* accepted; still CREATE_IN_PROGRESS/);
	});

	it('reports a stack that moves to DELETE_FAILED', () => {
		const name = `bb-test-${ID}-pr-9-1`;
		const r = run({ stacks: [stack(name, 'CREATE_FAILED')], statusAfterDelete: 'DELETE_FAILED', budget: '1' });
		assert.equal(r.status, 1, r.out);
		assert.match(r.out, /::error title=E2E teardown::.*DELETE_FAILED/);
	});

	it("warns, without failing, when a passing job's suite left its stack", () => {
		const name = `bb-test-${ID}-pr-9-1`;
		const r = run({ stacks: [stack(name, 'DELETE_FAILED')], jobStatus: 'success' });
		assert.equal(r.status, 0, r.out);
		assert.deepEqual(deletes(r.calls), [name]);
		assert.match(r.out, /::warning title=E2E teardown::.*tests passed but the suite's own destroy left it DELETE_FAILED/);
	});

	it('retries a throttled ListStacks', () => {
		const r = run({ listErrors: ['An error occurred (Throttling) when calling the ListStacks operation: Rate exceeded'] });
		assert.equal(r.status, 0, r.out);
		assert.deepEqual(
			r.calls.map((c) => c[1]),
			['list-stacks', 'list-stacks'],
		);
	});

	it('does not retry a denied delete because the stack name looks like a 5xx', () => {
		const name = `bb-test-${ID}-pr-503-1`;
		const r = run({
			stacks: [stack(name)],
			deleteErrors: { [name]: [`An error occurred (AccessDenied) when calling the DeleteStack operation: not authorized on ${name}`] },
		});
		assert.equal(r.status, 1, r.out);
		assert.deepEqual(deletes(r.calls), [name]);
	});

	it('fails when it cannot list the stacks', () => {
		const r = run({ listError: 'An error occurred (ExpiredToken) when calling the ListStacks operation' });
		assert.equal(r.status, 1, r.out);
		assert.match(r.out, /::error title=E2E teardown::.*ExpiredToken/);
	});

	it('refuses an id that could match other runs', () => {
		const r = run({ id: 'ab', stacks: [stack('bb-test-ab-pr-9-1')] });
		assert.equal(r.status, 1, r.out);
		assert.deepEqual(r.calls, []);
	});
});

describe('pr-checks.yml', () => {
	const yml = readFileSync(WORKFLOW, 'utf8');
	const jobsYml = yml.slice(yml.indexOf('\njobs:\n'));
	// Each top-level job, from its `  id:` line to the next one.
	const jobs = Object.fromEntries(
		jobsYml
			.split(/^(?= {2}[a-z][\w-]*:$)/m)
			.slice(1)
			.map((block) => [block.slice(2, block.indexOf(':')), block]),
	);
	const stepsOf = (job) =>
		job
			.slice(job.indexOf('\n    steps:\n'))
			.split(/^(?= {6}- )/m)
			.slice(1);
	const ifOf = (step) => step.match(/^ {6}[- ] if: (.*)$/m)?.[1] ?? '';
	const CREDENTIALS = 'uses: ./.github/actions/e2e-aws-credentials';

	// Jobs that hold AWS credentials but deploy no stack of their own.
	const NO_STACK = {
		'e2e-supabase': 'reads a secret; the database is external',
		'e2e-sandbox-vpc': 'deploys only the persistent shared VPC, which must survive; its suite is a skip today',
		// Its stacks (bb-compute-smoke-*) are outside the prefixes the E2E role may
		// delete directly, so only its own cdk destroy can remove them.
		'e2e-compute-smoke': 'stack prefix outside the E2E role scope for direct CloudFormation calls',
	};

	it('lists only real jobs as stack-free', () => {
		for (const id of Object.keys(NO_STACK)) {
			assert.ok(jobs[id]?.includes(CREDENTIALS), `${id} is not an AWS job any more`);
		}
	});

	const deploying = Object.keys(jobs).filter((id) => jobs[id].includes(CREDENTIALS) && !(id in NO_STACK));

	it('finds the deploying jobs', () => {
		assert.ok(deploying.includes('e2e-sandbox'));
		assert.ok(deploying.includes('e2e-production'));
	});

	// What a last always() step may run to tear a job's stacks down.
	const TEARDOWN = /scripts\/ci\/e2e-teardown\.mjs|test\/sandbox-destroy\.ts|scripts\/sandbox-destroy\.ts|scripts\/destroy\.ts/;

	for (const id of deploying) {
		it(`${id} ends with an always() step that tears its stacks down`, () => {
			const steps = stepsOf(jobs[id]);
			const last = steps.at(-1);
			assert.match(ifOf(last), /^always\(\)/, `${id}: the last step must run with if: always()`);
			// The command, without comments, and a failure it can't hide.
			const command = last
				.slice(last.search(/^ {8}run: /m))
				.split('\n')
				.map((l) => l.replace(/(^|\s)#.*$/, ''))
				.join('\n');
			assert.match(command, TEARDOWN, `${id}: the last step must run a teardown`);
			assert.doesNotMatch(last, /continue-on-error/, `${id}: the teardown must not hide its failure`);
			const creds = steps.findIndex((s) => s.includes(CREDENTIALS));
			assert.ok(creds >= 0 && creds < steps.length - 1, `${id}: the teardown must come after the credentials step`);
		});
	}

	for (const id of ['e2e-sandbox', 'e2e-production']) {
		it(`${id} refreshes credentials for the teardown, skips it when nothing was synthesized, and bounds it`, () => {
			const steps = stepsOf(jobs[id]);
			const [teardown, refresh] = [steps.at(-1), steps.at(-2)];
			assert.match(teardown, /run: node scripts\/ci\/e2e-teardown\.mjs test-apps\/comprehensive\n/);
			const guard = "always() && hashFiles('test-apps/comprehensive/.blocks-sandbox/sandbox-id.txt') != ''";
			assert.equal(ifOf(teardown), guard);
			assert.ok(refresh.includes(CREDENTIALS), `${id}: the teardown must follow a credentials step`);
			assert.equal(ifOf(refresh), guard);
			assert.match(teardown, /JOB_STATUS: \$\{\{ job\.status \}\}/);
			// GitHub force-stops a cancelled job 5 minutes after the cancel; both
			// steps together must end before that.
			const minutes = (step) => Number(step.match(/timeout-minutes: (\d+)/)?.[1]);
			assert.ok(minutes(refresh) >= 1 && minutes(teardown) >= 1, `${id}: both steps need timeout-minutes`);
			assert.ok(minutes(refresh) + minutes(teardown) <= 4, `${id}: the steps may take at most 4 minutes together`);
		});
	}
});
