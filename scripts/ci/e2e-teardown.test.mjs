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
const SUITE = new URL('../../test-apps/comprehensive/test/e2e.test.ts', import.meta.url);
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
		// Scripted statuses per call, then gone.
		const seq = (state.describeSeq || {})[name];
		if (seq && seq.length) { const st = seq.shift(); save(); process.stdout.write(JSON.stringify(st)); break; }
		if (!s || seq) fail('An error occurred (ValidationError) when calling the DescribeStacks operation: Stack with id ' + name + ' does not exist');
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

function run({ id = ID, stacks = [], jobStatus = 'cancelled', budget = '5', keep = '', strict = '', ...extra } = {}) {
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
	const outputPath = join(dir, 'github-output');
	writeFileSync(outputPath, '');
	const r = spawnSync(process.execPath, [SCRIPT, app], {
		encoding: 'utf8',
		env: {
			...process.env,
			PATH: `${bin}:${process.env.PATH}`,
			FAKE_AWS_STATE: statePath,
			FAKE_AWS_LOG: logPath,
			JOB_STATUS: jobStatus,
			BLOCKS_SANDBOX_KEEP: keep,
			E2E_TEARDOWN_STRICT: strict,
			GITHUB_OUTPUT: outputPath,
			E2E_TEARDOWN_BUDGET_SECONDS: budget,
			E2E_TEARDOWN_POLL_MS: '10',
		},
	});
	const calls = readFileSync(logPath, 'utf8')
		.split('\n')
		.filter(Boolean)
		.map((l) => JSON.parse(l));
	const state = JSON.parse(readFileSync(statePath, 'utf8'));
	const output = readFileSync(outputPath, 'utf8');
	return { ...r, out: r.stdout + r.stderr, calls, state, output };
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
		// Hands it over at once: only a passing strict job (E2E_TEARDOWN_STRICT,
		// no KEEP) waits for it to go.
		assert.equal(r.calls.filter((c) => c[1] === 'describe-stacks').length, 1);
	});

	it("doesn't wait for a stack being deleted in a passing job that is not strict, and warns", () => {
		const name = `bb-test-${ID}-pr-9-1`;
		const r = run({ stacks: [stack(name, 'DELETE_IN_PROGRESS')], jobStatus: 'success', budget: '30' });
		assert.equal(r.status, 0, r.out);
		assert.equal(r.calls.filter((c) => c[1] === 'describe-stacks').length, 1);
		assert.match(r.out, /::warning title=E2E teardown::/);
		assert.equal(r.output, `stacks=${name}\n`);
	});

	it("doesn't wait for a stack being deleted in a passing job that kept it", () => {
		const name = `bb-test-${ID}-pr-9-1`;
		const r = run({ stacks: [stack(name, 'DELETE_IN_PROGRESS')], jobStatus: 'success', keep: '1', strict: '1', budget: '30' });
		assert.equal(r.status, 0, r.out);
		assert.equal(r.calls.filter((c) => c[1] === 'describe-stacks').length, 1);
		assert.equal(r.output, `stacks=${name}\n`);
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
		const started = Date.now();
		const r = run({ stacks: [stack(name, 'CREATE_IN_PROGRESS')], statusAfterDelete: 'CREATE_IN_PROGRESS', budget: '30' });
		assert.equal(r.status, 0, r.out);
		// Two polls, not the whole budget.
		assert.ok(Date.now() - started < 15_000);
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

	it("fails, after re-issuing the delete, when a passing strict job's suite left its stack", () => {
		const name = `bb-test-${ID}-pr-9-1`;
		const r = run({ stacks: [stack(name, 'DELETE_FAILED')], jobStatus: 'success', strict: '1' });
		assert.equal(r.status, 1, r.out);
		assert.deepEqual(deletes(r.calls), [name]);
		assert.match(r.out, /::error title=E2E teardown::.*tests passed but the suite's own destroy left it DELETE_FAILED/);
		assert.equal(r.output, `stacks=${name}\n`);
	});

	it("doesn't fail a passing strict job for a stack listed mid-delete that is gone by the time it looks", () => {
		const name = `bb-test-${ID}-pr-9-1`;
		// Still deleting on the first two looks, then gone.
		const r = run({ stacks: [stack(name, 'DELETE_IN_PROGRESS')], describeSeq: { [name]: ['DELETE_IN_PROGRESS', 'DELETE_IN_PROGRESS'] }, jobStatus: 'success', strict: '1' });
		assert.equal(r.status, 0, r.out);
		assert.deepEqual(deletes(r.calls), []);
		assert.doesNotMatch(r.out, /::(error|warning)/);
		assert.match(r.out, /is gone now/);
		assert.equal(r.output, '');
	});

	it("fails a passing strict job for a stack still being deleted when the budget runs out, without a new delete", () => {
		const name = `bb-test-${ID}-pr-9-1`;
		const r = run({ stacks: [stack(name, 'DELETE_IN_PROGRESS')], jobStatus: 'success', budget: '1', strict: '1' });
		assert.equal(r.status, 1, r.out);
		assert.deepEqual(deletes(r.calls), []);
		assert.match(r.out, new RegExp(`::error title=E2E teardown::${name} is still being deleted: the tests passed`));
		assert.equal(r.output, `stacks=${name}\n`);
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

	it('deletes a stack the suite kept (BLOCKS_SANDBOX_KEEP) without a warning, and outputs it, even when strict', () => {
		const name = `bb-test-${ID}-pr-9-1`;
		const r = run({ stacks: [stack(name)], jobStatus: 'success', keep: '1', strict: '1' });
		assert.equal(r.status, 0, r.out);
		assert.deepEqual(deletes(r.calls), [name]);
		assert.doesNotMatch(r.out, /::warning/);
		assert.match(r.out, /E2E Teardown Verify waits for the delete/);
		assert.equal(r.output, `stacks=${name}\n`);
	});

	it('outputs every stack that is not gone, including one it failed on, for E2E Teardown Verify', () => {
		const [denied, deleting, quick] = [`bb-test-${ID}-pr-9-1`, `bb-test-prod-pr-9-1-${ID}`, `bb-test-${ID}-pr-9-1-vpc-ref`];
		const r = run({
			stacks: [stack(denied), stack(deleting, 'DELETE_IN_PROGRESS'), stack(quick)],
			deleteErrors: { [denied]: ['An error occurred (AccessDenied) when calling the DeleteStack operation: denied'] },
			// The delete of `quick` finishes before the first poll.
			statusAfterDelete: 'DELETE_COMPLETE',
			keep: '1',
		});
		assert.equal(r.status, 1, r.out);
		// One line per stack handed over, written as it goes (a step cut off by its
		// timeout keeps what it got to); GitHub keeps the last.
		assert.deepEqual(r.output.trim().split('\n'), [`stacks=${denied}`, `stacks=${denied} ${deleting}`]);
	});

	it('outputs no stack when the suite cleaned up', () => {
		const r = run({ stacks: [], jobStatus: 'success', keep: '1' });
		assert.equal(r.status, 0, r.out);
		assert.doesNotMatch(r.output, /stacks=\S/);
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
	// A job's lines before its steps (env, outputs, if, ...).
	const headOf = (job) => job.slice(0, job.indexOf('\n    steps:\n'));
	const ifOf = (step) => step.match(/^ {6}[- ] if: (.*)$/m)?.[1] ?? '';
	const CREDENTIALS = 'uses: ./.github/actions/e2e-aws-credentials';

	// Jobs that hold AWS credentials but deploy no stack of their own.
	const NO_STACK = {
		'e2e-supabase': 'reads a secret; the database is external',
		'e2e-sandbox-vpc': 'deploys only the persistent shared VPC, which must survive; its suite is a skip today',
		'teardown-verify': 'deploys nothing; waits for the deletes the E2E jobs started',
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

	// The jobs whose suite keeps its stacks and whose teardown doesn't wait for
	// the delete. Not E2E Sandbox: it is the required job that runs the
	// product's destroySandbox() (the comprehensive suite's test.after), so it
	// must keep running it. Not E2E Compute Smoke: ending it once the delete has
	// started would release its concurrency group while the stack's endpoints
	// are still in the shared compute VPC.
	const KEEPING = ['e2e-production'];
	// The jobs whose teardown hands the stacks it is deleting to E2E Teardown
	// Verify, which must wait for each of them.
	const ASYNC = ['e2e-sandbox', 'e2e-compute-smoke', ...KEEPING];
	const teardownStep = (id) => stepsOf(jobs[id]).find((st) => /run: node scripts\/ci\/e2e-teardown\.mjs /.test(st));

	it('finds every job that leaves its delete to E2E Teardown Verify', () => {
		const keeping = deploying.filter((id) => /^ {6}BLOCKS_SANDBOX_KEEP: '1'$/m.test(jobs[id]) && teardownStep(id));
		assert.deepEqual(keeping.sort(), [...KEEPING].sort());
	});

	for (const id of KEEPING) {
		it(`${id} keeps its stacks`, () => {
			const head = headOf(jobs[id]);
			assert.match(head, /^ {4}env:\n(?: {6}.*\n)*? {6}BLOCKS_SANDBOX_KEEP: '1'$/m, `${id}: set BLOCKS_SANDBOX_KEEP in the job env`);
		});
	}

	for (const id of ASYNC) {
		it(`${id} hands the teardown's stacks to E2E Teardown Verify`, () => {
			const head = headOf(jobs[id]);
			assert.match(head, /^ {4}outputs:\n {6}teardown-stacks: \$\{\{ steps\.teardown\.outputs\.stacks \}\}$/m);
			assert.match(teardownStep(id), /^ {8}id: teardown$/m);
		});
	}

	it('e2e-compute-smoke waits for its own delete: no KEEP anywhere in the job', () => {
		// KEEP would end the job, and free its concurrency group, while the
		// stack's endpoints are still in the shared compute test VPC.
		assert.match(jobs['e2e-compute-smoke'], /^ {6}group: blocks-test-compute-/m);
		assert.doesNotMatch(jobs['e2e-compute-smoke'], /^[^#\n]*BLOCKS_SANDBOX_KEEP/m);
	});

	it("e2e-sandbox runs the suite's destroySandbox() in-job and fails when it fails", () => {
		// Anywhere in the job (job env, step env, a shell export), not just the job
		// env, nor in the workflow env or the npm scripts the job runs.
		const keep = /^[^#\n]*BLOCKS_SANDBOX_KEEP/m;
		assert.doesNotMatch(jobs['e2e-sandbox'], keep, 'e2e-sandbox must not keep its stack');
		assert.doesNotMatch(yml.slice(0, yml.indexOf('\njobs:\n')), keep, 'the workflow env must not keep stacks');
		const scripts = (path) => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8')).scripts;
		assert.doesNotMatch(scripts('../../package.json')['test:e2e:sandbox'], /BLOCKS_SANDBOX_KEEP/);
		const app = scripts('../../test-apps/comprehensive/package.json');
		for (const s of ['test:e2e:sandbox', 'test:sandbox']) assert.doesNotMatch(app[s], /BLOCKS_SANDBOX_KEEP/, s);
		assert.ok(stepsOf(jobs['e2e-sandbox']).some((st) => /^ {8}run: npm run test:e2e:sandbox$/m.test(st)));
		// A stack the destroy left after the tests passed fails the job; only here.
		assert.match(teardownStep('e2e-sandbox'), /^ {10}E2E_TEARDOWN_STRICT: '1'$/m);
		for (const id of deploying.filter((d) => d !== 'e2e-sandbox')) assert.doesNotMatch(jobs[id], /E2E_TEARDOWN_STRICT/, id);
		assert.doesNotMatch(yml.slice(0, yml.indexOf('\njobs:\n')), /E2E_TEARDOWN_STRICT/, 'not for every job');
		// The suite destroys in test.after unless KEEP is set; run directly, a
		// throwing after() hook exits 0, so the suite sets the exit code itself.
		const suite = readFileSync(SUITE, 'utf8');
		const after = suite.slice(suite.indexOf('test.after('));
		assert.match(after, /ENV === 'sandbox'\s*\?\s*'test\/sandbox-destroy\.ts'/);
		assert.match(after, /catch \(e\) \{\n(?:[^\n]*\n)*?\s*process\.exitCode = 1;\n\s*\}\n/);
		assert.match(readFileSync(new URL('sandbox-destroy.ts', SUITE), 'utf8'), /await destroySandbox\(/);
	});

	describe('teardown-verify', () => {
		const job = jobs['teardown-verify'];
		const steps = stepsOf(job);

		it('waits for the stacks of every job that leaves its delete to it', () => {
			const needs = job.match(/^ {4}needs: \[(.*)\]$/m)[1].split(/,\s*/);
			for (const id of ['detect-changes', ...ASYNC]) assert.ok(needs.includes(id), `needs ${id}`);
			const wait = steps.at(-1);
			assert.match(wait, /run: node scripts\/ci\/e2e-stack-wait\.mjs \$STACKS\n/);
			for (const id of ASYNC) {
				assert.ok(wait.includes(`\${{ needs.${id}.outputs.teardown-stacks }}`), `passes ${id}'s stacks`);
				assert.ok(job.includes(`needs.${id}.outputs.teardown-stacks != ''`), `runs when ${id} left stacks`);
			}
		});

		it('runs unless the run is cancelled, only for same-repo PRs, in the e2e environment', () => {
			const cond = job.match(/^ {4}if: >-\n((?: {6}.*\n)+)/m)[1].replace(/\s+/g, ' ').trim();
			assert.ok(cond.startsWith("!cancelled() && github.event.pull_request.head.repo.full_name == github.repository && ("), cond);
			assert.match(job, /^ {4}environment: e2e$/m);
			assert.match(job, /^ {4}permissions:\n {6}contents: read\n {6}id-token: write {2}# .*\n/m);
			assert.ok(steps.some((st) => st.includes(CREDENTIALS)));
		});

		it('passes stack names through env, never into the shell text', () => {
			for (const st of steps) {
				const run = st.match(/^ {8}run: (.*)$/m)?.[1] ?? '';
				assert.doesNotMatch(run, /\$\{\{/);
			}
		});

		it('is not part of the Build and Test gate', () => {
			const gate = jobs['build-and-test'].match(/^ {4}needs: \[(.*)\]$/m)[1];
			assert.doesNotMatch(gate, /teardown-verify/);
		});
	});

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
