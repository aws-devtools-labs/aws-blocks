// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Phase F exit criterion: a browser reads and writes a table with no hand-written
 * endpoint, and Row Level Security decides which rows it can touch.
 *
 * Exercises the real HTTP surface — one endpoint, `/api/data` — because that is what a
 * browser (or an attacker) actually talks to.
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const APP_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 3312;
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

/** Post a query description as `user`, or anonymously when user is null. */
async function query(user, description) {
	const res = await fetch(`${BASE}/api/data`, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			...(user ? { 'x-blocks-dev-user': user } : {}),
		},
		body: JSON.stringify(description),
	});
	return { status: res.status, body: await res.json() };
}

async function expectOk(user, description) {
	const { status, body } = await query(user, description);
	assert.equal(status, 200, `expected 200, got ${status}: ${JSON.stringify(body)}`);
	return body;
}

describe('browser-direct data API', () => {
	before(async () => {
		rmSync(join(APP_DIR, '.bb-data'), { recursive: true, force: true });
		server = spawn('npm', ['exec', 'next', '--', 'dev', '--port', String(PORT)], {
			cwd: APP_DIR,
			stdio: 'inherit',
		});
		await waitForReady();
	});

	after(() => {
		server?.kill('SIGTERM');
	});

	it('refuses an unauthenticated caller with 401', async () => {
		// There is no anonymous mode. This is the difference from an anon-key model,
		// where a table without RLS is readable by anyone holding a public key.
		const { status, body } = await query(null, { table: 'notes', operation: 'select' });
		assert.equal(status, 401);
		assert.equal(body.error, 'NotAuthenticatedException');
	});

	it('reads and writes with no endpoint written per query', async () => {
		const inserted = await expectOk('alice', {
			table: 'notes',
			operation: 'insert',
			values: { text: 'from the browser' },
		});
		assert.equal(inserted[0].text, 'from the browser');
		// The policy's WITH CHECK forced ownership to the caller's claims.
		assert.equal(inserted[0].owner, 'alice');

		const rows = await expectOk('alice', { table: 'notes', operation: 'select', columns: ['text'] });
		assert.deepEqual(rows, [{ text: 'from the browser' }]);
	});

	it('isolates rows between callers through RLS', async () => {
		await expectOk('bob', { table: 'notes', operation: 'insert', values: { text: "bob's note" } });

		const bobRows = await expectOk('bob', { table: 'notes', operation: 'select', columns: ['text'] });
		assert.deepEqual(bobRows, [{ text: "bob's note" }]);

		const aliceRows = await expectOk('alice', { table: 'notes', operation: 'select', columns: ['text'] });
		assert.deepEqual(aliceRows, [{ text: 'from the browser' }]);
	});

	it("cannot delete another caller's row even by id", async () => {
		const [aliceRow] = await expectOk('alice', { table: 'notes', operation: 'select', columns: ['id'] });

		const deleted = await expectOk('bob', {
			table: 'notes',
			operation: 'delete',
			filters: [{ column: 'id', operator: 'eq', value: aliceRow.id }],
		});
		assert.deepEqual(deleted, [], 'the policy should have matched no rows');

		const stillThere = await expectOk('alice', { table: 'notes', operation: 'count' });
		assert.equal(stillThere[0].count, 1, "alice's row must survive");
	});

	it("cannot forge another caller's ownership on insert", async () => {
		// `owner` is filled by Postgres from the caller's claims, so introspection marks
		// it server-managed and the request is refused before the policy is consulted.
		const { status, body } = await query('bob', {
			table: 'notes',
			operation: 'insert',
			values: { text: 'impersonation', owner: 'alice' },
		});
		assert.equal(status, 400);
		assert.equal(body.error, 'InvalidQueryException');

		const aliceRows = await expectOk('alice', { table: 'notes', operation: 'select', columns: ['text'] });
		assert.deepEqual(aliceRows, [{ text: 'from the browser' }]);
	});

	it('refuses a table that was not exposed, with 403', async () => {
		const { status, body } = await query('alice', { table: 'pg_user', operation: 'select' });
		assert.equal(status, 403);
		assert.equal(body.error, 'TableNotExposedException');
	});

	it('refuses malformed queries with 400', async () => {
		const bad = [
			{ table: 'notes', operation: 'select', columns: ['nope'] },
			{ table: 'notes', operation: 'select', filters: [{ column: 'id', operator: 'raw', value: 1 }] },
			{ table: 'notes', operation: 'select', filters: [{ column: 'id', operator: 'eq', value: { gt: 1 } }] },
			{ table: 'notes', operation: 'delete' },
			{ table: 'notes', operation: 'insert', values: { id: 1, text: 'x' } },
			{ table: 'notes', operation: 'select', limit: 5000 },
			'DROP TABLE notes',
		];
		for (const description of bad) {
			const { status, body } = await query('alice', description);
			assert.equal(status, 400, `expected 400 for ${JSON.stringify(description)}, got ${status}`);
			assert.equal(body.error, 'InvalidQueryException');
		}
	});

	it('never leaks internal detail on an unexpected failure', async () => {
		// LIKE against an integer column passes validation but fails in Postgres. The
		// response must not carry the SQL, the parameters, or a driver stack.
		const { status, body } = await query('alice', {
			table: 'notes',
			operation: 'select',
			filters: [{ column: 'id', operator: 'like', value: '%1%' }],
		});
		assert.equal(status, 500);
		assert.equal(body.message, 'internal error');
		assert.doesNotMatch(JSON.stringify(body), /SELECT|notes|\$1/i);
	});

	it('stores an injection attempt as data', async () => {
		const evil = "'); DROP TABLE notes; --";
		await expectOk('carol', { table: 'notes', operation: 'insert', values: { text: evil } });

		const rows = await expectOk('carol', { table: 'notes', operation: 'select', columns: ['text'] });
		assert.deepEqual(rows, [{ text: evil }]);
	});
});
