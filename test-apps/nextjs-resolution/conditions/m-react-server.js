// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// The `react-server` condition is what every Next.js server context resolves to,
// so this is where the REAL backend belongs: blocks constructed in app code and
// used in process, with no RPC hop.
import { Database, KVStore, Scope, sql } from '@aws-blocks/blocks';

export const MARKER = 'cond:react-server:REAL-BACKEND';

const scope = new Scope('probe');
const kv = new KVStore(scope, 'cache');
const db = new Database(scope, 'main');

// Data methods stay inside the request path — never at module top level.
export async function roundTrip() {
	await kv.put('probe-key', { ok: true });
	return { wrote: true, read: await kv.get('probe-key') };
}

// PGlite is WASM; this is what `serverExternalPackages` exists to protect.
export async function dbRoundTrip() {
	await db.execute(sql`CREATE TABLE IF NOT EXISTS notes (id SERIAL PRIMARY KEY, text TEXT)`);
	await db.execute(sql`INSERT INTO notes (text) VALUES (${'hello from the server'})`);
	const rows = await db.query(sql`SELECT id, text FROM notes ORDER BY id DESC LIMIT 1`);
	const [{ count }] = await db.query(sql`SELECT count(*)::int AS count FROM notes`);
	return { latest: rows[0], count };
}
