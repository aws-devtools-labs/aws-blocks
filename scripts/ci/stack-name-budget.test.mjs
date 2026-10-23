// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// Synthesizes the test app of each E2E job in pr-checks.yml that sets
// BLOCKS_STACK_SUFFIX (JOBS; the rest are in SKIP with a reason), with that
// job's own suffix rendered for a 5-digit PR number, and checks every name that
// can't be truncated still fits. The stack name prefixes each derived
// resource name and the suffix carries the PR number, so names grow as PR
// numbers do: at PR 1000 the comprehensive app's production stack pushed its
// `preset-balanced` agent's session bucket to 64 characters and synth failed.
//
// Needs the root build (`npm run build`) and glibc >= 2.34 (dsql-lint runs at
// synth; on older hosts use a node:22-bookworm container). Run: node --test scripts/ci/stack-name-budget.test.mjs

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const WORKFLOW = join(ROOT, '.github/workflows/pr-checks.yml');

// A PR number and run attempt longer than any this repo will see for years.
const PR = '99999';
const ATTEMPT = '99';

// Each job's app and deploy mode, and the sandbox id CI ends up with: the
// comprehensive app's is `<user>-<6 random>` and the runner's user is `runner`
// (no E2E job sets a git user.name; its sandbox-mode bucket has 2 characters
// to spare at PR 99999), the smoke apps use 8 characters of a UUID.
const JOBS = [
	{ job: 'e2e-sandbox', app: 'comprehensive', sandboxMode: true, sandboxId: 'runner-qb3cmv' },
	{ job: 'e2e-production', app: 'comprehensive', sandboxMode: false, sandboxId: 'runner-qb3cmv' },
	{ job: 'e2e-sandbox-vpc', app: 'vpc-smoke', sandboxMode: true, sandboxId: 'abcdef12' },
	{ job: 'e2e-compute-smoke', app: 'compute-smoke', sandboxMode: true, sandboxId: 'abcdef12' },
];

// Jobs that set BLOCKS_STACK_SUFFIX but deploy no name this test checks.
const SKIP = {
	'e2e-hosting': 'hosting apps create no S3, S3 Vectors or RDS name from the stack name',
	'e2e-telemetry': 'the telemetry app creates no S3, S3 Vectors or RDS name from the stack name',
};

// Names AWS rejects past this length, which the blocks don't truncate.
const LIMITS = {
	'AWS::S3::Bucket': ['BucketName', 63],
	'AWS::RDS::DBCluster': ['DatabaseName', 63],
	'AWS::S3Vectors::VectorBucket': ['VectorBucketName', 63],
	'AWS::S3Vectors::Index': ['IndexName', 63],
};

/** Each pr-checks.yml job's text, keyed by job id. */
function jobBlocks() {
	const blocks = readFileSync(WORKFLOW, 'utf8').split(/^ {2}(?=[a-z0-9-]+:\s*$)/m);
	return new Map(blocks.map((b) => [b.slice(0, b.indexOf(':')), b]));
}

/** The job's BLOCKS_STACK_SUFFIX with the PR number and run attempt filled in. */
function renderSuffix(job) {
	const block = jobBlocks().get(job);
	assert.ok(block, `pr-checks.yml has no ${job} job`);
	const values = [...block.matchAll(/^\s+BLOCKS_STACK_SUFFIX:\s*(.+?)\s*$/gm)].map((m) => m[1]);
	assert.equal(values.length, 1, `${job} should set BLOCKS_STACK_SUFFIX exactly once`);
	const template = values[0].replace(/\s+#.*$/, '').replace(/^(['"])(.*)\1$/, '$2');
	const suffix = template
		.replaceAll('${{ github.event.pull_request.number || github.run_id }}', PR)
		.replaceAll('${{ github.run_attempt }}', ATTEMPT);
	assert.doesNotMatch(suffix, /\$\{\{/, `${job}: teach this test the expression in "${template}"`);
	return suffix;
}

describe('E2E stack names leave room for every derived resource name', () => {
	it('covers every job that sets BLOCKS_STACK_SUFFIX', () => {
		const listed = new Set([...JOBS.map((j) => j.job), ...Object.keys(SKIP)]);
		const unlisted = [...jobBlocks()]
			.filter(([job, block]) => /^\s+BLOCKS_STACK_SUFFIX:/m.test(block) && !listed.has(job))
			.map(([job]) => job);
		assert.deepEqual(unlisted, [], 'add these jobs to JOBS (or to SKIP with a reason)');
		const jobs = jobBlocks();
		const stale = Object.keys(SKIP).filter((job) => !jobs.has(job) || JOBS.some((j) => j.job === job));
		assert.deepEqual(stale, [], 'remove these SKIP entries: the job is gone or is checked in JOBS');
	});

	for (const { job, app, sandboxMode, sandboxId } of JOBS) {
		it(`${job} (${app}, ${sandboxMode ? 'sandbox' : 'production'} mode)`, () => {
			const suffix = renderSuffix(job);
			const work = mkdtempSync(join(tmpdir(), 'blocks-stack-name-'));
			try {
				mkdirSync(join(work, '.blocks-sandbox'));
				writeFileSync(join(work, '.blocks-sandbox', 'sandbox-id.txt'), sandboxId);
				const outdir = join(work, 'cdk.out');
				const context = { projectRoot: work, ...(sandboxMode ? { sandboxMode: 'true' } : {}) };
				// The smoke apps look their VPC up; run the app directly (not through the
				// CDK CLI) so the lookup falls back to CDK's placeholder VPC offline.
				if (app !== 'comprehensive') context.vpcId = 'vpc-0123456789abcdef0';
				const nodeOptions = process.env.NODE_OPTIONS ?? '';
				// tsx as an in-process loader (not `npx tsx`), so the timeout kills the synth itself.
				const res = spawnSync(process.execPath, ['--import', 'tsx', 'aws-blocks/index.cdk.ts'], {
					cwd: join(ROOT, 'test-apps', app),
					encoding: 'utf8',
					timeout: 180_000,
					maxBuffer: 64 * 1024 * 1024,
					env: {
						...process.env,
						BLOCKS_STACK_SUFFIX: suffix,
						CDK_OUTDIR: outdir,
						CDK_CONTEXT_JSON: JSON.stringify(context),
						CDK_DEFAULT_ACCOUNT: '123456789012',
						CDK_DEFAULT_REGION: 'us-east-1',
						// AGENTS.md Core rule 1: synth needs `--conditions=cdk`.
						NODE_OPTIONS: nodeOptions.includes('--conditions=cdk')
							? nodeOptions
							: `${nodeOptions} --conditions=cdk`.trim(),
					},
				});
				const why = [res.error?.code, res.signal].filter(Boolean).join(' ');
				assert.equal(res.status, 0, `synth with BLOCKS_STACK_SUFFIX=${suffix} failed ${why}:\n${res.stderr}`);

				const tooLong = [];
				let checked = 0;
				for (const file of readdirSync(outdir).filter((f) => f.endsWith('.template.json'))) {
					const { Resources = {} } = JSON.parse(readFileSync(join(outdir, file), 'utf8'));
					for (const r of Object.values(Resources)) {
						const [prop, max] = LIMITS[r.Type] ?? [];
						const name = r.Properties?.[prop];
						if (typeof name !== 'string') continue;
						checked++;
						if (name.length > max) tooLong.push(`${r.Type} ${name} (${name.length} > ${max})`);
					}
				}
				assert.ok(checked > 0, 'expected at least one named bucket');
				assert.deepEqual(tooLong, []);
			} finally {
				rmSync(work, { recursive: true, force: true });
			}
		});
	}
});
