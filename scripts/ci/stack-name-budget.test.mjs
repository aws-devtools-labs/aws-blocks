// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// Synthesizes each test app an E2E job in pr-checks.yml deploys, with that job's
// own BLOCKS_STACK_SUFFIX rendered for a 5-digit PR number, and checks every
// name that can't be truncated still fits. The stack name prefixes each derived
// resource name and the suffix carries the PR number, so names grow as PR
// numbers do: at PR 1000 the comprehensive app's production stack pushed its
// `preset-balanced` agent's session bucket to 64 characters and synth failed.
//
// Needs the root build (`npm run build`). Run: node --test scripts/ci/stack-name-budget.test.mjs

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
// comprehensive app's is `<user>-<6 random>` and the runner's user is `runner`;
// the smoke apps use 8 characters of a UUID.
const JOBS = [
	{ job: 'e2e-sandbox', app: 'comprehensive', sandboxMode: true, sandboxId: 'runner-qb3cmv' },
	{ job: 'e2e-production', app: 'comprehensive', sandboxMode: false, sandboxId: 'runner-qb3cmv' },
	{ job: 'e2e-sandbox-vpc', app: 'vpc-smoke', sandboxMode: true, sandboxId: 'abcdef12' },
	{ job: 'e2e-compute-smoke', app: 'compute-smoke', sandboxMode: true, sandboxId: 'abcdef12' },
];

// Names AWS rejects past this length, which the blocks don't truncate.
const LIMITS = {
	'AWS::S3::Bucket': ['BucketName', 63],
	'AWS::S3Vectors::VectorBucket': ['VectorBucketName', 63],
	'AWS::S3Vectors::Index': ['IndexName', 63],
};

/** The job's BLOCKS_STACK_SUFFIX with the PR number and run attempt filled in. */
function renderSuffix(job) {
	const jobs = readFileSync(WORKFLOW, 'utf8').split(/^ {2}(?=[a-z0-9-]+:\s*$)/m);
	const block = jobs.find((b) => b.startsWith(`${job}:`));
	assert.ok(block, `pr-checks.yml has no ${job} job`);
	const template = block.match(/^\s+BLOCKS_STACK_SUFFIX:\s*(.+?)\s*$/m)?.[1];
	assert.ok(template, `${job} sets no BLOCKS_STACK_SUFFIX`);
	const suffix = template
		.replaceAll('${{ github.event.pull_request.number || github.run_id }}', PR)
		.replaceAll('${{ github.run_attempt }}', ATTEMPT);
	assert.doesNotMatch(suffix, /\$\{\{/, `${job}: teach this test the expression in "${template}"`);
	return suffix;
}

describe('E2E stack names leave room for every derived resource name', () => {
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
				const res = spawnSync('npx', ['tsx', '-C', 'cdk', 'aws-blocks/index.cdk.ts'], {
					cwd: join(ROOT, 'test-apps', app),
					encoding: 'utf8',
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
				assert.equal(res.status, 0, `synth with BLOCKS_STACK_SUFFIX=${suffix} failed:\n${res.stderr}`);

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
