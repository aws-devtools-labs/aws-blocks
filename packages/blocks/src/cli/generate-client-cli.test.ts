// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * `blocks generate client` runs `blocks-generate-client`. In an app that does not
 * install `tsx` itself (pnpm, or npm without hoisting), it loads the worker with
 * the `tsx` that `@aws-blocks/blocks` depends on.
 */

import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
});
