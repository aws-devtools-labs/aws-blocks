// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import {
	DEFAULT_TYPEGEN_MODULES,
	generateHostingValuesDts,
	renderHostingValuesDts,
	runTypegenCli,
	scanValueKeys,
} from './secret-typegen.js';

const tmpDirs: string[] = [];

async function fixture(files: Record<string, string>): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), 'blocks-typegen-'));
	tmpDirs.push(dir);
	const { mkdir } = await import('node:fs/promises');
	const { dirname } = await import('node:path');
	for (const [rel, content] of Object.entries(files)) {
		const abs = join(dir, rel);
		await mkdir(dirname(abs), { recursive: true });
		await writeFile(abs, content, 'utf-8');
	}
	return dir;
}

after(async () => {
	const { rm } = await import('node:fs/promises');
	await Promise.all(tmpDirs.map((d) => rm(d, { recursive: true, force: true }).catch(() => {})));
});

void describe('scanValueKeys()', () => {
	void it('collects string-literal secret()/config() keys, sorted + de-duped', async () => {
		const cwd = await fixture({
			'aws-blocks/index.cdk.ts': `
				import { secret, config } from '@aws-blocks/hosting';
				const e = {
					STRIPE_KEY: secret('STRIPE_KEY'),
					FEATURE_FLAGS: config('FEATURE_FLAGS'),
					DB: secret('DB_PASSWORD'),
				};
				const dupe = secret('STRIPE_KEY'); // duplicate → collapsed
			`,
		});
		const scan = await scanValueKeys({ cwd });
		assert.deepEqual(scan.secretKeys, ['DB_PASSWORD', 'STRIPE_KEY']);
		assert.deepEqual(scan.configKeys, ['FEATURE_FLAGS']);
		assert.equal(scan.dynamicCallSites.length, 0);
	});

	void it('ignores commented-out and string-literal occurrences (AST, not regex)', async () => {
		const cwd = await fixture({
			'aws-blocks/index.cdk.ts': `
				import { secret } from '@aws-blocks/hosting';
				// secret('COMMENTED') should NOT be captured
				const s = "secret('IN_A_STRING')"; // not a call
				const real = secret('REAL_KEY');
			`,
		});
		const scan = await scanValueKeys({ cwd });
		assert.deepEqual(scan.secretKeys, ['REAL_KEY']);
	});

	void it('reports non-literal keys as dynamic call sites (skipped)', async () => {
		const cwd = await fixture({
			'aws-blocks/index.cdk.ts': `
				import { secret } from '@aws-blocks/hosting';
				const NAME = 'X';
				const dyn = secret(NAME);
				const lit = secret('LITERAL');
			`,
		});
		const scan = await scanValueKeys({ cwd });
		assert.deepEqual(scan.secretKeys, ['LITERAL']);
		assert.equal(scan.dynamicCallSites.length, 1);
		assert.equal(scan.dynamicCallSites[0].fn, 'secret');
		assert.ok(scan.dynamicCallSites[0].line > 0);
	});

	void it('does not descend into node_modules / dist / .blocks', async () => {
		const cwd = await fixture({
			'aws-blocks/index.cdk.ts': `import { secret } from '@aws-blocks/hosting'; secret('KEEP');`,
			'node_modules/pkg/index.ts': `secret('FROM_NODE_MODULES');`,
			'dist/index.js': `secret('FROM_DIST');`,
			'.blocks/hosting-values.d.ts': `secret('FROM_BLOCKS');`,
		});
		const scan = await scanValueKeys({ cwd });
		assert.deepEqual(scan.secretKeys, ['KEEP']);
	});
});

void describe('renderHostingValuesDts()', () => {
	void it('augments BOTH the barrel and the /secret subpath', () => {
		const dts = renderHostingValuesDts({ secretKeys: ['A'], configKeys: ['B'] });
		for (const spec of DEFAULT_TYPEGEN_MODULES) {
			assert.ok(dts.includes(`declare module "${spec}"`), `missing augmentation for ${spec}`);
		}
		// module count == specifier count (one block each)
		assert.equal(dts.match(/declare module/g)?.length, DEFAULT_TYPEGEN_MODULES.length);
		assert.ok(dts.includes('"A": string;'));
		assert.ok(dts.includes('"B": string;'));
		assert.ok(dts.includes('export {};'), 'must be a module (augmentation, not ambient)');
	});

	void it('emits empty interfaces when there are no keys (stays `string`)', () => {
		const dts = renderHostingValuesDts({ secretKeys: [], configKeys: [] });
		assert.ok(dts.includes('interface HostingSecretRegistry {}'));
		assert.ok(dts.includes('interface HostingConfigRegistry {}'));
	});
});

void describe('generateHostingValuesDts()', () => {
	void it('writes the file, then reports upToDate on a re-run (deterministic)', async () => {
		const cwd = await fixture({
			'aws-blocks/index.cdk.ts': `import { secret, config } from '@aws-blocks/hosting'; secret('K1'); config('C1');`,
		});
		const first = await generateHostingValuesDts({ cwd });
		assert.equal(first.upToDate, false); // did not exist
		const onDisk = await readFile(first.outFile, 'utf-8');
		assert.equal(onDisk, first.content);

		const second = await generateHostingValuesDts({ cwd });
		assert.equal(second.upToDate, true);
		assert.equal(second.content, first.content);
	});

	void it('check mode does not write and flags staleness via exit code', async () => {
		const cwd = await fixture({
			'aws-blocks/index.cdk.ts': `import { secret } from '@aws-blocks/hosting'; secret('NEW_KEY');`,
		});
		const messages: string[] = [];
		// No file yet → stale → exit 1, nothing written.
		const code = await runTypegenCli(['--check', '--cwd', cwd], {
			log: (m) => messages.push(m),
			error: (m) => messages.push(m),
		});
		assert.equal(code, 1);
		assert.ok(messages.some((m) => /out of date/.test(m)));
		await assert.rejects(readFile(join(cwd, '.blocks', 'hosting-values.d.ts'), 'utf-8'));

		// Generate, then --check passes.
		await runTypegenCli(['--cwd', cwd], { log: () => {}, error: () => {} });
		const code2 = await runTypegenCli(['--check', '--cwd', cwd], { log: () => {}, error: () => {} });
		assert.equal(code2, 0);
	});
});
