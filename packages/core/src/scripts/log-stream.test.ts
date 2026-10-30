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

/** Run an ESM `body` (with `here` as the scripts dir URL) in a child with `env`; returns its streams. */
function runHarness(body: string, env: NodeJS.ProcessEnv): { status: number | null; stdout: string; stderr: string } {
	const dir = mkdtempSync(join(tmpdir(), 'blocks-log-stream-'));
	const script = join(dir, 'harness.mjs');
	writeFileSync(script, body);
	const child = spawnSync(process.execPath, [script], {
		encoding: 'utf-8',
		env: { PATH: process.env.PATH, ...env },
		timeout: 30_000,
	});
	return { status: child.status, stdout: child.stdout, stderr: child.stderr };
}

describe('runStreaming under BLOCKS_LOG_STREAM=stderr', () => {
	it('relays the child stdout to stderr when no stdout sink is given', () => {
		const r = runHarness(
			`import { runStreaming } from '${here}deploy-stream.js';
await runStreaming(process.execPath, ['-e', 'console.log("relayed line")'], { heartbeatMs: 60_000 });
console.log('result');`,
			{ BLOCKS_LOG_STREAM: 'stderr' },
		);
		assert.strictEqual(r.status, 0, r.stderr);
		assert.strictEqual(r.stdout, 'result\n');
		assert.match(r.stderr, /^relayed line$/m);
	});
});

describe('migration subprocess output', () => {
	const migrate = (code: number) =>
		`import { runMigrateCommand } from '${here}external-migrations-step.js';
try {
  runMigrateCommand(process.execPath, ['-e', 'console.log("applied 0001_init.sql"); process.exitCode = ${code}'], process.env);
  console.error('ok');
} catch (e) { console.error('threw: ' + e.message.split(' ').pop()); }`;

	it('unset: inherits stdio (stdout) as before', () => {
		const r = runHarness(migrate(0), {});
		assert.strictEqual(r.stdout, 'applied 0001_init.sql\n');
		assert.strictEqual(r.stderr, 'ok\n');
	});

	it('BLOCKS_LOG_STREAM=stderr: moves the child stdout to stderr', () => {
		const r = runHarness(migrate(0), { BLOCKS_LOG_STREAM: 'stderr' });
		assert.strictEqual(r.stdout, '');
		assert.strictEqual(r.stderr, 'applied 0001_init.sql\nok\n');
	});

	it('quiet: hides the child stdout on success and dumps it to stderr on failure', () => {
		const ok = runHarness(migrate(0), { BLOCKS_LOG_LEVEL: 'quiet' });
		assert.strictEqual(ok.stdout + ok.stderr, 'ok\n');
		const failed = runHarness(migrate(4), { BLOCKS_LOG_LEVEL: 'quiet' });
		assert.strictEqual(failed.stdout, '');
		assert.strictEqual(failed.stderr, 'applied 0001_init.sql\nthrew: 4\n');
	});
});

describe('dev typegen watcher output', () => {
	const body = `import { typegenWatchOptions } from '${here}dev-server.js';
const o = typegenWatchOptions();
if (o.unref !== true) throw new Error('not unref');
o.log('hosting-typegen: regenerated x.d.ts');`;

	it('unset: prints on stdout as before', () => {
		const r = runHarness(body, {});
		assert.strictEqual(r.status, 0, r.stderr);
		assert.strictEqual(r.stdout, 'hosting-typegen: regenerated x.d.ts\n');
	});

	it('is detail: hidden at quiet and normal, on stderr with BLOCKS_LOG_STREAM=stderr', () => {
		for (const level of ['quiet', 'normal']) {
			const r = runHarness(body, { BLOCKS_LOG_LEVEL: level });
			assert.strictEqual(r.status, 0, r.stderr);
			assert.strictEqual(r.stdout + r.stderr, '', level);
		}
		const r = runHarness(body, { BLOCKS_LOG_LEVEL: 'verbose', BLOCKS_LOG_STREAM: 'stderr' });
		assert.strictEqual(r.stdout, '');
		assert.strictEqual(r.stderr, 'hosting-typegen: regenerated x.d.ts\n');
	});
});
