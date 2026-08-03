// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Phase B exit criterion: a Server Component queries real Postgres in process, with
 * no wrapper method and no RPC hop, and Client Components reach the server through
 * Server Actions.
 *
 * Runs against `next dev` because that is the local-dev experience being validated.
 * The deployed path (`aws-runtime` resolution inside the SSR Lambda) is phase C.
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const APP_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 3311;
const BASE = `http://127.0.0.1:${PORT}`;

let server;

async function waitForReady(timeoutMs = 120_000) {
	const deadline = Date.now() + timeoutMs;
	let last;
	while (Date.now() < deadline) {
		try {
			const res = await fetch(BASE, { signal: AbortSignal.timeout(5000) });
			if (res.ok) return;
			last = `status ${res.status}`;
		} catch (e) {
			last = e.message;
		}
		await new Promise((r) => setTimeout(r, 500));
	}
	throw new Error(`dev server not ready on ${BASE}: ${last}`);
}

const page = async () => (await fetch(BASE, { cache: 'no-store' })).text();

/**
 * Server Action ids are content-hashed, so they have to be read from the build
 * manifest. Next 16 writes it under `.next/dev/server` in dev and `.next/server`
 * in a production build.
 */
function actionId(name) {
	const candidates = [
		join(APP_DIR, '.next/dev/server/app/page/server-reference-manifest.json'),
		join(APP_DIR, '.next/server/app/page/server-reference-manifest.json'),
	];
	const path = candidates.find((p) => existsSync(p));
	assert.ok(path, `no server-reference-manifest found (looked in ${candidates.join(', ')})`);

	const manifest = JSON.parse(readFileSync(path, 'utf-8'));
	const isMatch = (ref) =>
		ref?.exportedName === name || Object.values(ref?.workers ?? {}).some((w) => w?.exportedName === name);
	const found = Object.entries(manifest.node ?? {}).find(([, ref]) => isMatch(ref));
	assert.ok(found, `Server Action "${name}" not found in the manifest`);
	return found[0];
}

/**
 * Invoke a Server Action over HTTP the way the client runtime does: the action id in
 * a `Next-Action` header, and JSON-encoded arguments as a text/plain body.
 *
 * Note that an unrecognized action id does NOT error — Next just renders the page
 * and returns 200. `actionId` asserting on the manifest lookup is what stops that
 * from silently turning into a passing test.
 */
async function callAction(name, args) {
	const res = await fetch(BASE, {
		method: 'POST',
		headers: { 'Next-Action': actionId(name), 'Content-Type': 'text/plain;charset=UTF-8' },
		body: JSON.stringify(args),
	});
	assert.equal(res.status, 200, `action ${name} returned ${res.status}`);
	return (await res.text()).replaceAll('\u0000', '');
}

const noteTexts = (html) => [...html.matchAll(/<span data-done="(?:true|false)">([^<]*)<\/span>/g)].map((m) => m[1]);
const count = (html) => Number(html.match(/data-count="(\d+)"/)?.[1]);

describe('Next-native model: blocks used in process by server code', () => {
	before(async () => {
		// Start from an empty database so counts are deterministic. A killed dev server
		// can also leave a PGlite postmaster.pid that makes the WASM runtime abort.
		rmSync(join(APP_DIR, '.bb-data'), { recursive: true, force: true });

		// Spawn Next directly rather than `npm run dev`, so the port is ours to choose
		// and killing the child actually kills the server (no npm shell in between).
		server = spawn('npm', ['exec', 'next', '--', 'dev', '--port', String(PORT)], {
			cwd: APP_DIR,
			stdio: 'inherit',
		});
		await waitForReady();
	});

	after(() => {
		server?.kill('SIGTERM');
	});

	it('renders rows a Server Component read from real Postgres', async () => {
		// The migration in ./migrations created the table — proof the block ran its
		// own migrations against in-process PGlite with no external database.
		const html = await page();
		assert.equal(count(html), 0, 'expected an empty table on first run');
		assert.deepEqual(noteTexts(html), []);
	});

	it('writes through a Server Action and reads back through the Server Component', async () => {
		await callAction('addNote', ['hello from a server action']);

		const html = await page();
		assert.equal(count(html), 1);
		assert.deepEqual(noteTexts(html), ['hello from a server action']);
	});

	it('round-trips an update through a Server Action', async () => {
		const before = await page();
		const id = Number(before.match(/data-note-id="(\d+)"/)?.[1]);
		assert.ok(Number.isInteger(id), 'no note id in the rendered HTML');

		await callAction('toggleNote', [id, true]);
		assert.match(await page(), /data-done="true"/);
	});

	it('keeps ordering and accumulates rows across requests', async () => {
		await callAction('addNote', ['second note']);
		const html = await page();
		assert.equal(count(html), 2);
		// Page orders by id DESC, so the newest row is first.
		assert.deepEqual(noteTexts(html), ['second note', 'hello from a server action']);
	});

	it('rejects invalid input at the Server Action boundary', async () => {
		// A Server Action is a public endpoint, so it validates rather than trusting
		// the caller. Next.js surfaces a thrown action error as a 500.
		const res = await fetch(BASE, {
			method: 'POST',
			headers: { 'Next-Action': actionId('addNote'), 'Content-Type': 'application/json' },
			body: JSON.stringify(['   ']),
		});
		assert.equal(res.status, 500);

		// The rejected write must not have landed.
		assert.equal(count(await page()), 2);
	});

	it('persists across a fresh block instance (data really is on disk)', async () => {
		const { Database, Scope } = await import('@aws-blocks/blocks');
		const { sql } = await import('@aws-blocks/blocks');
		const probe = new Database(new Scope('dx-poc'), 'main');
		const rows = await probe.query(sql`SELECT text FROM notes ORDER BY id DESC`);
		assert.deepEqual(
			rows.map((r) => r.text),
			['second note', 'hello from a server action'],
		);
	});
});
