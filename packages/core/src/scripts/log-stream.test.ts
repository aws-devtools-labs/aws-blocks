// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * `BLOCKS_LOG_STREAM=stderr` moves progress (log.progress/detail, the curated CDK
 * milestones and the raw CDK output) to stderr and keeps results on stdout. A
 * child process runs a fake deploy with the real logger and CDK output wrapper,
 * so the assertions are on the bytes each stream carried.
 */

import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

const here = new URL('.', import.meta.url).href;

const FAKE_DEPLOY = `
import { log } from '${here}log.js';
import { createCdkOutput } from '${here}cdk-output.js';
import { formatDeploySignal } from '${here}deploy-stream.js';
log.progress('🚀 Deploying to AWS...');
log.detail('   (This may take a few minutes on first deploy)');
await createCdkOutput({ label: 'cdk deploy', verb: 'deploy' }).run(process.execPath, ['-e', 'console.log("raw cdk line")']);
console.log('🎯 Deployment target: AWS profile dev, Region us-east-1');
console.log(formatDeploySignal('https://api.example/', 'https://app.example/'));
`;

function fakeDeploy(env: NodeJS.ProcessEnv): { stdout: string; stderr: string } {
	const dir = mkdtempSync(join(tmpdir(), 'blocks-log-stream-'));
	const script = join(dir, 'deploy.mjs');
	writeFileSync(script, FAKE_DEPLOY);
	const child = spawnSync(process.execPath, [script], {
		encoding: 'utf-8',
		env: { PATH: process.env.PATH, ...env },
	});
	assert.strictEqual(child.status, 0, child.stderr);
	return { stdout: child.stdout, stderr: child.stderr };
}

const SIGNAL = 'BLOCKS_DEPLOYED url=https://app.example/ api=https://api.example/\n';
const TARGET = '🎯 Deployment target: AWS profile dev, Region us-east-1\n';

describe('BLOCKS_LOG_STREAM', () => {
	it('=stderr: stdout carries only the target summary and BLOCKS_DEPLOYED', () => {
		const { stdout, stderr } = fakeDeploy({ BLOCKS_LOG_LEVEL: 'verbose', BLOCKS_LOG_STREAM: 'stderr' });
		assert.strictEqual(stdout, TARGET + SIGNAL);
		assert.strictEqual(
			stderr,
			'🚀 Deploying to AWS...\n   (This may take a few minutes on first deploy)\nraw cdk line\n',
		);
	});

	it('unset: the legacy streams are unchanged (everything on stdout)', () => {
		const { stdout, stderr } = fakeDeploy({ BLOCKS_LOG_LEVEL: 'verbose' });
		assert.strictEqual(
			stdout,
			`🚀 Deploying to AWS...\n   (This may take a few minutes on first deploy)\nraw cdk line\n${TARGET}${SIGNAL}`,
		);
		assert.strictEqual(stderr, '');
	});
});
