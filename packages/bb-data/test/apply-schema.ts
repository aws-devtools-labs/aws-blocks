/**
 * Applies the E2E test schema to the Supabase project.
 * Run: npx tsx packages/bb-data/test/apply-schema.ts
 *
 * Requires: SUPABASE_DB_URL env var (direct connection, port 5432).
 * All statements are idempotent — safe to run repeatedly.
 */
import pg from 'pg';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const dbUrl = process.env.SUPABASE_DB_URL;
if (!dbUrl) {
  console.log('⏭ SUPABASE_DB_URL not set — skipping schema apply');
  process.exit(0);
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const sql = fs.readFileSync(path.join(__dirname, 'fixtures/supabase-e2e-schema.sql'), 'utf8');

// Verify the server certificate against the pinned CA when DATABASE_CA_CERT is set
// (always in CI — the e2e-supabase workflow pins the committed Supabase Root CA);
// fall back to unverified only for ad-hoc local runs without a CA.
const ssl = process.env.DATABASE_CA_CERT
  ? { ca: fs.readFileSync(process.env.DATABASE_CA_CERT, 'utf8'), rejectUnauthorized: true as const }
  : { rejectUnauthorized: false as const };

const pool = new pg.Pool({ connectionString: dbUrl, ssl });

try {
  await pool.query(sql);
  console.log('✓ E2E schema applied');
} catch (err: any) {
  console.error('✗ Failed to apply schema:', err.message);
  process.exit(1);
} finally {
  await pool.end();
}
