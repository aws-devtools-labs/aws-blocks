// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The local dev server survives an unhandled rejection from request handling
 * (a guard called without `await`), logs it with the method and a hint, and
 * keeps serving. A rejection outside any request still ends the process, as
 * Node's default does.
 */

import assert from 'node:assert';
import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { formatUnhandledRejection } from './dev-unhandled-rejection.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

async function getAvailablePort(): Promise<number> {
	const server = createServer();
	await new Promise<void>((resolve, reject) => {
		server.once('error', reject);
		server.listen(0, '127.0.0.1', resolve);
	});
	const address = server.address();
	assert.ok(address && typeof address === 'object');
	const { port } = address;
	await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
	return port;
}

/** A backend whose `leaky` method calls a rejecting guard without `await`, like `auth.requireRole(context, 'admin')`. */
const BACKEND = `
class NotAuthenticatedException extends Error { name = 'NotAuthenticatedException'; }
async function requireRole() {
  await new Promise((r) => setTimeout(r, 20));
  throw new NotAuthenticatedException('Authentication required');
}
export const testApi = {
  leaky: async () => { requireRole(); return { adminOnly: 'data' }; },
  ping: async () => 'pong',
};
`;

describe('dev server: unhandled rejections from request handling', () => {
	let devProcess: ChildProcess | null = null;
	let tempDir = '';
	let output = { stdout: '', stderr: '' };

	beforeEach(() => {
		devProcess = null;
		output = { stdout: '', stderr: '' };
		tempDir = join(tmpdir(), `dev-unhandled-test-${process.pid}-${Date.now()}`);
		mkdirSync(tempDir, { recursive: true });
		writeFileSync(join(tempDir, 'backend.ts'), BACKEND);
	});

	afterEach(async () => {
		if (devProcess && devProcess.exitCode === null) {
			devProcess.kill('SIGTERM');
			await new Promise<void>((resolve) => {
				const timeout = setTimeout(() => {
					devProcess?.kill('SIGKILL');
					resolve();
				}, 2_000);
				devProcess?.once('exit', () => {
					clearTimeout(timeout);
					resolve();
				});
			});
		}
		if (tempDir) rmSync(tempDir, { recursive: true, force: true });
	});

	function start(port: number) {
		writeFileSync(
			join(tempDir, 'run-dev.ts'),
			`
import { startDevServer } from ${JSON.stringify(join(__dirname, 'dev-server.js'))};
startDevServer(${JSON.stringify({ backendPath: join(tempDir, 'backend.ts'), port, typegen: false })});
`,
		);
		const tsxBin = join(__dirname, '..', '..', '..', '..', 'node_modules', '.bin', 'tsx');
		devProcess = spawn(tsxBin, [join(tempDir, 'run-dev.ts')], {
			cwd: tempDir,
			env: { ...process.env, AWS_BLOCKS_DISABLE_TELEMETRY: '1', BLOCKS_DEV_QUIET: '1' },
			stdio: ['ignore', 'pipe', 'pipe'],
		});
		devProcess.stdout?.on('data', (chunk) => {
			output.stdout += chunk.toString();
		});
		devProcess.stderr?.on('data', (chunk) => {
			output.stderr += chunk.toString();
		});
	}

	async function rpc(port: number, method: string): Promise<Record<string, unknown>> {
		const deadline = Date.now() + 15_000;
		let lastError: unknown;
		while (Date.now() < deadline) {
			try {
				const response = await fetch(`http://127.0.0.1:${port}/aws-blocks/api`, {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ jsonrpc: '2.0', method, params: [], id: 1 }),
					signal: AbortSignal.timeout(1_000),
				});
				return (await response.json()) as Record<string, unknown>;
			} catch (error) {
				lastError = error;
			}
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
		assert.fail(
			`dev server did not answer ${method}: ${String(lastError)}\nstdout: ${output.stdout}\nstderr: ${output.stderr}`,
		);
	}

	it('logs the rejection with the method name and a missing-await hint, and keeps serving', async () => {
		const port = await getAvailablePort();
		start(port);
		const leaky = await rpc(port, 'testApi.leaky');
		assert.deepStrictEqual(leaky.result, { adminOnly: 'data' });

		const deadline = Date.now() + 5_000;
		while (!output.stderr.includes('[unhandled-rejection]') && Date.now() < deadline) {
			await new Promise((resolve) => setTimeout(resolve, 25));
		}
		assert.match(
			output.stderr,
			/\[unhandled-rejection\] testApi\.leaky: NotAuthenticatedException: Authentication required/,
		);
		assert.match(output.stderr, /await auth\.requireRole/, 'names the likely fix');
		assert.match(output.stderr, /already returned/, 'says the response went out without waiting');
		assert.match(output.stderr, /at requireRole/, 'keeps the stack');

		// Still serving: the process did not exit.
		assert.strictEqual(devProcess?.exitCode, null, `dev server exited.\nstderr: ${output.stderr}`);
		const ping = await rpc(port, 'testApi.ping');
		assert.strictEqual(ping.result, 'pong');
	});
});

describe('installDevRejectionHandler', () => {
	function run(body: string): { status: number | null; stderr: string } {
		const moduleUrl = JSON.stringify(new URL('./dev-unhandled-rejection.js', import.meta.url).href);
		const r = spawnSync(
			process.execPath,
			[
				'--input-type=module',
				'-e',
				`
import { installDevRejectionHandler, runDevRequest } from ${moduleUrl};
installDevRejectionHandler();
${body}
`,
			],
			{ encoding: 'utf8', timeout: 10_000 },
		);
		return { status: r.status, stderr: r.stderr };
	}

	it('a rejection from a request is logged and the process lives on', () => {
		const r = run(`await runDevRequest('api.leaky', async () => { Promise.reject(new Error('late')); return 1; });
setTimeout(() => console.error('still alive'), 50);`);
		assert.strictEqual(r.status, 0, r.stderr);
		assert.match(r.stderr, /\[unhandled-rejection\] api\.leaky: Error: late/);
		assert.match(r.stderr, /still alive/);
	});

	it('a rejection outside any request still ends the process (not swallowed)', () => {
		const r = run(`Promise.reject(new Error('boot failure'));`);
		assert.notStrictEqual(r.status, 0);
		assert.match(r.stderr, /boot failure/);
		assert.doesNotMatch(r.stderr, /\[unhandled-rejection\]/);
	});
});

describe('formatUnhandledRejection', () => {
	it('names the request, the error and the guard hint; keeps the stack', () => {
		const e = new Error('Not in group admin');
		e.name = 'NotAuthorizedException';
		const text = formatUnhandledRejection(e, { label: 'api.listUsers', returned: false });
		assert.match(text, /^\[unhandled-rejection\] api\.listUsers: NotAuthorizedException: Not in group admin/);
		assert.match(text, /await/);
		assert.doesNotMatch(text, /already returned/);
		assert.match(text, /at /, 'stack included');
	});

	it('describes a non-Error reason without throwing', () => {
		const text = formatUnhandledRejection('plain string', { label: 'GET /hook', returned: true });
		assert.match(text, /^\[unhandled-rejection\] GET \/hook: "plain string"/);
		assert.match(text, /already returned/);
	});
});
