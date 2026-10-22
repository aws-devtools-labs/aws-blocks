// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// Unit tests for scripts/ci/e2e-selection.sh, run against throwaway git repos,
// plus a check that every E2E job in pr-checks.yml is wired to its output.
//
// Run: node --test scripts/ci/e2e-selection.test.mjs

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

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
 * adds `files` and has the commit message `message`. `base` maps more paths to
 * their contents in the origin/main commit.
 */
function repo(files, message = 'change', base = {}) {
	const dir = mkdtempSync(join(tmpdir(), 'e2e-selection-'));
	git(dir, 'init', '-q', '-b', 'main');
	writeFileSync(join(dir, 'README.md'), 'base\n');
	for (const [file, content] of Object.entries(base)) {
		mkdirSync(join(dir, file, '..'), { recursive: true });
		writeFileSync(join(dir, file), content);
	}
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

/** The root and test-apps/vpc-smoke package.json files, with the app's sandbox script. */
function vpcSmoke(sandboxScript, rootScript = 'cd test-apps/vpc-smoke && npm run test:e2e:sandbox') {
	return {
		'package.json': JSON.stringify({ scripts: { 'test:e2e:sandbox:vpc': rootScript } }),
		'test-apps/vpc-smoke/package.json': JSON.stringify({ scripts: { 'test:e2e:sandbox': sandboxScript } }),
	};
}
const VPC_OFF = vpcSmoke("echo 'No VPC-dependent BBs on main yet \u2014 skipping' && exit 0");
const WITHOUT_VPC = ALL.filter((job) => job !== 'sandbox-vpc');

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

	describe('while the VPC smoke suite is switched off', () => {
		it('leaves sandbox-vpc out of a source change, without blocking it', () => {
			const r = select(repo(SOURCE, 'src', VPC_OFF));
			assert.equal(r.status, 0);
			assert.deepEqual(r.e2e, WITHOUT_VPC);
			assert.deepEqual(r.blocked, []);
			assert.deepEqual(r.run, WITHOUT_VPC);
			assert.match(r.stdout, /E2E VPC Smoke is left out/);
		});

		it('leaves it out of E2E: all', () => {
			const r = select(repo(CI_ONLY, 'ci\n\nE2E: all\n', VPC_OFF));
			assert.deepEqual(r.e2e, WITHOUT_VPC);
			assert.deepEqual(r.blocked, []);
		});

		it('runs nothing for E2E: sandbox-vpc, without failing', () => {
			const r = select(repo(CI_ONLY, 'ci\n\nE2E: sandbox-vpc\n', VPC_OFF));
			assert.equal(r.status, 0);
			assert.deepEqual([r.e2e, r.blocked, r.run], [[], [], []]);
		});

		it('still blocks the other jobs a subset leaves out', () => {
			const r = select(repo(SOURCE, 'src\n\nE2E: sandbox\n', VPC_OFF));
			assert.deepEqual(r.e2e, ['sandbox']);
			assert.deepEqual(
				r.blocked,
				WITHOUT_VPC.filter((job) => job !== 'sandbox'),
			);
		});
	});

	for (const [what, files] of [
		['the app script runs tests', vpcSmoke('BLOCKS_TEST_ENV=sandbox tsx -C browser test/vpc-smoke.test.ts')],
		['the app script echoes and then runs tests', vpcSmoke("echo 'deploying' && tsx test/vpc-smoke.test.ts")],
		[
			'the root script no longer runs the app script',
			vpcSmoke("echo 'skipping' && exit 0", 'cd test-apps/vpc-smoke && tsx test/vpc-smoke.test.ts'),
		],
		['the app package.json is missing', { 'package.json': VPC_OFF['package.json'] }],
		['the app package.json is not JSON', { ...VPC_OFF, 'test-apps/vpc-smoke/package.json': '{' }],
		[
			'the app script has a post hook',
			{
				...VPC_OFF,
				'test-apps/vpc-smoke/package.json': JSON.stringify({
					scripts: { 'test:e2e:sandbox': "echo 'skipping' && exit 0", 'posttest:e2e:sandbox': 'tsx t.ts' },
				}),
			},
		],
		[
			'the root script has a pre hook',
			{
				...VPC_OFF,
				'package.json': JSON.stringify({
					scripts: {
						'pretest:e2e:sandbox:vpc': 'tsx t.ts',
						'test:e2e:sandbox:vpc': 'cd test-apps/vpc-smoke && npm run test:e2e:sandbox',
					},
				}),
			},
		],
	]) {
		it(`runs sandbox-vpc when ${what}`, () => {
			const r = select(repo(SOURCE, 'src', files));
			assert.equal(r.status, 0);
			assert.deepEqual(r.e2e, ALL);
			assert.doesNotMatch(r.stdout, /E2E VPC Smoke is left out/);
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

	// While test-apps/vpc-smoke's tests are off, e2e-selection.sh skips E2E VPC
	// Smoke by reading the npm script the job runs, so the job must run its
	// tests through that script and nothing else. Once they are on, this no
	// longer applies.
	it('runs the VPC smoke tests only through npm run test:e2e:sandbox:vpc while they are off', (t) => {
		// Ask the script, with this repo's package.json files.
		const real = {};
		for (const file of ['package.json', 'test-apps/vpc-smoke/package.json']) {
			const path = fileURLToPath(new URL(`../../${file}`, import.meta.url));
			if (existsSync(path)) real[file] = readFileSync(path, 'utf8');
		}
		if (select(repo(SOURCE, 'src', real)).e2e.includes('sandbox-vpc')) {
			t.skip('the VPC smoke tests are on');
			return;
		}
		const job = jobs['e2e-sandbox-vpc'];
		const message =
			"e2e-selection.sh skips this job while test-apps/vpc-smoke's tests are switched off " +
			'(its test:e2e:sandbox script only echoes). Switch the tests on in that script ' +
			'(and see the concurrency note on the job), not in the job.';
		assert.match(job, /^ {6}- name: E2E VPC Smoke\n {8}run: npm run test:e2e:sandbox:vpc\n/m, message);
		const code = job.split('\n').filter((line) => !line.trim().startsWith('#'));
		assert.deepEqual(
			code.filter((line) => /vpc-smoke|test:e2e/.test(line)),
			['        run: npm run test:e2e:sandbox:vpc'],
			message,
		);
	});

	for (const name of ALL) {
		it(`starts e2e-${name} from the run output and fails it first when blocked`, () => {
			const job = jobs[`e2e-${name}`];
			assert.ok(job.includes(`if: contains(fromJSON(needs.detect-changes.outputs.e2e-run), '${name}')`));
			const steps = job.slice(job.indexOf('    steps:\n'));
			assert.match(
				steps,
				new RegExp(
					`^    steps:\\n      - name: Check the E2E trailer\\n        if: contains\\(fromJSON\\(needs\\.detect-changes\\.outputs\\.e2e-blocked\\), '${name}'\\)\\n`,
				),
			);
		});
	}
});
