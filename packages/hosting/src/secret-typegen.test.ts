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
	watchHostingValues,
} from './secret-typegen.js';

/** Poll `probe` until it returns a truthy value or the timeout elapses. */
async function waitFor<T>(probe: () => Promise<T | null>, timeoutMs = 3000): Promise<T | null> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const v = await probe();
		if (v) return v;
		await new Promise((r) => setTimeout(r, 25));
	}
	return null;
}

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

	void it('resolves the import binding, not the identifier text', async () => {
		const cwd = await fixture({
			'aws-blocks/index.cdk.ts': `
				import { secret as sec, config } from '@aws-blocks/hosting';
				// A local function of the same name must NOT be treated as a marker.
				function secretHelper() { return 'x'; }
				const localSecret = (k: string) => k;

				const a = sec('ALIASED_KEY');        // aliased import → detected as secret
				const b = config('REAL_CONFIG');     // named import → detected as config
				const c = localSecret('LOCAL');      // local fn → ignored
			`,
			// A same-named import from an UNRELATED module (dotenv) must be ignored.
			'aws-blocks/env.ts': `
				import { config } from 'dotenv';
				config({ path: '.env' });            // not a marker; also not a "non-literal" warning
			`,
		});
		const scan = await scanValueKeys({ cwd });
		assert.deepEqual(scan.secretKeys, ['ALIASED_KEY']);
		assert.deepEqual(scan.configKeys, ['REAL_CONFIG']);
		assert.equal(scan.dynamicCallSites.length, 0, 'dotenv config({path}) must not be flagged');
	});

	void it('detects markers imported via @aws-blocks/blocks/cdk (the primary app path)', async () => {
		const cwd = await fixture({
			'aws-blocks/index.cdk.ts': `
				import { secret, config } from '@aws-blocks/blocks/cdk';
				const s = secret('VIA_BLOCKS_CDK');
				const c = config('CFG_VIA_BLOCKS_CDK');
			`,
		});
		const scan = await scanValueKeys({ cwd });
		assert.deepEqual(scan.secretKeys, ['VIA_BLOCKS_CDK']);
		assert.deepEqual(scan.configKeys, ['CFG_VIA_BLOCKS_CDK']);
	});

	void it('detects namespace-imported markers (import * as blocks)', async () => {
		const cwd = await fixture({
			'aws-blocks/index.cdk.ts': `
				import * as blocks from '@aws-blocks/core/cdk';
				const s = blocks.secret('NS_SECRET');
				const c = blocks.config('NS_CONFIG');
			`,
		});
		const scan = await scanValueKeys({ cwd });
		assert.deepEqual(scan.secretKeys, ['NS_SECRET']);
		assert.deepEqual(scan.configKeys, ['NS_CONFIG']);
	});

	void it('ignores marker-looking calls with no import binding in the file', async () => {
		const cwd = await fixture({
			'aws-blocks/index.cdk.ts': `secret('NO_IMPORT'); config('NO_IMPORT_2');`,
		});
		const scan = await scanValueKeys({ cwd });
		assert.deepEqual(scan.secretKeys, []);
		assert.deepEqual(scan.configKeys, []);
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

void describe('watchHostingValues()', () => {
	void it('regenerates when a scanned file changes; stop() tears down', async () => {
		const cwd = await fixture({
			'aws-blocks/index.cdk.ts': `import { secret } from '@aws-blocks/hosting'; secret('K1');`,
		});
		// Low debounce + poll so it is fast on both fs.watch (macOS/Windows) and the
		// polling fallback (Linux, where recursive fs.watch is unavailable).
		const stop = await watchHostingValues({ cwd, debounceMs: 20, pollMs: 50, log: () => {}, error: () => {} });
		try {
			const outFile = join(cwd, '.blocks', 'hosting-values.d.ts');
			assert.ok((await readFile(outFile, 'utf-8')).includes('"K1": string;'));

			// Add a new key → the watcher should regenerate with it.
			await writeFile(
				join(cwd, 'aws-blocks', 'index.cdk.ts'),
				`import { secret, config } from '@aws-blocks/hosting'; secret('K1'); config('C2');`,
				'utf-8',
			);
			const updated = await waitFor(async () => {
				const c = await readFile(outFile, 'utf-8').catch(() => '');
				return c.includes('"C2": string;') ? c : null;
			});
			assert.ok(updated, 'watcher did not regenerate with the new config key');
		} finally {
			stop();
		}
	});
});
