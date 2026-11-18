// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Applies the E2E test schema to the Supabase project.
 * Run: npx tsx packages/bb-database/test/apply-schema.ts
 *
 * Requires: SUPABASE_DB_URL env var (session mode, port 5432).
 * All statements are idempotent: safe to run repeatedly.
 *
 * The server certificate is always verified: against the PEM file that DATABASE_CA_CERT names (or the PEM text
 * it holds), otherwise against the committed Supabase root CA in fixtures/. The connection string is split
 * into discrete fields; it is never passed on and never printed.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const dbUrl = process.env.SUPABASE_DB_URL;
if (!dbUrl) {
	console.log('SUPABASE_DB_URL not set: skipping schema apply');
	process.exit(0);
}

const here = path.dirname(fileURLToPath(import.meta.url));
const sql = fs.readFileSync(path.join(here, 'fixtures/supabase-e2e-schema.sql'), 'utf8');

const configuredCa = process.env.DATABASE_CA_CERT;
const ca = !configuredCa
	? fs.readFileSync(path.join(here, 'fixtures/supabase-ca.crt'), 'utf8')
	: configuredCa.includes('-----BEGIN CERTIFICATE-----')
		? configuredCa
		: fs.readFileSync(configuredCa, 'utf8');

// `new URL()` puts its input on the error it throws, so that error is not printed.
let target: URL;
try {
	target = new URL(dbUrl);
} catch {
	console.error('Failed to apply schema: SUPABASE_DB_URL is not a URL');
	process.exit(1);
}

const pool = new pg.Pool({
	host: target.hostname,
	port: Number(target.port || '5432'),
	user: decodeURIComponent(target.username),
	password: decodeURIComponent(target.password),
	database: decodeURIComponent(target.pathname.replace(/^\//, '')) || 'postgres',
	ssl: { ca, rejectUnauthorized: true },
});

try {
	await pool.query(sql);
	console.log('E2E schema applied');
} catch (err) {
	console.error('Failed to apply schema:', err instanceof Error ? err.message : 'unknown error');
	process.exitCode = 1;
} finally {
	await pool.end();
}
