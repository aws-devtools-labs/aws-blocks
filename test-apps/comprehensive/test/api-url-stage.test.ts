// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The deployed E2E suites resolve the app under test from the stage config a
 * deploy records (`.blocks-sandbox/config.<stage>.json`), never from the dev
 * server's `config.json`, which a deploy no longer writes. The sandbox and
 * production E2E jobs broke with ENOENT when new suites read `config.json`
 * directly, so:
 *
 * 1. `callRpc` is exercised, per deployed stage, in a child process whose
 *    working directory holds only that stage's config, pointing at a loopback
 *    stub; before the migration it threw ENOENT there.
 * 2. A source guard keeps every test file on the `api-url.js` helpers: only
 *    `api-url.ts` may name the dev server's config file under .blocks-sandbox.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const testDir = dirname(fileURLToPath(import.meta.url));

export function apiUrlStageTests(): void {
	describe('Stage config resolution (api-url helpers)', () => {
		for (const stage of ['sandbox', 'production'] as const) {
			test(`callRpc reaches the ${stage} config URL with no config.json on disk`, async () => {
				// A loopback JSON-RPC stub standing in for the deployed API.
				const server = createServer((_req, res) => {
					res.setHeader('content-type', 'application/json');
					res.end(JSON.stringify({ jsonrpc: '2.0', result: 'stage-config-ok', id: 1 }));
				});
				await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
				const address = server.address();
				assert.ok(address && typeof address === 'object');
				const dir = mkdtempSync(join(tmpdir(), `api-url-${stage}-`));
				try {
					// Only this stage's config exists, as after its deploy.
					mkdirSync(join(dir, '.blocks-sandbox'));
					writeFileSync(
						join(dir, '.blocks-sandbox', `config.${stage}.json`),
						JSON.stringify({ apiUrl: `http://127.0.0.1:${address.port}/aws-blocks/api` }),
					);
					const script =
						`import { callRpc } from ${JSON.stringify(join(testDir, 'test-support.js'))};\n` +
						`const body = await callRpc('api.ping', []);\n` +
						`if (body.result !== 'stage-config-ok') throw new Error('unexpected: ' + JSON.stringify(body));\n` +
						`console.log('CALLRPC-OK');\n`;
					writeFileSync(join(dir, 'probe.mts'), script);
					const tsxCli = join(testDir, '..', '..', '..', 'node_modules', 'tsx', 'dist', 'cli.mjs');
					const child = spawn(process.execPath, [tsxCli, 'probe.mts'], {
						cwd: dir,
						env: { ...process.env, BLOCKS_TEST_ENV: stage, NODE_OPTIONS: '' },
						stdio: ['ignore', 'pipe', 'pipe'],
						// Bounded: a regression must fail the test, never hang the suite.
						timeout: 30_000,
					});
					const output: Buffer[] = [];
					child.stdout.on('data', (c) => output.push(c));
					child.stderr.on('data', (c) => output.push(c));
					const code = await new Promise<number | null>((resolve) => child.on('close', resolve));
					const text = Buffer.concat(output).toString();
					assert.strictEqual(code, 0, `probe failed (exit ${code}):\n${text}`);
					assert.match(text, /CALLRPC-OK/);
				} finally {
					rmSync(dir, { recursive: true, force: true });
					await new Promise<void>((resolve) => server.close(() => resolve()));
				}
			});
		}

		test('no test file reads .blocks-sandbox/config.json except the api-url helper', () => {
			const offenders: string[] = [];
			for (const name of readdirSync(testDir)) {
				if (!name.endsWith('.ts') || name === 'api-url.ts') continue;
				const source = readFileSync(join(testDir, name), 'utf-8');
				if (/['"`]\.blocks-sandbox\/config\.json['"`]/.test(source)) offenders.push(name);
			}
			assert.deepStrictEqual(offenders, [], 'read the stage config through ./api-url.js instead');
		});
	});
}
