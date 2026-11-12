// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert';
import { createServer, type Server } from 'node:net';
import { afterEach, describe, it } from 'node:test';

import { findFreePort, isPortFree, NoFreePortError } from './port-scan.js';

const HOSTNAME = '127.0.0.1';

/** Every server opened by a test, torn down in afterEach. */
const openServers: Server[] = [];

/** Binds a real listening server to `port` so the scanner must skip it. */
function occupy(port: number): Promise<void> {
	return new Promise((resolve, reject) => {
		const server = createServer();
		openServers.push(server);
		server.once('error', reject);
		server.listen(port, HOSTNAME, () => resolve());
	});
}

/**
 * Finds `length` consecutive ports that are currently free, so a test can
 * occupy them deterministically. Starts from a random high base to keep
 * concurrent test files from colliding.
 */
async function findFreeRange(length: number): Promise<number> {
	let candidate = 47_000 + Math.floor(Math.random() * 2_000);
	for (let guard = 0; guard < 200; guard++) {
		let allFree = true;
		for (let offset = 0; offset < length; offset++) {
			if (!(await isPortFree(candidate + offset, HOSTNAME))) {
				allFree = false;
				break;
			}
		}
		if (allFree) return candidate;
		candidate += length;
	}
	throw new Error(`could not find ${length} consecutive free ports for the test`);
}

afterEach(async () => {
	await Promise.all(
		openServers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
	);
});

describe('isPortFree', () => {
	it('reports a free port as free', async () => {
		const port = await findFreeRange(1);
		assert.strictEqual(await isPortFree(port, HOSTNAME), true);
	});

	it('reports an occupied port as not free', async () => {
		const port = await findFreeRange(1);
		await occupy(port);
		assert.strictEqual(await isPortFree(port, HOSTNAME), false);
	});

	it('resolves false rather than rejecting on an unbindable port', async () => {
		// Port 1 is privileged; a non-root test run cannot bind it. Either way
		// the contract is a boolean, never a rejection.
		assert.strictEqual(typeof (await isPortFree(1, HOSTNAME)), 'boolean');
	});
});

describe('findFreePort', () => {
	it('finds a free port and returns it', async () => {
		const start = await findFreeRange(1);
		const port = await findFreePort({ start, attempts: 1, hostname: HOSTNAME });
		assert.strictEqual(port, start);
	});

	it('stays inside the scanned range with the default attempt count', async () => {
		const start = await findFreeRange(1);
		const port = await findFreePort({ start, hostname: HOSTNAME });
		assert.ok(port >= start && port < start + 20, `${port} outside ${start}..${start + 19}`);
	});

	it('skips a port occupied by a real listening server and returns the next one', async () => {
		const start = await findFreeRange(2);
		await occupy(start);
		const port = await findFreePort({ start, attempts: 2, hostname: HOSTNAME });
		assert.strictEqual(port, start + 1);
	});

	it('throws NoFreePortError when the whole range is busy', async () => {
		const start = await findFreeRange(2);
		await occupy(start);
		await occupy(start + 1);

		await assert.rejects(
			() => findFreePort({ start, attempts: 2, hostname: HOSTNAME }),
			(error: unknown) => {
				assert.ok(error instanceof NoFreePortError, 'expected a NoFreePortError');
				assert.strictEqual(error.name, 'NoFreePortError');
				assert.strictEqual(error.start, start);
				assert.strictEqual(error.attempts, 2);
				assert.match(error.message, new RegExp(`${start}-${start + 1}`));
				assert.match(error.message, /--port/);
				return true;
			},
		);
	});
});
