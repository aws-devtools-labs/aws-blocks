// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// Tests for the Harbor agent check's approval gate (.github/workflows/harbor-agent-check.yml).
// Model and trace credentials come from the `harbor-bench` environment, which has no required
// reviewers of its own: the single `approval` job on `harbor-bench-approval` is the only human
// gate, and the IAM roles cannot see it. So the workflows themselves must guarantee that:
//   - no workflow other than harbor-agent-check.yml mentions `harbor-bench` at all (a raw-text
//     check, so it also catches an `environment: ${{ … }}` expression whose values name it);
//   - harbor-agent-check.yml has exactly one approval job, which cannot fan out, skip or succeed
//     without approval;
//   - every job there that uses `harbor-bench` needs it directly;
//   - none of those jobs runs when the approval is rejected or skipped (no always()/failure()).
// It does not catch a name assembled at runtime from parts (e.g. 'harbor-' + 'bench').
// The approver reviews the run summary the `revisions` job writes, so it also checks that the
// summary lists the PR's changed files (scripts/harbor-bench/changed-files.mjs, from main's
// checkout), with the files that can change what runs next to the credentials marked and first.
//
// Run: node --test scripts/ci/harbor-approval-gate.test.mjs

import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { changedFilesSummary, isSensitive, MAX_ROWS } from '../harbor-bench/changed-files.mjs';

const WORKFLOWS = fileURLToPath(new URL('../../.github/workflows/', import.meta.url));
const REPO = fileURLToPath(new URL('../../', import.meta.url));
const GATED = 'harbor-agent-check.yml';
const workflow = parse(readFileSync(join(WORKFLOWS, GATED), 'utf8'));
const jobs = Object.entries(workflow.jobs);
const otherWorkflows = readdirSync(WORKFLOWS).filter((f) => /\.ya?ml$/.test(f) && f !== GATED);

const environmentOf = (job) => (typeof job.environment === 'object' ? job.environment?.name : job.environment);
const needsOf = (job) => [job.needs ?? []].flat();
// Status functions that let a job run although a job it needs failed, was cancelled or was skipped.
const BYPASS = /\b(always|failure|cancelled)\s*\(/;

const approvals = jobs.filter(([, job]) => environmentOf(job) === 'harbor-bench-approval');
const credentialed = jobs.filter(([, job]) => environmentOf(job) === 'harbor-bench');

describe('Harbor approval gate', () => {
	it('keeps harbor-bench out of every other workflow', () => {
		assert.ok(otherWorkflows.length > 0, 'expected other workflow files to scan');
		for (const file of otherWorkflows) {
			assert.ok(
				!readFileSync(join(WORKFLOWS, file), 'utf8').includes('harbor-bench'),
				`${file} mentions harbor-bench; only ${GATED} may use it, behind its approval job`,
			);
		}
	});

	it('has exactly one approval job, which cannot fan out, skip or succeed on error', () => {
		assert.equal(approvals.length, 1, 'expected one job on the harbor-bench-approval environment');
		const [, gate] = approvals[0];
		assert.equal(gate.strategy, undefined, 'the approval job must not be a matrix (one review per run)');
		assert.equal(gate.if, undefined, 'a condition could skip the approval job');
		assert.notEqual(gate['continue-on-error'], true, 'a rejected approval must fail the job');
		assert.deepEqual(gate.permissions, {}, 'the approval job needs no token permissions');
	});

	it('makes every harbor-bench job need the approval job', () => {
		assert.ok(credentialed.length > 0, 'expected at least one job on the harbor-bench environment');
		const [gateName] = approvals[0] ?? [];
		for (const [name, job] of credentialed) {
			assert.ok(needsOf(job).includes(gateName), `${name} uses harbor-bench without needing the approval job`);
		}
	});

	it('never runs a harbor-bench job after a rejected or skipped approval', () => {
		for (const [name, job] of credentialed) {
			assert.ok(!BYPASS.test(String(job.if ?? '')), `${name} has a condition that bypasses a failed approval: ${job.if}`);
		}
	});
});

const file = (filename, extra = {}) => ({ filename, status: 'modified', additions: 1, deletions: 0, ...extra });
/** The marker and file cells of a summary's body rows. */
const listed = (summary) => summary.rows.slice(1).map(([marker, name]) => [marker, name]);

describe('Harbor approval summary: changed-file table', () => {
	it('marks files that can change what runs next to the credentials', () => {
		for (const path of [
			'.github/workflows/pr-checks.yml',
			'.github/actions/setup/action.yml',
			'scripts/harbor-bench/run.py',
			'scripts/harbor-bench/task/tests/verify.py',
			'package.json',
			'packages/core/package.json',
			'package-lock.json',
			'packages/x/npm-shrinkwrap.json',
			'yarn.lock',
			'pnpm-lock.yaml',
			'.npmrc',
			'packages/core/.npmrc',
			'packages/hosting/scripts/bundle-handlers.mjs',
			'tsconfig.json',
			'packages/core/tsconfig.build.json',
			'.nvmrc',
		]) {
			assert.equal(isSensitive(path), true, path);
		}
		for (const path of [
			'packages/core/src/index.ts',
			'docs/notes.md',
			'README.md',
			'my-package.json',
			'mytsconfig.json',
		]) {
			assert.equal(isSensitive(path), false, path);
		}
	});

	it('lists filename, status and line counts, marked files first', () => {
		const summary = changedFilesSummary(
			[
				file('packages/core/src/a.ts', { additions: 3, deletions: 2 }),
				file('.github/workflows/x.yml', { status: 'added', additions: 10 }),
				file('packages/core/package.json'),
			],
			{ total: 3 },
		);
		assert.deepEqual(
			summary.rows[0].map((c) => c.data),
			['', 'File', 'Status', '+', '-'],
		);
		assert.ok(summary.rows[0].every((c) => c.header === true));
		assert.deepEqual(summary.rows.slice(1), [
			['!', '<code>.github/workflows/x.yml</code>', 'added', '10', '0'],
			['!', '<code>packages/core/package.json</code>', 'modified', '1', '0'],
			['', '<code>packages/core/src/a.ts</code>', 'modified', '3', '2'],
		]);
		assert.equal(summary.flagged, 2);
		assert.equal(summary.more, 0);
		assert.match(summary.note, /2 of 3 changed files/);
		// Unmarked rows still run with the credentials; harness and workflow edits apply after merge.
		assert.match(summary.note, /package source included, runs in the approved job/);
		assert.match(summary.note, /take effect only after merge/);
	});

	it('marks a file renamed out of a sensitive path and names its old path', () => {
		const summary = changedFilesSummary(
			[file('docs/old-workflow.yml', { status: 'renamed', previous_filename: '.github/workflows/old.yml' })],
			{ total: 1 },
		);
		assert.deepEqual(summary.rows[1].slice(0, 3), [
			'!',
			'<code>docs/old-workflow.yml</code>',
			'renamed from <code>.github/workflows/old.yml</code>',
		]);
	});

	it(`caps the table at ${MAX_ROWS} rows and counts the rest, keeping marked files in view`, () => {
		const files = Array.from({ length: 120 }, (_, i) => file(`packages/core/src/f${i}.ts`));
		files.push(file('scripts/harbor-bench/run.py'));
		const summary = changedFilesSummary(files, { total: 400 });
		assert.equal(summary.rows.length, MAX_ROWS + 1);
		assert.deepEqual(listed(summary)[0], ['!', '<code>scripts/harbor-bench/run.py</code>']);
		assert.equal(summary.more, 400 - MAX_ROWS);
		assert.equal(summary.footer, `+${400 - MAX_ROWS} more.`);
		// The API listed 121 of 400 files: the note above the table says the rest were not checked.
		assert.match(summary.note, /^1 of the 121 listed files are marked !; 279 more were not listed/);
		assert.match(summary.note, /Files changed tab/);
	});

	it('escapes PR-controlled file names', () => {
		const summary = changedFilesSummary(
			[file('a<img src=x onerror=alert(1)>&"\'.ts\nscripts/x', { status: '<b>x</b>' })],
			{ total: 1 },
		);
		const [, name, status] = summary.rows[1];
		assert.equal(name, '<code>a&lt;img src=x onerror=alert(1)&gt;&amp;&quot;&#39;.ts\\nscripts/x</code>');
		assert.equal(status, '&lt;b&gt;x&lt;/b&gt;');
	});

	it('says so when the PR changes no files', () => {
		const summary = changedFilesSummary([], { total: 0 });
		assert.equal(summary.rows.length, 1);
		assert.match(summary.note, /no changed files/i);
	});
});

describe('Harbor approval summary: revisions step', () => {
	const revisionsJob = workflow.jobs.revisions;
	const step = revisionsJob.steps.find((s) => s.id === 'revisions');

	it('imports the table builder from the main checkout, with no extra token permissions', () => {
		const checkout = revisionsJob.steps.find((s) => String(s.uses).startsWith('actions/checkout@'));
		assert.equal(checkout.with.ref, '${{ github.sha }}', 'the imported module must come from the dispatching main commit');
		assert.equal(revisionsJob.permissions, undefined, 'the revisions job keeps the workflow-level contents: read');
		assert.match(step.with.script, /scripts\/harbor-bench\/changed-files\.mjs/);
	});

	// A copy of the module under a workspace path that a file:// string concatenation would break.
	const oddWorkspace = join(mkdtempSync(join(tmpdir(), 'harbor-ws-')), 'a b%20#c');
	mkdirSync(join(oddWorkspace, 'scripts/harbor-bench'), { recursive: true });
	copyFileSync(
		join(REPO, 'scripts/harbor-bench/changed-files.mjs'),
		join(oddWorkspace, 'scripts/harbor-bench/changed-files.mjs'),
	);
	after(() => rmSync(dirname(oddWorkspace), { recursive: true, force: true }));

	// Runs the step's github-script body with a fake API, core.summary and context.
	for (const [label, workspace] of [
		['the checkout', REPO.replace(/\/$/, '')],
		['a workspace path with a space, % and #', oddWorkspace],
	]) it(`writes the changed-file table to the run summary (${label})`, async () => {
		const pr = {
			state: 'open',
			head: { sha: 'h'.repeat(40), repo: { full_name: 'someone/cdk-blocks' } },
			base: { ref: 'main', sha: 'b'.repeat(40) },
			changed_files: 2,
		};
		const comparison = {
			merge_base_commit: { sha: 'm'.repeat(40) },
			files: [file('packages/core/src/a.ts'), file('.github/workflows/x.yml')],
		};
		const github = {
			rest: {
				pulls: { get: async () => ({ data: pr }) },
				repos: { compareCommitsWithBasehead: async () => ({ data: comparison }) },
			},
		};
		const calls = [];
		const summary = new Proxy(
			{},
			{
				get: (_, method) => {
					if (method === 'then') return undefined; // not a thenable, so `await` returns it as is
					if (method === 'write') return async () => summary;
					return (...args) => (calls.push([method, ...args]), summary);
				},
			},
		);
		const outputs = {};
		const core = { summary, setOutput: (k, v) => (outputs[k] = v) };
		const context = { repo: { owner: 'aws-devtools-labs', repo: 'aws-blocks' } };
		const AsyncFunction = (async () => {}).constructor;
		// Set and restore only these keys, so process.env stays Node's own object.
		const env = { PR_NUMBER: '7', TRIALS: '1', GITHUB_WORKSPACE: workspace };
		const saved = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
		Object.assign(process.env, env);
		try {
			await new AsyncFunction('github', 'context', 'core', step.with.script)(github, context, core);
		} finally {
			for (const [k, v] of Object.entries(saved)) {
				if (v === undefined) delete process.env[k];
				else process.env[k] = v;
			}
		}
		assert.equal(outputs.candidate, pr.head.sha);
		const tables = calls.filter(([m]) => m === 'addTable').map(([, rows]) => rows);
		const fileTable = tables.find((rows) => rows[0].some((c) => c.data === 'File'));
		assert.ok(fileTable, 'expected a changed-file table in the summary');
		assert.deepEqual(
			fileTable.slice(1).map((r) => r.slice(0, 2)),
			[
				['!', '<code>.github/workflows/x.yml</code>'],
				['', '<code>packages/core/src/a.ts</code>'],
			],
		);
	});
});
