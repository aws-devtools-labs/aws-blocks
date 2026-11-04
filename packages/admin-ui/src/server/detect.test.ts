// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import {
	DEFAULT_LOCAL_PORT,
	detectLocalDevServer,
	localBlocksUrl,
	parseNamespacesFromRpcError,
	resolveLocalPort,
	stackNameCandidates,
} from './detect.js';

let tmpDir: string | undefined;

/** A temp project tree. Keys are project-relative paths; dirs are created. */
function makeProject(files: Record<string, string>): string {
	tmpDir = join(tmpdir(), `admin-ui-detect-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(tmpDir, { recursive: true });
	for (const [rel, content] of Object.entries(files)) {
		const full = join(tmpDir, rel);
		mkdirSync(join(full, '..'), { recursive: true });
		writeFileSync(full, content);
	}
	return tmpDir;
}

afterEach(() => {
	if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
	tmpDir = undefined;
});

/** A fetch stand-in. Tests never touch a socket, not even loopback. */
function stubFetch(handler: (url: string) => Promise<Response> | Response): typeof fetch {
	return ((input: string | URL | Request) => {
		const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
		return Promise.resolve(handler(url));
	}) as typeof fetch;
}

function jsonResponse(body: unknown, init?: ResponseInit): Response {
	return new Response(JSON.stringify(body), {
		status: 200,
		headers: { 'content-type': 'application/json' },
		...init,
	});
}

describe('resolveLocalPort', () => {
	it('reads the port out of aws-blocks/scripts/server.ts', () => {
		const root = makeProject({
			'aws-blocks/scripts/server.ts': 'startDevServer({\n\tbackendPath: x,\n\tport: 4321,\n});\n',
		});
		assert.deepStrictEqual(resolveLocalPort(root), { port: 4321, source: 'server-script' });
	});

	it('falls back to the default with source "default" when server.ts names no port', () => {
		const root = makeProject({ 'aws-blocks/scripts/server.ts': 'startDevServer({ backendPath: x });\n' });
		assert.deepStrictEqual(resolveLocalPort(root), { port: DEFAULT_LOCAL_PORT, source: 'default' });
	});

	it('falls back when the port value is out of range', () => {
		const root = makeProject({ 'aws-blocks/scripts/server.ts': 'startDevServer({ port: 99999 });\n' });
		assert.deepStrictEqual(resolveLocalPort(root), { port: DEFAULT_LOCAL_PORT, source: 'default' });
	});

	it('falls back when there is no server.ts at all, and does not throw', () => {
		const root = makeProject({});
		assert.deepStrictEqual(resolveLocalPort(root), { port: DEFAULT_LOCAL_PORT, source: 'default' });
	});

	it('reports source "default" even when server.ts really says 3000 — the number alone is ambiguous', () => {
		const root = makeProject({ 'aws-blocks/scripts/server.ts': 'startDevServer({ port: 3000 });\n' });
		const resolved = resolveLocalPort(root);
		assert.strictEqual(resolved.port, DEFAULT_LOCAL_PORT);
		assert.strictEqual(
			resolved.source,
			'server-script',
			'a discovered 3000 is not the same fact as a fallback 3000',
		);
	});
});

describe('localBlocksUrl', () => {
	it('builds the loopback base URL from the resolved port', () => {
		const root = makeProject({ 'aws-blocks/scripts/server.ts': 'startDevServer({ port: 4400 });\n' });
		assert.strictEqual(localBlocksUrl(root), 'http://localhost:4400');
	});
});

describe('parseNamespacesFromRpcError', () => {
	it('extracts the namespace list', () => {
		assert.deepStrictEqual(parseNamespacesFromRpcError("API 'x' not found. Available: api, admin"), [
			'api',
			'admin',
		]);
	});

	it('returns [] when the message carries no list', () => {
		assert.deepStrictEqual(parseNamespacesFromRpcError('Internal error'), []);
		assert.deepStrictEqual(parseNamespacesFromRpcError(''), []);
	});

	it('degrades to [] on a malformed list rather than inventing entries', () => {
		assert.deepStrictEqual(parseNamespacesFromRpcError('Available:'), []);
		assert.deepStrictEqual(parseNamespacesFromRpcError('Available: , , '), []);
	});

	it('strips trailing punctuation from the last entry', () => {
		assert.deepStrictEqual(parseNamespacesFromRpcError('Available: api, admin.'), ['api', 'admin']);
	});
});

describe('stackNameCandidates', () => {
	it('derives the production candidate from .blocks/config.json stackId', () => {
		const root = makeProject({ '.blocks/config.json': JSON.stringify({ stackId: 'my-app-abc123' }) });
		assert.deepStrictEqual(stackNameCandidates(root), ['my-app-abc123-prod']);
	});

	it('adds the sandbox candidate when a sandbox id exists', () => {
		const root = makeProject({
			'.blocks/config.json': JSON.stringify({ stackId: 'my-app-abc123' }),
			'.blocks-sandbox/sandbox-id.txt': 'dev-jane\n',
		});
		assert.deepStrictEqual(stackNameCandidates(root), ['my-app-abc123-prod', 'my-app-abc123-dev-jane']);
	});

	it('ignores an empty sandbox id file', () => {
		const root = makeProject({
			'.blocks/config.json': JSON.stringify({ stackId: 'my-app-abc123' }),
			'.blocks-sandbox/sandbox-id.txt': '   \n',
		});
		assert.deepStrictEqual(stackNameCandidates(root), ['my-app-abc123-prod']);
	});

	it('falls back to the package.json name when there is no config.json', () => {
		const root = makeProject({ 'package.json': JSON.stringify({ name: 'my-app' }) });
		assert.deepStrictEqual(stackNameCandidates(root), ['my-app-prod']);
	});

	it('falls back to the package name when config.json is corrupt', () => {
		const root = makeProject({
			'.blocks/config.json': '{ not json',
			'package.json': JSON.stringify({ name: 'my-app' }),
		});
		assert.deepStrictEqual(stackNameCandidates(root), ['my-app-prod']);
	});

	// REGRESSION: an unguarded package.json parse rejected the whole cloud probe
	// instead of producing a status, so a mid-edit package.json blanked the report.
	it('returns [] and does not throw when package.json is corrupt', () => {
		const root = makeProject({ 'package.json': '{ "name": ' });
		assert.doesNotThrow(() => stackNameCandidates(root));
		assert.deepStrictEqual(stackNameCandidates(root), []);
	});

	it('returns [] when nothing identifies the project', () => {
		assert.deepStrictEqual(stackNameCandidates(makeProject({})), []);
	});

	it('ignores a non-string stackId', () => {
		const root = makeProject({ '.blocks/config.json': JSON.stringify({ stackId: 42 }) });
		assert.deepStrictEqual(stackNameCandidates(root), []);
	});
});

describe('detectLocalDevServer', () => {
	it('reports the server up and mines the namespace list', async () => {
		const root = makeProject({ 'aws-blocks/scripts/server.ts': 'startDevServer({ port: 4400 });\n' });
		const seen: string[] = [];
		const status = await detectLocalDevServer(
			root,
			stubFetch((url) => {
				seen.push(url);
				return jsonResponse({
					jsonrpc: '2.0',
					id: 1,
					error: { code: -32601, message: "API '__blocksDashboardProbe__' not found. Available: api, admin" },
				});
			}),
		);
		assert.deepStrictEqual(seen, ['http://localhost:4400/aws-blocks/api']);
		assert.strictEqual(status.serverUp, true);
		assert.strictEqual(status.serverUrl, 'http://localhost:4400');
		assert.strictEqual(status.port, 4400);
		assert.strictEqual(status.portSource, 'server-script');
		assert.deepStrictEqual(status.namespaces, ['api', 'admin']);
	});

	it('reports up with no namespaces when the body is not a JSON-RPC error', async () => {
		const root = makeProject({});
		const status = await detectLocalDevServer(
			root,
			stubFetch(() => new Response('<html>hi</html>', { status: 200 })),
		);
		assert.strictEqual(status.serverUp, true);
		assert.deepStrictEqual(status.namespaces, []);
	});

	it('reports the server down on a non-ok response', async () => {
		const root = makeProject({});
		const status = await detectLocalDevServer(
			root,
			stubFetch(() => new Response('nope', { status: 502 })),
		);
		assert.strictEqual(status.serverUp, false);
		assert.deepStrictEqual(status.namespaces, []);
		assert.strictEqual(status.port, DEFAULT_LOCAL_PORT);
		assert.strictEqual(status.portSource, 'default');
	});

	it('swallows a network error into serverUp: false', async () => {
		const root = makeProject({});
		const status = await detectLocalDevServer(root, () => Promise.reject(new Error('ECONNREFUSED')));
		assert.strictEqual(status.serverUp, false);
	});

	it('swallows an abort/timeout into serverUp: false', async () => {
		const root = makeProject({});
		const status = await detectLocalDevServer(root, () => {
			const error = new Error('The operation was aborted due to timeout');
			error.name = 'TimeoutError';
			return Promise.reject(error);
		});
		assert.strictEqual(status.serverUp, false);
	});

	it('reports .bb-data independently of the server state', async () => {
		const withData = makeProject({ '.bb-data/marker': 'x' });
		const down = await detectLocalDevServer(withData, () => Promise.reject(new Error('ECONNREFUSED')));
		assert.strictEqual(down.serverUp, false);
		assert.strictEqual(down.bbDataPresent, true, '.bb-data survives the server being stopped');
		rmSync(withData, { recursive: true, force: true });

		const withoutData = makeProject({});
		const up = await detectLocalDevServer(
			withoutData,
			stubFetch(() => jsonResponse({ jsonrpc: '2.0', id: 1 })),
		);
		assert.strictEqual(up.serverUp, true);
		assert.strictEqual(up.bbDataPresent, false);
	});
});
