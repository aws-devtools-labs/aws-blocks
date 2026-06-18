// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Apply external-database migrations during the app lifecycle:
 * `npm run dev` (to the dev database), and `npm run sandbox` / `npm run deploy`
 * (to the sandbox / production database, before `cdk deploy`).
 *
 * `core` must not depend on `bb-data` (the dependency runs the other way), so
 * this invokes the `bb-data` CLI as a subprocess — the same pattern the deploy
 * script already uses for client generation. The CLI's migrate path rewrites to
 * the 5432 session port, takes an advisory lock, and applies pending migrations
 * idempotently. The connection string is passed to the child via an environment
 * variable (not argv) so it isn't exposed in the process list.
 *
 * Applying a migration makes the schema change live in the database. In the dev
 * loop (`npm run dev`) the same `bb-data migrate` subprocess also refreshes the
 * generated types (`--regenerate-types`); sandbox/production deploys apply the
 * committed schema only and never rewrite source.
 *
 * No-op unless BOTH a connection string is resolvable from the environment
 * (i.e. the app uses an external/fromExisting DB) AND a `./migrations` directory
 * exists. Aurora-managed databases run migrations via their in-VPC Lambda, not
 * here.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { findConnectionString } from './ensure-secrets.js';
import { extractDbRef } from '../db-naming.js';

const DEFAULT_MIGRATIONS_DIR = './migrations';
/** Default output dir for db-pull generated files (database.types.ts / database.meta.ts). */
const DEFAULT_GENERATED_DIR = './aws-blocks';

/**
 * Invoke `bb-data migrate` for a stage. The connection string is passed via the
 * BLOCKS_MIGRATE_URL env var rather than argv, so the credential is not visible
 * in the process list. Arg-array exec (no shell). `--no-install` keeps npx from
 * reaching the public registry for the private bin (already an app dependency).
 */
/**
 * Build the argv for the `bb-data migrate` subprocess. Extracted as a pure
 * function so the dev-vs-deploy difference is unit-testable. When
 * `regenerateTypesDir` is set (dev loop only), append `--regenerate-types=<dir>`
 * so a successful apply also refreshes generated types. Sandbox/production
 * deploys omit it — they apply the committed schema and must never rewrite
 * source files on a CI/deploy host.
 */
export function buildMigrateArgs(stage: string, migrationsDir: string, regenerateTypesDir?: string): string[] {
  const args = ['--no-install', 'bb-data', 'migrate', '--stage', stage, migrationsDir];
  if (regenerateTypesDir) args.push(`--regenerate-types=${regenerateTypesDir}`);
  return args;
}

function runMigrateSubprocess(
  connValue: string,
  stage: string,
  migrationsDir: string,
  regenerateTypesDir?: string,
): void {
  execFileSync('npx', buildMigrateArgs(stage, migrationsDir, regenerateTypesDir), {
    stdio: 'inherit',
    env: { ...process.env, BLOCKS_MIGRATE_URL: connValue },
  });
}

export interface ApplyExternalMigrationsOptions {
  stage: 'sandbox' | 'production';
  /** Override the migrations directory (default ./migrations). */
  migrationsDir?: string;
}

/**
 * Which apply stages get the production guard. **Security-relevant:** `sandbox`
 * resolves its connection from the same `.env.local` as the dev loop, so it must
 * be guarded against accidentally pointing at production. `production` deploys
 * intentionally target the production database and must NOT be guarded. Keep this
 * as the single source of truth for the decision.
 */
export function shouldGuardAgainstProduction(stage: 'sandbox' | 'production'): boolean {
  return stage === 'sandbox';
}

/**
 * Apply pending external-DB migrations for the given stage. Returns true if a
 * migration step ran, false if it was skipped (no external DB / no migrations).
 *
 * For `stage: 'sandbox'` it refuses if the resolved connection (`.env.local`)
 * points at a production database — the same guard as the dev loop. `stage:
 * 'production'` is intentionally unguarded (deploy is meant to target prod).
 */
export async function applyExternalMigrations(opts: ApplyExternalMigrationsOptions): Promise<boolean> {
  const migrationsDir = opts.migrationsDir ?? DEFAULT_MIGRATIONS_DIR;

  const conn = findConnectionString();
  if (!conn) return false; // not an external-DB app
  if (!existsSync(migrationsDir)) return false; // nothing to apply
  if (readdirSync(migrationsDir).filter(f => f.endsWith('.sql')).length === 0) return false;

  // Sandbox uses the same `.env.local` as dev, so guard it the same way: never
  // apply schema changes to a production database. Production deploys are
  // intentionally NOT guarded — `npm run deploy` is meant to target production.
  if (shouldGuardAgainstProduction(opts.stage)) {
    await assertNotProductionTarget(conn.value, { command: 'npm run sandbox', announceFailOpen: true });
  }

  console.log(`🧬 Applying external database migrations (${opts.stage})...`);
  runMigrateSubprocess(conn.value, opts.stage, migrationsDir);
  return true;
}

/** Best-effort DB host for transparency logging. */
function hostOf(connectionString: string): string {
  try {
    return new URL(connectionString).host;
  } catch {
    return '(unparseable connection string)';
  }
}

/** Best-effort DB identity ref; null if it can't be derived. */
function safeRef(connectionString: string): string | null {
  try {
    return extractDbRef(connectionString);
  } catch {
    return null;
  }
}

/** Extract production DB identity refs from `.env`-style content (pure/testable). */
export function parseProductionRefsFromEnvContent(content: string): string[] {
  const refs: string[] = [];
  for (const line of content.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq === -1) continue;
    const key = t.slice(0, eq).trim();
    const val = t.slice(eq + 1).trim();
    if (/_(DB_URL|CONNECTION_STRING)$/.test(key) && val) {
      const r = safeRef(val);
      if (r) refs.push(r);
    }
  }
  return refs;
}

/** True when the dev database is one of the known production databases. */
export function isProductionTarget(devRef: string | null, prodRefs: Set<string>): boolean {
  return devRef != null && prodRefs.has(devRef);
}

/**
 * Collect database identities known to be **production**, to guard the dev loop
 * from accidentally migrating production. Source: local `.env.production` (read
 * directly, NOT loaded into the environment).
 *
 * Note: this used to also read the production SSM parameter by a fixed
 * stage-only name. That name is now stack-scoped (`/<stackName>-supabase-db-url`,
 * resolved at synth) and is not knowable in the dev loop without synthesizing
 * the production stack, so the SSM leg has been removed. The guard already
 * fails open, and the `.env.production` leg remains the reliable signal.
 */
async function productionRefs(devRef: string): Promise<Set<string>> {
  const refs = new Set<string>();

  if (existsSync('.env.production')) {
    for (const r of parseProductionRefsFromEnvContent(readFileSync('.env.production', 'utf-8'))) {
      refs.add(r);
    }
  }

  return refs;
}

/**
 * Refuse to run schema changes against a known production database. Compares the
 * resolved connection's DB identity against the production refs (`.env.production`
 * + the production SSM parameter). Throws with actionable guidance if they match;
 * no-op when the ref can't be derived or no production ref is known. Shared by the
 * dev loop and the sandbox apply (both resolve their connection from `.env.local`).
 */
async function assertNotProductionTarget(
  connValue: string,
  opts: { command: string; optOutHint?: string; announceFailOpen?: boolean },
): Promise<void> {
  const ref = safeRef(connValue);
  if (!ref) return;
  const prodRefs = await productionRefs(ref);
  if (prodRefs.size === 0) {
    // Best-effort guard, failing OPEN: with no `.env.production` and no resolvable
    // production SSM parameter, we cannot prove the target isn't production, so proceed.
    // The dev loop stays quiet — "no production set up yet" is the normal local case and
    // a note on every `npm run dev` would be false-alarm noise. The consequential,
    // deploy-adjacent sandbox apply announces the blind spot instead (see DESIGN.md).
    if (opts.announceFailOpen) {
      console.log(
        `ℹ️  Could not verify the target database isn't production (.env.production absent ` +
          `and the production SSM parameter was unavailable) — proceeding with \`${opts.command}\`.`,
      );
    }
    return;
  }
  if (!isProductionTarget(ref, prodRefs)) return;

  const optOut = opts.optOutHint ? `, or ${opts.optOutHint}` : '';
  throw new Error(
    `Refusing to apply migrations: .env.local points at your PRODUCTION database (${hostOf(connValue)}).\n` +
      `\`${opts.command}\` must not run schema changes against production. Point .env.local at a ` +
      `dev/branch database${optOut}.`,
  );
}

/**
 * Apply pending external-database migrations during `npm run dev`, against the
 * dev database, so the schema change is live locally without a sandbox round-trip.
 * (A successful apply also refreshes the generated TypeScript types from the new
 * schema — `database.types.ts` + `database.meta.ts` — so code type-checks against
 * it locally before deploy. To refresh by hand at any time, run `npx bb-data pull`.)
 *
 * Only acts for external (`fromExisting`) apps — the managed/Aurora path uses a
 * local PGlite mock in dev and is unaffected. Guards against accidentally
 * migrating a production database: if `.env.local` resolves to the same database
 * as production (`.env.production` and/or the production SSM parameter), it
 * refuses. Reachability/apply failures warn and let dev continue; only the
 * production-target refusal is fatal. Set `BLOCKS_SKIP_DEV_MIGRATIONS=1` to skip.
 *
 * Returns true if a migration step ran, false if skipped.
 */
export async function applyDevMigrations(opts?: { migrationsDir?: string; generatedDir?: string }): Promise<boolean> {
  if (process.env.BLOCKS_SKIP_DEV_MIGRATIONS) return false;

  const migrationsDir = opts?.migrationsDir ?? DEFAULT_MIGRATIONS_DIR;
  const generatedDir = opts?.generatedDir ?? DEFAULT_GENERATED_DIR;
  const conn = findConnectionString();
  if (!conn) return false; // not an external-DB app (e.g. managed Aurora → local PGlite mock)
  if (!existsSync(migrationsDir)) return false;
  if (readdirSync(migrationsDir).filter(f => f.endsWith('.sql')).length === 0) return false;

  // Guardrail: never auto-apply to a production database from the dev loop.
  await assertNotProductionTarget(conn.value, {
    command: 'npm run dev',
    optOutHint: 'set BLOCKS_SKIP_DEV_MIGRATIONS=1 to opt out',
  });

  console.log(`🧬 Applying migrations to your dev database (${hostOf(conn.value)})...`);
  try {
    // Dev loop: apply, then refresh generated types from the migrated schema in
    // the SAME subprocess (one developer-visible step). Deploy/sandbox omit the
    // regenerate-types arg — they apply the committed schema, never rewrite source.
    runMigrateSubprocess(conn.value, 'dev', migrationsDir, generatedDir);
    return true;
  } catch (e: any) {
    // Don't block local dev on a migration apply failure (e.g. port 5432 blocked
    // on a corp network). Warn and continue — the app may still run.
    console.warn(`⚠️  Could not apply migrations in dev: ${e?.message ?? e}`);
    console.warn(`    Continuing without applying. Run migrations before deploy.`);
    return false;
  }
}
