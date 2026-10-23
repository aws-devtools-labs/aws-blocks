// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// Unit tests for scripts/ci/e2e-selection.sh, run against throwaway git repos,
// plus a check that every E2E job in pr-checks.yml is wired to its output.
//
// Run: node --test scripts/ci/e2e-selection.test.mjs

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

const SCRIPT = fileURLToPath(new URL('./e2e-selection.sh', import.meta.url));
const WORKFLOW = fileURLToPath(new URL('../../.github/workflows/pr-checks.yml', import.meta.url));
const ALL = [
	'compute-smoke',
	'hosting',
	'production',
	'sandbox',
	'sandbox-vpc',
	'supabase',
	'telemetry',
	'templates',
	'templates-windows',
];

// The E2E jobs that are required checks.
const REQUIRED = ['production', 'sandbox'];

// Isolated from the user's git config (hooks, signing, default branch).
const GIT_ENV = {
	...process.env,
	GIT_CONFIG_GLOBAL: '/dev/null',
	GIT_CONFIG_NOSYSTEM: '1',
	GIT_AUTHOR_NAME: 'test',
	GIT_AUTHOR_EMAIL: 'test@example.com',
	GIT_COMMITTER_NAME: 'test',
	GIT_COMMITTER_EMAIL: 'test@example.com',
};

function git(cwd, ...args) {
	const r = spawnSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf8' });
	assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
}

/**
 * A repo whose origin/main has one commit, with a PR head commit on top that
 * adds `files` and has the commit message `message`.
 */
function repo(files, message = 'change') {
	const dir = mkdtempSync(join(tmpdir(), 'e2e-selection-'));
	git(dir, 'init', '-q', '-b', 'main');
	writeFileSync(join(dir, 'README.md'), 'base\n');
	git(dir, 'add', '.');
	git(dir, 'commit', '-q', '-m', 'base');
	git(dir, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
	for (const file of files) {
		mkdirSync(join(dir, file, '..'), { recursive: true });
		writeFileSync(join(dir, file), `${file}\n`);
	}
	writeFileSync(join(dir, '.msg'), message);
	git(dir, 'add', '--', ...files);
	git(dir, 'commit', '-q', '-F', '.msg');
	return dir;
}

function select(dir) {
	const output = join(dir, '.output');
	writeFileSync(output, '');
	const r = spawnSync('bash', [SCRIPT, 'origin/main'], {
		cwd: dir,
		env: { ...GIT_ENV, GITHUB_OUTPUT: output, GITHUB_STEP_SUMMARY: join(dir, '.summary'), E2E_ACCOUNT: '1' },
		encoding: 'utf8',
	});
	const out = Object.fromEntries(
		readFileSync(output, 'utf8')
			.split('\n')
			.filter(Boolean)
			.map((line) => {
				const i = line.indexOf('=');
				return [line.slice(0, i), JSON.parse(line.slice(i + 1))];
			}),
	);
	return { status: r.status, stdout: r.stdout, ...out };
}

const SOURCE = ['packages/core/src/a.ts'];
const CI_ONLY = ['.github/workflows/x.yml'];

describe('e2e-selection.sh', () => {
	it('runs every job for a source change without a trailer', () => {
		const r = select(repo(SOURCE));
		assert.equal(r.status, 0);
		assert.deepEqual(r.e2e, ALL);
		assert.deepEqual(r.blocked, []);
		assert.deepEqual(r.run, ALL);
	});

	it('counts test-apps/ as a source change', () => {
		assert.deepEqual(select(repo(['test-apps/x/a.ts'])).e2e, ALL);
	});

	it('runs nothing for a CI-only change without a trailer', () => {
		const r = select(repo(CI_ONLY));
		assert.equal(r.status, 0);
		assert.deepEqual([r.e2e, r.blocked, r.run], [[], [], []]);
	});

	it('runs the trailer subset on a CI-only change', () => {
		const r = select(repo(CI_ONLY, 'ci\n\nE2E: sandbox, hosting\n'));
		assert.equal(r.status, 0);
		assert.deepEqual(r.e2e, ['hosting', 'sandbox']);
		assert.deepEqual(r.blocked, []);
		assert.deepEqual(r.run, ['hosting', 'sandbox']);
	});

	it('blocks the jobs a subset leaves out on a source change', () => {
		const r = select(repo(SOURCE, 'src\n\nE2E: sandbox\n'));
		assert.equal(r.status, 0);
		assert.deepEqual(r.e2e, ['sandbox']);
		assert.deepEqual(
			r.blocked,
			ALL.filter((job) => job !== 'sandbox'),
		);
		assert.deepEqual(r.run, ALL);
		assert.match(r.stdout, /::error::The E2E trailer leaves out/);
	});

	it('runs every job for E2E: all', () => {
		const r = select(repo(CI_ONLY, 'ci\n\nE2E: all\n'));
		assert.deepEqual(r.e2e, ALL);
		assert.deepEqual(r.blocked, []);
	});

	it('ignores case and duplicates, and combines several trailers', () => {
		const r = select(repo(CI_ONLY, 'ci\n\ne2e: Sandbox,SANDBOX\nE2E: hosting\n'));
		assert.equal(r.status, 0);
		assert.deepEqual(r.e2e, ['hosting', 'sandbox']);
	});

	it('joins a value folded onto the next line', () => {
		const r = select(repo(CI_ONLY, 'ci\n\nE2E: sandbox,\n  hosting\n'));
		assert.deepEqual(r.e2e, ['hosting', 'sandbox']);
	});

	it('ignores an E2E: line that is not in the trailer block', () => {
		const r = select(repo(CI_ONLY, 'ci\n\nE2E: sandbox\n\nnot a trailer block\n'));
		assert.deepEqual(r.e2e, []);
	});

	it('blocks every job for an unknown name on a source change, without failing', () => {
		const r = select(repo(SOURCE, 'src\n\nE2E: sandbox, sandbx\n'));
		assert.equal(r.status, 0);
		assert.match(r.stdout, /::error::Unknown E2E job 'sandbx'/);
		assert.deepEqual(r.e2e, []);
		assert.deepEqual(r.blocked, ALL);
		assert.deepEqual(r.run, ALL);
	});

	it('fails for an unknown name on a CI-only change', () => {
		const r = select(repo(CI_ONLY, 'ci\n\nE2E: sandbx\n'));
		assert.equal(r.status, 1);
		assert.match(r.stdout, /::error::Unknown E2E job 'sandbx'/);
	});

	for (const value of ['*', '$(id)', '`id`', 'sandbox;id', '::add-mask::x', '"]']) {
		it(`rejects ${value} as an unknown name`, () => {
			const r = select(repo(SOURCE, `src\n\nE2E: ${value}\n`));
			assert.equal(r.status, 0);
			assert.deepEqual(r.e2e, []);
			assert.deepEqual(r.blocked, ALL);
		});
	}

	// A large diff once made `git diff | grep -q` die of SIGPIPE under
	// pipefail, which read as "no source change".
	it('detects a source change in a large diff', () => {
		const files = Array.from({ length: 3000 }, (_, i) => `packages/core/src/generated/some-long-file-name-${i}.ts`);
		const r = select(repo(files));
		assert.equal(r.status, 0);
		assert.deepEqual(r.e2e, ALL);
	});
});

describe('pr-checks.yml', () => {
	const yml = readFileSync(WORKFLOW, 'utf8');
	const parsed = parse(yml).jobs;
	// Each top-level job, from its `  id:` line to the next one.
	const jobs = Object.fromEntries(
		yml
			.split(/^(?=  [a-z][\w-]*:$)/m)
			.slice(1)
			.map((block) => [block.slice(2, block.indexOf(':')), block]),
	);

	it('has one E2E job per name the script knows', () => {
		const e2eJobs = Object.keys(jobs)
			.filter((id) => id.startsWith('e2e-'))
			.map((id) => id.slice('e2e-'.length))
			.sort();
		assert.deepEqual(e2eJobs, ALL);
	});

	for (const name of ALL) {
		it(`starts e2e-${name} from the run output and fails it first when blocked`, () => {
			const job = jobs[`e2e-${name}`];
			const run = `contains(fromJSON(needs.detect-changes.outputs.e2e-run), '${name}')`;
			// The required ones also start when Detect Changes didn't succeed, and
			// check that first; required-checks.test.mjs covers their if: and guard.
			if (REQUIRED.includes(name)) assert.ok(parsed[`e2e-${name}`].if?.includes(run));
			else
				assert.equal(
					parsed[`e2e-${name}`].if,
					`${run} && github.event.pull_request.head.repo.full_name == github.repository`,
				);
			const steps = job
				.slice(job.indexOf('    steps:\n'))
				.replace(
					/^( {4}steps:\n)(?: {6}#.*\n)* {6}- name: Check that Detect Changes succeeded\n[\s\S]*?\n\n/,
					'$1',
				);
			assert.match(
				steps,
				new RegExp(
					`^    steps:\\n      - name: Check the E2E trailer\\n        if: contains\\(fromJSON\\(needs\\.detect-changes\\.outputs\\.e2e-blocked\\), '${name}'\\)\\n`,
				),
			);
		});
	}
});
