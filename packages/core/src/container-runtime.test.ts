// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * `runContainer()` boot and shutdown, run in a child process: it listens on the
 * container's fixed ports and installs SIGTERM/SIGINT handlers, neither of which
 * may touch the test runner. The child remaps those fixed ports to free ones the
 * test picked (so a busy 8080/8081 on the machine can't fail the suite), then
 * calls `runContainer()` exactly as the container image entry does.
 */

import assert from 'node:assert';
import { type ChildProcess, spawn } from 'node:child_process';
import * as http from 'node:http';
import * as net from 'node:net';
import { after, afterEach, describe, it } from 'node:test';
import { CONTAINER_HTTP_PORT, CONTAINER_READINESS_PORT } from './constants.js';

/** How long an in-flight call in the child takes, so a drain has something to wait for. */
const HOLD_MS = 5_000;

// ── Test plumbing ───────────────────────────────────────────────────────────

interface Reply {
	status: number;
	body: string;
}

function send(port: number, method: string, target: string, body?: string): Promise<Reply> {
	return new Promise((resolve, reject) => {
		const headers = body === undefined ? {} : { 'Content-Type': 'application/json' };
		const req = http.request({ host: '127.0.0.1', port, method, path: target, headers, agent: false }, (res) => {
			const chunks: Buffer[] = [];
			res.on('data', (c: Buffer) => chunks.push(c));
			res.on('end', () =>
				resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf-8') }),
			);
		});
		req.on('error', reject);
		if (body !== undefined) req.write(body);
		req.end();
	});
}

const rpc = (method: string, params: unknown[] = []) => JSON.stringify({ jsonrpc: '2.0', method, params, id: 1 });

/** Resolves with the connection error code (e.g. `ECONNREFUSED`), or `undefined` if a connection opened. */
function connectError(port: number): Promise<string | undefined> {
	return new Promise((resolve) => {
		const socket = net.connect(port, '127.0.0.1');
		socket.once('connect', () => {
			socket.destroy();
			resolve(undefined);
		});
		socket.once('error', (error: NodeJS.ErrnoException) => resolve(error.code ?? error.message));
	});
}

/** A port that is free right now (the OS picks it, the probe releases it). */
function freePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const probe = net.createServer();
		probe.once('error', reject);
		probe.listen(0, '0.0.0.0', () => {
			const { port } = probe.address() as net.AddressInfo;
			probe.close(() => resolve(port));
		});
	});
}

interface ContainerChild {
	process: ChildProcess;
	/** Where the child's API / health port (8080) and readiness port (8081) actually listen. */
	httpPort: number;
	readinessPort: number;
	/** Everything the child wrote to stdout and stderr so far. */
	output(): string;
	/** Resolves once the output contains `text`; fails after `timeoutMs`. */
	waitForOutput(text: string, timeoutMs?: number): Promise<void>;
	/** Resolves with the exit code once the child exits. */
	exited: Promise<number | null>;
}

const children: ChildProcess[] = [];

/**
 * Start `runContainer()` in a child process. With `serveApi`, it is given a stub
 * backend (an `api` namespace) as the image entry does for a compute that serves
 * API traffic; without it, it is called with no options.
 */
async function startContainer(serveApi: boolean): Promise<ContainerChild> {
	const httpPort = await freePort();
	const readinessPort = await freePort();
	const portMap = { [CONTAINER_HTTP_PORT]: httpPort, [CONTAINER_READINESS_PORT]: readinessPort };
	const runtimeUrl = new URL('./container-runtime.js', import.meta.url).href;
	const script = `
		import * as net from 'node:net';
		const portMap = ${JSON.stringify(portMap)};
		const listen = net.Server.prototype.listen;
		net.Server.prototype.listen = function (...args) {
			if (typeof args[0] === 'number' && portMap[args[0]] !== undefined) args[0] = portMap[args[0]];
			return listen.apply(this, args);
		};
		const { runContainer } = await import(${JSON.stringify(runtimeUrl)});
		const backend = {
			api: (ctx) => ({
				async echo(msg) {
					return { msg, url: ctx.request.url.href };
				},
				async hold(ms) {
					console.log('hold started');
					await new Promise((r) => setTimeout(r, ms));
					return { held: ms };
				},
			}),
		};
		await runContainer(${serveApi ? '{ backend }' : '{}'});
		console.log('runContainer resolved');
	`;
	// No AWS: no AsyncJob registers a poller, and no compute id is stamped.
	const env = { ...process.env };
	delete env.BLOCKS_SERVICE_MODE;
	delete env.BLOCKS_COMPUTE_ID;
	delete env.PORT;
	const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
		env,
		stdio: ['ignore', 'pipe', 'pipe'],
	});
	children.push(child);

	let output = '';
	const watchers: Array<() => void> = [];
	const onData = (chunk: Buffer) => {
		output += chunk.toString('utf-8');
		for (const check of watchers.slice()) check();
	};
	child.stdout?.on('data', onData);
	child.stderr?.on('data', onData);
	const exited = new Promise<number | null>((resolve) => child.once('exit', (code) => resolve(code)));

	const waitForOutput = (text: string, timeoutMs = 10_000) =>
		new Promise<void>((resolve, reject) => {
			const timer = setTimeout(() => {
				remove();
				reject(new Error(`timed out waiting for "${text}" — child output:\n${output}`));
			}, timeoutMs);
			const check = () => {
				if (!output.includes(text)) return;
				remove();
				resolve();
			};
			const remove = () => {
				clearTimeout(timer);
				const at = watchers.indexOf(check);
				if (at !== -1) watchers.splice(at, 1);
			};
			watchers.push(check);
			void exited.then(() => {
				if (!output.includes(text)) {
					remove();
					reject(new Error(`child exited before "${text}" — child output:\n${output}`));
				}
			});
			check();
		});

	const started = { process: child, httpPort, readinessPort, output: () => output, waitForOutput, exited };
	await waitForOutput('[Blocks container] parent up');
	return started;
}

afterEach(() => {
	for (const child of children.splice(0)) {
		if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
	}
});

after(() => {
	for (const child of children) child.kill('SIGKILL');
});

// ── Tests ────────────────────────────────────────────────────────────────────

describe('runContainer({ backend }) — serving the API', { timeout: 90_000 }, () => {
	it('dispatches a JSON-RPC call on the API port to the backend', async () => {
		const container = await startContainer(true);
		assert.match(container.output(), /api=on/);

		const reply = await send(container.httpPort, 'POST', '/aws-blocks/api/api', rpc('api.echo', ['hi']));
		assert.strictEqual(reply.status, 200, reply.body);
		const body = JSON.parse(reply.body);
		assert.strictEqual(body.error, undefined, reply.body);
		assert.strictEqual(body.result.msg, 'hi');
		assert.strictEqual(new URL(body.result.url).pathname, '/aws-blocks/api/api');
	});

	it('rejects a path naming a different namespace than the body', async () => {
		const container = await startContainer(true);
		const reply = await send(container.httpPort, 'POST', '/aws-blocks/api/other', rpc('api.echo', ['x']));
		const body = JSON.parse(reply.body);
		assert.strictEqual(body.error?.code, -32600, reply.body);
		assert.strictEqual(body.error?.data?.name, 'InvalidRequest');
	});

	it('reports ready on the readiness port, and the API port serves the API instead of the health check', async () => {
		const container = await startContainer(true);
		const ready = await send(container.readinessPort, 'GET', '/');
		assert.strictEqual(ready.status, 200);
		assert.deepStrictEqual(JSON.parse(ready.body), { status: 'ok' });

		// The health-only server answers any path with `{ status: 'ok', path }` on
		// this same port; in API mode the port is the API server instead.
		const probe = await send(container.httpPort, 'GET', '/health-probe');
		assert.notStrictEqual(probe.body, JSON.stringify({ status: 'ok', path: '/health-probe' }));
		assert.notStrictEqual(probe.status, 200, `the API server answered: ${probe.status} ${probe.body}`);
	});

	it('on SIGTERM reports not-ready, finishes the in-flight call, closes its ports, and exits cleanly', async () => {
		const container = await startContainer(true);
		const inFlight = send(container.httpPort, 'POST', '/aws-blocks/api/api', rpc('api.hold', [HOLD_MS]));
		await container.waitForOutput('hold started');

		const signalledAt = Date.now();
		container.process.kill('SIGTERM');
		await container.waitForOutput('SIGTERM received');

		// While the call drains, the load balancer's health check sees not-ready.
		const draining = await send(container.readinessPort, 'GET', '/');
		assert.strictEqual(draining.status, 503);
		assert.deepStrictEqual(JSON.parse(draining.body), { status: 'draining' });
		// No new connections are accepted on the API port.
		assert.ok(await connectError(container.httpPort), 'the API port no longer accepts connections');

		// The in-flight call still completes.
		const held = await inFlight;
		assert.strictEqual(held.status, 200, held.body);
		assert.deepStrictEqual(JSON.parse(held.body).result, { held: HOLD_MS });

		// Once drained, runContainer returns and both ports are closed.
		await container.waitForOutput('runContainer resolved');
		assert.strictEqual(await connectError(container.httpPort), 'ECONNREFUSED');
		assert.strictEqual(await connectError(container.readinessPort), 'ECONNREFUSED');

		const code = await container.exited;
		assert.strictEqual(code, 0, container.output());
		const elapsed = Date.now() - signalledAt;
		assert.ok(elapsed < HOLD_MS + 10_000, `exited ${elapsed}ms after SIGTERM`);
	});
});

describe('runContainer() — no backend', { timeout: 30_000 }, () => {
	it('answers the health check on port 8080 and opens no readiness port', async () => {
		const container = await startContainer(false);
		assert.match(container.output(), /api=off/);

		const health = await send(container.httpPort, 'GET', '/health-probe');
		assert.strictEqual(health.status, 200);
		assert.deepStrictEqual(JSON.parse(health.body), { status: 'ok', path: '/health-probe' });
		assert.strictEqual(await connectError(container.readinessPort), 'ECONNREFUSED');
	});
});
