// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * `blocks generate client` runs `blocks-generate-client`. In an app that does not
 * install `tsx` itself (pnpm, or npm without hoisting), it loads the worker with
 * the `tsx` that `@aws-blocks/blocks` depends on.
 */

import assert from 'node:assert';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const generateClientCli = fileURLToPath(new URL('../generate-client-cli.js', import.meta.url));

describe('blocks-generate-client', () => {
	it('generates the client of a TypeScript backend in an app without its own tsx', () => {
		// Under tmpdir() no node_modules is on the app's resolution path.
		const root = mkdtempSync(join(tmpdir(), 'blocks-generate-client-'));
		try {
			writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'no-tsx-app', type: 'module' }));
			mkdirSync(join(root, 'aws-blocks'));
			writeFileSync(
				join(root, 'aws-blocks', 'index.ts'),
				"export const api = { hello: async (): Promise<string> => 'hi' };\n",
			);
			const child = spawnSync(process.execPath, [generateClientCli], {
				cwd: root,
				encoding: 'utf-8',
				env: { ...process.env, NODE_OPTIONS: '' },
			});
			assert.strictEqual(child.status, 0, child.stderr);
			assert.match(readFileSync(join(root, 'aws-blocks', 'client.js'), 'utf-8'), /export const api = /);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});

/** A temporary app whose TypeScript backend is `backend`; removed after `body`. */
async function withApp(backend: string, body: (root: string) => void | Promise<void>): Promise<void> {
	const root = mkdtempSync(join(tmpdir(), 'blocks-generate-client-'));
	try {
		writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'app', type: 'module' }));
		mkdirSync(join(root, 'aws-blocks'));
		writeFileSync(join(root, 'aws-blocks', 'index.ts'), backend);
		await body(root);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

/** The environment of a `blocks-generate-client` run: no inherited log level or Node options. */
function generateEnv(env: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
	return { ...process.env, NODE_OPTIONS: '', BLOCKS_LOG_LEVEL: '', ...env };
}

function generate(root: string, env: NodeJS.ProcessEnv = {}) {
	return spawnSync(process.execPath, [generateClientCli], { cwd: root, encoding: 'utf-8', env: generateEnv(env) });
}

describe('blocks-generate-client output', () => {
	it('hides the warnings that importing the backend prints at BLOCKS_LOG_LEVEL=quiet', async () => {
		const backend = [
			"console.warn('[Realtime] BLOCKS_RT_WS_URL not set');",
			"export const api = { hello: async (): Promise<string> => 'hi' };",
			'',
		].join('\n');
		await withApp(backend, (root) => {
			const quiet = generate(root, { BLOCKS_LOG_LEVEL: 'quiet' });
			assert.strictEqual(quiet.status, 0, quiet.stderr);
			assert.doesNotMatch(quiet.stderr, /BLOCKS_RT_WS_URL/);
			assert.match(quiet.stdout, /wrote .*client\.js/);
			const normal = generate(root);
			assert.strictEqual(normal.status, 0, normal.stderr);
			assert.match(normal.stderr, /\[Realtime\] BLOCKS_RT_WS_URL not set/);
		});
	});

	it('reports a backend that does not load in one line and exits 1, with the stack only at debug', async () => {
		await withApp('export const api = {;\n', (root) => {
			const run = generate(root);
			assert.strictEqual(run.status, 1, run.stderr);
			assert.match(run.stderr, /^❌ Client generation failed: .*Transform failed/m);
			assert.doesNotMatch(run.stderr, /^\s+at /m);
			assert.doesNotMatch(run.stderr, /triggerUncaughtException/);
			const debug = generate(root, { BLOCKS_LOG_LEVEL: 'debug' });
			assert.strictEqual(debug.status, 1, debug.stderr);
			assert.match(debug.stderr, /^❌ Client generation failed: /m);
			assert.match(debug.stderr, /^\s+at /m);
		});
	});

	// On Windows a signal is TerminateProcess: no handler runs, so there is nothing to pass on.
	for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) {
		it(`passes a ${signal} sent to its pid alone on to the worker, and ends after it`, {
			skip: process.platform === 'win32',
		}, async () => {
			// The backend prints the worker's pid, then keeps the import pending. Its timer runs in
			// the worker, not here: it stands for a slow import that the signal must cut short.
			const backend = [
				'console.log(`worker ${process.pid}`);',
				'await new Promise((resolve) => setTimeout(resolve, 10_000));',
				"export const api = { hello: async (): Promise<string> => 'hi' };",
				'',
			].join('\n');
			await withApp(backend, async (root) => {
				const bin = spawn(process.execPath, [generateClientCli], {
					cwd: root,
					env: generateEnv(),
					stdio: ['ignore', 'pipe', 'ignore'],
				});
				const exited = once(bin, 'exit') as Promise<[number | null, NodeJS.Signals | null]>;
				let stdout = '';
				for await (const chunk of bin.stdout) {
					stdout += chunk;
					if (/worker \d+\n/.test(stdout)) break;
				}
				const worker = Number(/worker (\d+)\n/.exec(stdout)?.[1]);
				assert.ok(worker > 0, `the worker started: ${stdout}`);
				const started = Date.now();
				bin.kill(signal);
				const [code, ended] = await exited;
				assert.ok(Date.now() - started < 5000, 'it ended without waiting for the backend');
				assert.deepStrictEqual({ code, ended }, { code: null, ended: signal });
				assert.throws(() => process.kill(worker, 0), { code: 'ESRCH' }, 'the worker ended before the bin');
				assert.strictEqual(existsSync(join(root, 'aws-blocks', 'client.js')), false);
			});
		});
	}
});
