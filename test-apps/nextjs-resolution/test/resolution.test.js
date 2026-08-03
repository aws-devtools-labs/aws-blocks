// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Tripwire for Blocks' dependence on Node conditional exports under Next.js.
 *
 * Runs against the standalone output (the deployed shape) rather than `next dev`,
 * and asserts the exact condition each Next.js graph resolves. If a Next.js or
 * bundler upgrade changes any of this, the whole Next-native programming model
 * silently breaks — so these assertions are deliberately exact, not "contains".
 *
 * Prerequisite: `next build` (see the `test:e2e:local` script).
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const APP_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
// `outputFileTracingRoot` is pinned to the repo root in next.config.ts, so the
// standalone tree mirrors the app's path relative to it.
const STANDALONE_DIR = join(APP_DIR, '.next/standalone/test-apps/nextjs-resolution');
const PORT = 3247;
const BASE = `http://127.0.0.1:${PORT}`;

/** Read the compiled Server Action id so the action can be invoked over HTTP. */
function readServerActionId() {
	const manifest = JSON.parse(
		readFileSync(join(STANDALONE_DIR, '.next/server/app/page/server-reference-manifest.json'), 'utf-8'),
	);
	// Shape has shifted across Next versions: the export name sits on the entry
	// itself and/or on each per-route record under `workers`. Accept either.
	const isProbe = (ref) =>
		ref?.exportedName === 'probeAction' ||
		Object.values(ref?.workers ?? {}).some((w) => w?.exportedName === 'probeAction');

	const found = Object.entries(manifest.node ?? {}).find(([, ref]) => isProbe(ref));
	assert.ok(found, 'probeAction not found in the server reference manifest');
	return found[0];
}

async function waitForReady(timeoutMs = 60_000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		try {
			if ((await fetch(BASE, { signal: AbortSignal.timeout(2000) })).ok) return;
		} catch {
			// not up yet
		}
		await new Promise((r) => setTimeout(r, 500));
	}
	throw new Error(`standalone server did not become ready on ${BASE}`);
}

/** Extract `<p id="x">x=VALUE</p>` from the rendered HTML. */
function marker(html, id) {
	const m = html.match(new RegExp(`<p id="${id}">[^<]*?=(?:<!-- -->)?([^<]*)</p>`));
	assert.ok(m, `no #${id} marker in rendered HTML`);
	return m[1].trim();
}

function json(html, id) {
	return JSON.parse(marker(html, id).replaceAll('&quot;', '"').replaceAll('&amp;', '&'));
}

describe('Next.js export-condition resolution', () => {
	let server;
	let html;
	let actionId;

	before(async () => {
		// PGlite leaves a postmaster.pid behind if a previous run was killed; a stale
		// lock makes the WASM runtime abort instead of recovering.
		for (const dir of [APP_DIR, STANDALONE_DIR]) {
			rmSync(join(dir, '.bb-data'), { recursive: true, force: true });
		}
		actionId = readServerActionId();
		server = spawn('node', ['server.js'], {
			cwd: STANDALONE_DIR,
			env: { ...process.env, PORT: String(PORT), HOSTNAME: '127.0.0.1' },
			stdio: 'inherit',
		});
		await waitForReady();
		html = await (await fetch(BASE)).text();
	});

	after(() => {
		server?.kill('SIGTERM');
	});

	it('resolves `react-server` in a Server Component', () => {
		assert.equal(marker(html, 'rsc'), 'cond:react-server:REAL-BACKEND');
	});

	it('resolves `import` — not `browser` — in the SSR pass of a Client Component', () => {
		// If this ever becomes `browser`, an export map that points `browser` at the
		// RPC client and `default` at the real backend would hand Client Components
		// the real backend during SSR: a server crash and a hydration mismatch.
		assert.equal(marker(html, 'client'), 'cond:import');
	});

	it('resolves `browser` in the browser bundle', () => {
		// Scan the built client chunks on disk rather than the ones referenced in the
		// initial HTML: in a production build the page's client chunk is loaded lazily
		// via the RSC payload, so it never appears as a `<script src>`.
		//
		// Production chunks are minified, so the `MARKER` identifier is gone — match
		// the string literal, which survives.
		const chunkDir = join(APP_DIR, '.next/static');
		const files = readdirSync(chunkDir, { recursive: true, encoding: 'utf-8' }).filter((f) => f.endsWith('.js'));
		assert.ok(files.length > 0, `no client chunks found under ${chunkDir}`);

		const markers = new Set(
			files.flatMap((f) => [...readFileSync(join(chunkDir, f), 'utf-8').matchAll(/cond:[a-z-]+/g)].map((m) => m[0])),
		);
		assert.ok(markers.size > 0, 'no client chunk contained a cond: marker');
		assert.deepEqual([...markers], ['cond:browser'], `browser bundle resolved ${[...markers]}`);
	});

	it('resolves `react-server` in a route handler', async () => {
		const body = await (await fetch(`${BASE}/api/probe`)).json();
		assert.equal(body.context, 'route-handler');
		assert.equal(body.marker, 'cond:react-server:REAL-BACKEND');
	});

	it('resolves `react-server` in a Server Action', async () => {
		const res = await fetch(BASE, {
			method: 'POST',
			headers: { 'Next-Action': actionId, 'Content-Type': 'text/plain;charset=UTF-8' },
			body: '[]',
		});
		const text = (await res.text()).replaceAll('\u0000', '');
		assert.match(text, /"context":"server-action"/);
		assert.match(text, /"marker":"cond:react-server:REAL-BACKEND"/);
	});

	it('round-trips a KVStore in process from a Server Component', () => {
		assert.deepEqual(json(html, 'kv'), { wrote: true, read: { ok: true } });
	});

	it('round-trips a PGlite-backed Database in process from a Server Component', () => {
		// Guards the `serverExternalPackages` recipe. Without it both Turbopack and
		// webpack rewrite PGlite's `new URL(..., import.meta.url)` WASM asset load
		// and this throws with an "instance of URL" TypeError.
		const db = json(html, 'db');
		assert.equal(db.latest.text, 'hello from the server');
		assert.ok(db.count >= 1, `expected at least one row, got ${db.count}`);
	});
});
