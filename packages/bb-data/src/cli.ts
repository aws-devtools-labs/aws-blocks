#!/usr/bin/env node
// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0


/**
 * bb-data CLI — utility for local database operations.
 *
 * Commands:
 *   migrate [dir]            Run pending SQL migrations (local PGlite, or external with --url)
 *   status [dir]             Show pending migrations (local PGlite, or external with --url)
 *   generate-types [output]  Generate TypeScript types from the schema (local, or external with --url)
 *   pull [output-dir]        Introspect a database and generate files
 *
 * Flags:
 *   --url <conn>             Target an external connection-string database (Supabase/Neon).
 *                            Required to operate on an external DB from the CLI; without it,
 *                            migrate/status/generate-types refuse on a fromExisting() app
 *                            (they would otherwise silently target local PGlite).
 *   --stage <name>           Stage label for external runs (advisory-lock key + logging).
 */

import { PGliteEngine } from './engines/pglite-engine.js';
import { PgClientEngine } from './engines/pg-client-engine.js';
import { externalDbSsl } from './external-ssl.js';
import { generateTypes } from './type-generator.js';
import { runMigrations, loadMigrationsFromDir } from '@aws-blocks/data-common';
import { runExternalMigrations, toSessionPortUrl } from './migrations/external-migrations.js';
import { runDbPullCli, regenerateTypesAndMeta } from './db-pull.js';
import * as fs from 'fs';
import * as path from 'path';
import { Scope } from '@aws-blocks/core';
import { AppSetting } from '@aws-blocks/bb-app-setting';
import { SUPABASE } from './db-pull/supabase.js';

const rawArgs = process.argv.slice(2);
const command = rawArgs[0];

/** Extract `--flag value` (or `--flag=value`); returns the value or undefined and strips it from args. */
function takeFlag(args: string[], flag: string): string | undefined {
  const eq = args.find(a => a.startsWith(`${flag}=`));
  if (eq) {
    args.splice(args.indexOf(eq), 1);
    return eq.slice(flag.length + 1);
  }
  const i = args.indexOf(flag);
  if (i !== -1) {
    const val = args[i + 1];
    const isValue = val !== undefined && !val.startsWith('--');
    args.splice(i, isValue ? 2 : 1);
    return isValue ? val : undefined;
  }
  return undefined;
}

/**
 * Detect whether the current app targets an external (fromExisting) database.
 * Keys off observable artifacts:
 *   - a `*_DB_URL` / `*_CONNECTION_STRING` env var
 *   - the AppSetting value for the db-url (same source the dev server reads)
 * Returns the connection string if found, else null.
 */
async function detectExternalDb(): Promise<string | null> {
  for (const [name, value] of Object.entries(process.env)) {
    if (/_(DB_URL|CONNECTION_STRING)$/.test(name) && value) return value;
  }
  try {
    const scope = new Scope(SUPABASE.scopeName);
    const dbUrl = new AppSetting(scope, 'db-url', { secret: true });
    const value = await dbUrl.get();
    if (typeof value === 'string' && value) return value;
  } catch { /* no setting seeded yet */ }
  return null;
}

function refuseExternalWithoutUrl(cmd: string): never {
  console.error(
    `\n❌ This app uses an external database (fromExisting()).\n\n` +
      `   \`bb-data ${cmd}\` without --url only targets the local PGlite database, which your\n` +
      `   app does not use — it would report success while changing nothing.\n\n` +
      `   • Schema is applied automatically to the right database by \`npm run sandbox\`\n` +
      `     (sandbox) and \`npm run deploy\` (production).\n` +
      `   • For a one-off against a specific database, pass --url <connection-string>.\n`,
  );
  process.exit(1);
}

/**
 * Take a flag that may appear as `--flag=value` or bare `--flag` (no value).
 * Unlike takeFlag, the bare form does NOT consume the following token, so it is
 * safe to mix with positional args (e.g. the migrations dir). Returns whether the
 * flag was present and its value if the `=value` form was used.
 */
function takeFlagOrBool(args: string[], flag: string): { present: boolean; value?: string } {
  const eq = args.find(a => a.startsWith(`${flag}=`));
  if (eq) {
    args.splice(args.indexOf(eq), 1);
    return { present: true, value: eq.slice(flag.length + 1) };
  }
  const i = args.indexOf(flag);
  if (i !== -1) {
    args.splice(i, 1);
    return { present: true };
  }
  return { present: false };
}

async function main() {
  const args = rawArgs.slice(1);
  const url = takeFlag(args, '--url') ?? process.env.BLOCKS_MIGRATE_URL;
  const stage = takeFlag(args, '--stage');
  // `--regenerate-types[=<dir>]`: after a successful external migrate, refresh
  // database.types.ts + database.meta.ts from the migrated schema (dev loop).
  const regen = takeFlagOrBool(args, '--regenerate-types');
  const regenerateTypesDir = regen.present ? (regen.value ?? './aws-blocks') : undefined;

  switch (command) {
    case 'migrate':
      await migrate(args, url, stage, regenerateTypesDir);
      break;
    case 'status':
      await status(args, url);
      break;
    case 'generate-types':
      await genTypes(args, url);
      break;
    case 'pull':
      await runDbPullCli();
      break;
    default:
      printHelp();
  }
}

async function migrate(args: string[], url: string | undefined, stage: string | undefined, regenerateTypesDir?: string) {
  const migrationsDir = args[0] || './migrations';
  if (!fs.existsSync(migrationsDir)) {
    console.error(`Migrations directory not found: ${migrationsDir}`);
    process.exit(1);
  }

  // External path: an explicit --url targets the real database.
  if (url) {
    const { applied } = await runExternalMigrations({ connectionString: url, migrationsDir, stage });
    if (applied.length === 0) console.log('No pending migrations.');
    else {
      console.log(`Applied ${applied.length} migration(s) to the external database:`);
      applied.forEach(m => console.log(`  ✓ ${m}`));
    }

    // Dev loop: refresh generated types from the migrated schema so the customer
    // type-checks against the new schema locally, before deploy. Only when the
    // schema actually changed (applied > 0). Non-fatal: a regen failure must not
    // fail an apply that already succeeded — the DB is the source of truth and
    // `npx bb-data pull` can always refresh types afterward.
    if (regenerateTypesDir && applied.length > 0) {
      // Only refresh an existing generated dir. If database.meta.ts isn't there,
      // the app either hasn't run `db pull` or uses a non-default output dir —
      // skip rather than scaffold a stray directory in the wrong place.
      if (!fs.existsSync(path.join(regenerateTypesDir, 'database.meta.ts'))) {
        console.log(`ℹ️  Skipped type refresh: no database.meta.ts in ${regenerateTypesDir}. Run \`npx bb-data pull\` to (re)generate types.`);
      } else {
        try {
          console.log('Refreshing generated types from the migrated schema...');
          const { tablesGenerated } = await regenerateTypesAndMeta({ connectionString: url, outputDir: regenerateTypesDir });
          console.log(`✓ Refreshed database.types.ts + database.meta.ts (${tablesGenerated} table(s)) in ${regenerateTypesDir}`);
        } catch (e: any) {
          console.warn(`⚠️  Migrations applied, but type refresh failed: ${e?.message ?? e}`);
          console.warn(`    Run \`npx bb-data pull\` to refresh database.types.ts / database.meta.ts.`);
        }
      }
    }
    return;
  }

  // Guard: refuse to silently migrate local PGlite for an external app.
  if (await detectExternalDb()) refuseExternalWithoutUrl('migrate');

  const engine = new PGliteEngine('.bb-data');
  try {
    const migrations = await loadMigrationsFromDir(migrationsDir);
    const applied = await runMigrations(engine, migrations);
    if (applied.length === 0) {
      console.log('No pending migrations.');
    } else {
      console.log(`Applied ${applied.length} migration(s):`);
      applied.forEach(m => console.log(`  ✓ ${m}`));
    }
  } finally {
    await engine.destroy();
  }
}

async function status(args: string[], url: string | undefined) {
  const migrationsDir = args[0] || './migrations';
  if (!fs.existsSync(migrationsDir)) {
    console.error(`Migrations directory not found: ${migrationsDir}`);
    process.exit(1);
  }

  if (!url && await detectExternalDb()) refuseExternalWithoutUrl('status');

  const engine = url
    ? new PgClientEngine({ connectionString: toSessionPortUrl(url), ssl: externalDbSsl(), poolSize: 1 })
    : new PGliteEngine('.bb-data');
  try {
    const migrations = await loadMigrationsFromDir(migrationsDir);
    const allFiles = Object.keys(migrations).sort();

    try {
      const applied = await engine.query<{ name: string }>('SELECT name FROM _migrations ORDER BY id');
      const appliedNames = new Set(applied.map(r => r.name));
      const pending = allFiles.filter(f => !appliedNames.has(f));

      console.log(`Total: ${allFiles.length} | Applied: ${applied.length} | Pending: ${pending.length}`);
      if (pending.length > 0) {
        pending.forEach(m => console.log(`  ⏳ ${m}`));
      } else {
        console.log('All migrations applied.');
      }
    } catch {
      // _migrations table doesn't exist yet — all are pending
      console.log(`Total: ${allFiles.length} | Applied: 0 | Pending: ${allFiles.length}`);
      allFiles.forEach(m => console.log(`  ⏳ ${m}`));
    }
  } finally {
    await engine.destroy();
  }
}

async function genTypes(args: string[], url: string | undefined) {
  const outputPath = args[0] || './types/database.ts';

  if (!url && await detectExternalDb()) refuseExternalWithoutUrl('generate-types');

  const engine = url
    ? (console.log('Connecting to external database...'),
       new PgClientEngine({ connectionString: toSessionPortUrl(url), ssl: externalDbSsl(), poolSize: 1 }))
    : (console.log('Connecting to local database (.bb-data)...'), new PGliteEngine('.bb-data'));

  try {
    console.log('Introspecting schema...');
    const types = await generateTypes(engine);

    const dir = path.dirname(outputPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    fs.writeFileSync(outputPath, types);
    console.log(`Types written to ${outputPath}`);
  } finally {
    await engine.destroy();
  }
}

function printHelp() {
  console.log(`
bb-data CLI

Commands:
  pull [output-dir]        Introspect a database and generate files (default: ./aws-blocks)
  migrate [dir]            Run pending migrations (default: ./migrations)
  status [dir]             Show migration status (default: ./migrations)
  generate-types [output]  Generate TypeScript types from schema (default: ./types/database.ts)

Flags:
  --url <conn>             Target an external connection-string database (Supabase/Neon).
                           Without it, migrate/status/generate-types refuse on a fromExisting()
                           app rather than silently operating on local PGlite.
  --stage <name>           Stage label for external runs (advisory-lock key + logging).
  --regenerate-types[=<dir>]
                           After a successful external \`migrate --url\`, refresh
                           database.types.ts + database.meta.ts from the migrated
                           schema (default dir: ./aws-blocks). Used by \`npm run dev\`.

Examples:
  bb-data pull
  bb-data migrate
  bb-data migrate ./db/migrations
  bb-data migrate --url "$SUPABASE_DB_URL" --stage production
  bb-data status --url "$SUPABASE_DB_URL"
  bb-data generate-types ./src/types/db.ts
`);
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
