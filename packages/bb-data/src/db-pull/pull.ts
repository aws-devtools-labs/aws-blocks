// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * `db pull` orchestration: introspect → display eligibility/readiness → consent →
 * generate files + scaffolding (env files, mock sidecar, .gitignore, index wiring).
 * The interactive prompt and CLI entry points live here too.
 *
 * @module
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as readline from 'node:readline';
import type { DbPullOptions, TableInfo } from './types.js';
import { introspect } from './introspect.js';
import {
  generateIndexFile,
  generateCaFile,
  resolveCaFileWrite,
  generateMigrationGuide,
  readExistingSingulars,
  selectEligibleTables,
  writeTypesAndMeta,
} from './generate.js';
import { generateBaseline } from '../migrations/baseline.js';
import { SUPABASE, SUPABASE_AUTH, SUPABASE_CONN_GUIDANCE, SUPABASE_MESSAGING, detectSupabase, extractProjectRef } from './supabase.js';
import { Scope } from '@aws-blocks/core';
import { AppSetting } from '@aws-blocks/bb-app-setting';

// ── Main entry point ───────────────────────────────────────────────────

/**
 * The GRANT statement an eligible table needs for the provider's runtime role.
 * Derived from `SUPABASE_AUTH` (the same source the introspection grant-check
 * reads) so the privilege list / role we print can't drift from what we verify.
 */
function grantStatement(tableName: string): string {
  return `GRANT ${SUPABASE_AUTH.requiredGrants.join(', ')} ON "${tableName}" TO ${SUPABASE_AUTH.authenticatedRole};`;
}

export async function dbPull(opts: DbPullOptions): Promise<void> {
  console.log('✓ Connecting to database...');
  const { tables: allTables, tablesUsingSupabaseAuth, nonStandardClaims } = await introspect(opts.connectionString, opts.caCert);

  if (allTables.length === 0) {
    console.error('✗ No tables found in public schema.');
    process.exit(1);
  }

  // ── Eligibility criteria ──────────────────────────────────────────────
  // A table is eligible if: (1) has a primary key, (2) does not use Supabase Auth
  const hasNoPk = (t: TableInfo) => Array.isArray(t.primaryKey) && t.primaryKey.length === 0;

  const eligibleTables = selectEligibleTables({ tables: allTables, tablesUsingSupabaseAuth, nonStandardClaims });
  const eligibleSet = new Set(eligibleTables);
  const skippedTables = allTables.filter(t => !eligibleSet.has(t));

  // ── Table eligibility ────────────────────────────────────────────────
  const nameWidth = Math.max(...allTables.map(t => t.name.length), 5);
  console.log(`\nYour database${opts.projectRef ? ` (project: ${opts.projectRef})` : ''} — ${allTables.length} table(s)\n`);
  console.log(`  Table eligibility:\n`);
  const pkWidth = Math.max(...allTables.map(t => {
    const pk = t.primaryKey;
    return (Array.isArray(pk) ? (pk.length === 0 ? 1 : pk.join(', ').length) : pk.length);
  }), 2);
  console.log(`  ${'Table'.padEnd(nameWidth)}  ${'PK'.padEnd(pkWidth)}  ${'Auth'.padEnd(14)}  Eligible`);
  console.log(`  ${'─'.repeat(nameWidth)}  ${'─'.repeat(pkWidth)}  ${'─'.repeat(14)}  ${'─'.repeat(42)}`);
  for (const t of allTables) {
    const pkCol = Array.isArray(t.primaryKey)
      ? (t.primaryKey.length === 0 ? '—' : t.primaryKey.join(', '))
      : t.primaryKey;
    const authCol = tablesUsingSupabaseAuth.has(t.name)
      ? SUPABASE_MESSAGING.authEligibilityLabel
      : t.hasRls ? 'OIDC' : '—';
    let eligibleCol: string;
    if (tablesUsingSupabaseAuth.has(t.name)) {
      eligibleCol = SUPABASE_MESSAGING.authIneligibleReason;
    } else if (hasNoPk(t)) {
      eligibleCol = 'No — no primary key';
    } else {
      eligibleCol = 'Yes';
    }
    console.log(`  ${t.name.padEnd(nameWidth)}  ${pkCol.padEnd(pkWidth)}  ${authCol.padEnd(14)}  ${eligibleCol}`);
  }
  console.log(`\n  ${eligibleTables.length} table(s) eligible, ${skippedTables.length} will be skipped.\n`);

  // ── Readiness criteria ───────────────────────────────────────────────
  // Eligible tables may still need actions before they work at runtime:
  // grants (authenticated role), non-standard JWT claims
  if (eligibleTables.length > 0) {
    console.log(`  Eligible table readiness:\n`);
    const claimsWidth = Math.max(...eligibleTables.map(t => {
      const c = nonStandardClaims.get(t.name);
      return c ? c.join(', ').length : 1;
    }), 6);
    console.log(`  ${'Table'.padEnd(nameWidth)}  RLS   Grants   ${'Claims'.padEnd(claimsWidth)}  Status`);
    console.log(`  ${'─'.repeat(nameWidth)}  ${'─'.repeat(4)}  ${'─'.repeat(7)}  ${'─'.repeat(claimsWidth)}  ${'─'.repeat(15)}`);
    for (const t of eligibleTables) {
      const rlsCol = t.hasRls ? 'yes' : 'no';
      const grantsCol = t.missingGrants ? 'MISSING' : 'ok';
      const claims = nonStandardClaims.get(t.name);
      const claimsCol = claims ? claims.join(', ') : '—';
      const status = (t.missingGrants || claims) ? 'Action required' : 'Ready';
      console.log(`  ${t.name.padEnd(nameWidth)}  ${rlsCol.padEnd(4)}  ${grantsCol.padEnd(7)}  ${claimsCol.padEnd(claimsWidth)}  ${status}`);
    }
    console.log('');
  }

  // ── Actions Required ─────────────────────────────────────────────────
  const tablesWithMissingGrants = eligibleTables.filter(t => t.missingGrants);
  const eligibleNames = new Set(eligibleTables.map(t => t.name));
  const migratedClaims = [...nonStandardClaims].filter(([t]) => eligibleNames.has(t));
  const hasActions = tablesWithMissingGrants.length > 0 || migratedClaims.length > 0;

  if (hasActions) {
    console.log(`  Actions required:\n`);
    let actionNum = 1;

    if (tablesWithMissingGrants.length > 0) {
      console.log(`  ${actionNum}. Grant permissions (${SUPABASE_MESSAGING.grantSqlLocation}):\n`);
      for (const t of tablesWithMissingGrants) {
        console.log(`     ${grantStatement(t.name)}`);
      }
      console.log('');
      actionNum++;
    }

    if (migratedClaims.length > 0) {
      console.log(`  ${actionNum}. Configure your OIDC provider to include these JWT claims:\n`);
      for (const [table, claims] of migratedClaims) {
        console.log(`     ${table}: ${claims.join(', ')}`);
      }
      console.log(`\n     Without them, RLS will filter out all rows for those tables.`);
      console.log('');
    }
  }

  // ── Consent ──────────────────────────────────────────────────────────
  const tables = eligibleTables;

  if (tables.length === 0) {
    console.error(`✗ No eligible tables — nothing to migrate.`);
    process.exit(1);
  }

  const answer = await prompt('  Continue? (y/N) ');
  if (answer.toLowerCase() !== 'y') {
    console.log('  Aborted.');
    process.exit(0);
  }
  console.log('');

  console.log(`✓ Migrating ${tables.length} table(s)`);

  // Store the connection string as provided (port as-is). The runtime port is NOT
  // baked in here — generated supabase.ts derives it per environment (transaction
  // pooler 6543 in Lambda, session 5432 locally), so the stored value and the
  // runtime port can never drift. See generateIndexFile.
  const connString = opts.connectionString;

  // Generate files
  const outputDir = opts.outputDir;
  fs.mkdirSync(outputDir, { recursive: true });

  // On re-pull, preserve hand-edited singular values from existing database.meta.ts.
  const existingSingulars = readExistingSingulars(outputDir);

  // database.types.ts + database.meta.ts via the shared writer (same path the
  // dev-loop type refresh uses, so the two stay consistent).
  writeTypesAndMeta(outputDir, tables, existingSingulars);

  // database.ca.ts — the project CA pinned by the generated wiring for TLS
  // verification. Write it when a CA is provided (also refreshes a rotated CA);
  // preserve an existing one when none is supplied (so a routine re-pull doesn't
  // downgrade a verified app); emit the empty stub on first pull so the import
  // resolves. Decision logic is `resolveCaFileWrite` (unit-tested).
  const caFilePath = path.join(outputDir, 'database.ca.ts');
  const caFileContent = resolveCaFileWrite(opts.caCert, fs.existsSync(caFilePath));
  if (caFileContent !== null) {
    fs.writeFileSync(caFilePath, caFileContent);
  }

  const indexContent = generateIndexFile(tables, { projectRef: opts.projectRef, runtimeConnString: connString });
  const guideContent = generateMigrationGuide(tables, nonStandardClaims, existingSingulars);

  // The generated wiring file may contain custom code (extra helpers, modified
  // CRUD wiring). On re-pull, warn and skip to avoid silent data loss.
  const dbFile = SUPABASE.generatedDbFile;
  const supabaseTsPath = path.join(outputDir, dbFile);
  const supabaseTsExists = fs.existsSync(supabaseTsPath);
  let existingSupabaseTs = '';
  if (supabaseTsExists) {
    try {
      existingSupabaseTs = fs.readFileSync(supabaseTsPath, 'utf-8');
    } catch {
      // Best-effort read for messaging only; ignore failures.
    }
  } else {
    fs.writeFileSync(supabaseTsPath, indexContent);
  }
  fs.writeFileSync(path.join(outputDir, 'MIGRATION_GUIDE.md'), guideContent);

  if (supabaseTsExists) {
    // Whether the existing file derives its CRUD table list from tableMeta
    // (current generator) or pins a static list (older generator / hand-edited).
    // Only the data-driven form auto-wires tables added or removed on re-pull.
    const wiringIsDataDriven = existingSupabaseTs.includes('Object.keys(tableMeta)');
    console.log(`✓ Generated 4 files in ${outputDir}/`);
    console.log(`    database.types.ts`);
    console.log(`    database.meta.ts`);
    console.log(`    database.ca.ts`);
    console.log(`    MIGRATION_GUIDE.md`);
    console.warn(`⚠ Skipped ${dbFile} — it already exists and may contain custom code.`);
    if (wiringIsDataDriven) {
      console.warn(`    CRUD wiring reads tables from database.meta.ts, so added/removed tables`);
      console.warn(`    are picked up automatically. To regenerate ${dbFile} itself (e.g. after`);
      console.warn(`    a connection or scope change), delete it and re-run.`);
    } else {
      console.warn(`    Its CRUD table list is static, so tables added or removed in this pull are`);
      console.warn(`    NOT reflected. Update the tables: [...] array in ${dbFile}, or delete the`);
      console.warn(`    file and re-run to regenerate it (newer wiring tracks database.meta.ts).`);
    }
  } else {
    console.log(`✓ Generated 5 files in ${outputDir}/`);
    console.log(`    database.types.ts`);
    console.log(`    database.meta.ts`);
    console.log(`    database.ca.ts`);
    console.log(`    ${dbFile}`);
    console.log(`    MIGRATION_GUIDE.md`);
  }

  // Write .env.local
  const envPath = path.join(path.dirname(outputDir), '.env.local');
  const envContent = `${SUPABASE.connStringEnvVar}=${connString}\n`;

  fs.writeFileSync(envPath, envContent);
  console.log(`✓ Wrote ${envPath} — treating this as your development connection`);

  // Write the mock AppSetting value so `npm run dev` picks up the connection
  // string without any env-var bridging. Uses AppSetting directly — single
  // source of truth for naming, serialization, and storage location.
  const scope = new Scope(SUPABASE.scopeName);
  const dbUrlSetting = new AppSetting(scope, 'db-url', { secret: true });
  await dbUrlSetting.put(connString);
  console.log(`✓ Seeded AppSetting "${scope.id}-db-url" with connection string`);

  // Generate the schema baseline (migrations/000_baseline.sql) so new/empty
  // environments can be built from the migration files alone. Uses the 5432
  // introspection connection. Non-fatal: a missing/old pg_dump warns and lets
  // pull finish — existing environments still work without the baseline.
  const migrationsDir = path.join(path.dirname(outputDir), 'migrations');
  try {
    let baseline = await generateBaseline({ connectionString: opts.connectionString, migrationsDir });
    while (baseline.warning) {
      console.warn(`\n⚠️  Schema baseline not generated: ${baseline.warning}`);
      console.warn(`    New/empty environments can't be built from migrations until the baseline exists.`);
      if (!process.stdin.isTTY) {
        console.warn(`    Fix the above and re-run \`npx bb-data pull\` to generate ${path.join('migrations', '000_baseline.sql')}.`);
        break;
      }
      const choice = await prompt('\n  [U]pgrade pg_dump in another terminal, then retry / [C]ontinue without baseline (u/C) ');
      if (choice.toLowerCase() === 'u') {
        baseline = await generateBaseline({ connectionString: opts.connectionString, migrationsDir });
        continue;
      }
      break;
    }
    if (!baseline.warning) {
      if (baseline.written) {
        console.log(`✓ Wrote ${baseline.path} (schema baseline)`);
      } else {
        console.log(`✓ Baseline already present (${baseline.path}) — left unchanged`);
      }
    }
  } catch (e: any) {
    console.warn(`⚠️  Schema baseline not generated: ${e?.message ?? e}`);
  }

  // Write .env.production.example
  const envProdExamplePath = path.join(path.dirname(outputDir), '.env.production.example');
  const envProdContent = [
    `# Production database connection string.`,
    `#`,
    `# ⚠  Use a SEPARATE production Supabase project (or branch) — NOT your dev database.`,
    `#`,
    `# Paste your production Supabase connection string, e.g.:`,
    `#   postgresql://postgres.<prod-project-ref>:<password>@<region>.pooler.supabase.com:5432/postgres`,
    `#`,
    `# The port is normalized automatically at runtime: the Lambda uses the Supavisor`,
    `# transaction pooler (6543) for concurrency; local dev uses the session port (5432).`,
    `# You don't need to pick the port here. To pin one, edit resolveConnString in`,
    `# aws-blocks/supabase.ts.`,
    `#`,
    `# To configure production, run \`npx bb-data pull\` and choose "production" —`,
    `# it writes .env.production for you. Or do it manually: copy this file`,
    `# (cp .env.production.example .env.production), fill in the value below, then`,
    `# run: npm run deploy`,
    `${SUPABASE.connStringEnvVar}=`,
  ].join('\n') + '\n';

  fs.writeFileSync(envProdExamplePath, envProdContent);
  console.log(`✓ Wrote ${envProdExamplePath}`);

  // Ensure .env.local and .env.production are gitignored (creating .gitignore if
  // the project doesn't have one) — both hold plaintext DB credentials.
  const gi = ensureGitignored(path.dirname(outputDir), ['.env.local', '.env.production']);
  if (gi.changed) console.log(`✓ ${gi.created ? 'Created' : 'Updated'} .gitignore`);

  // Patch aws-blocks/index.ts to import and spread supabaseCrud
  const indexPath = path.join(outputDir, 'index.ts');
  if (fs.existsSync(indexPath)) {
    let indexFileContent = fs.readFileSync(indexPath, 'utf-8');
    if (!indexFileContent.includes('supabaseCrud')) {
      // Add import
      const importLine = `import { supabaseCrud } from './supabase.js';\n`;
      // Insert after last import line
      const lastImportIdx = indexFileContent.lastIndexOf('import ');
      const lineEnd = indexFileContent.indexOf('\n', lastImportIdx);
      indexFileContent = indexFileContent.slice(0, lineEnd + 1) + importLine + indexFileContent.slice(lineEnd + 1);

      // Add commented-out auth + supabaseCrud(context, auth) inside the ApiNamespace callback
      const apiMatch = indexFileContent.match(/(ApiNamespace\([^)]*\(context\)\s*=>\s*\(\{)\n/);
      if (apiMatch && apiMatch.index !== undefined) {
        const insertPos = apiMatch.index + apiMatch[0].length;
        const authBlock = [
          `  // TODO: add auth — see MIGRATION_GUIDE.md#auth`,
          `  // const auth = new AuthOIDC(scope, 'auth', { providers: [...] });`,
          `  ...supabaseCrud(context),  // pass auth as 2nd arg once configured: supabaseCrud(context, auth)`,
        ].join('\n') + '\n';
        indexFileContent = indexFileContent.slice(0, insertPos) + authBlock + indexFileContent.slice(insertPos);
      } else {
        console.warn('⚠ Could not find ApiNamespace callback in index.handler.ts — add supabaseCrud(context) manually.');
      }

      fs.writeFileSync(indexPath, indexFileContent);
      console.log(`✓ Updated ${indexPath} — added supabaseCrud(context)`);
    } else {
      console.log(`✓ ${indexPath} already imports supabaseCrud`);
    }
  }

  // ── Consolidated "what to do next" ───────────────────────────────────
  // Re-surface the Actions Required computed above so grants/claims survive
  // scrollback and sit right next to the ordered next steps.
  console.log('\n─────────────────────────────────────────');
  console.log('What to do next');
  console.log('─────────────────────────────────────────\n');

  let step = 1;
  if (tablesWithMissingGrants.length > 0) {
    console.log(`  ${step}. Grant table permissions (${SUPABASE_MESSAGING.grantSqlLocation}) — see MIGRATION_GUIDE.md#adding-new-tables:`);
    for (const t of tablesWithMissingGrants) {
      console.log(`       ${grantStatement(t.name)}`);
    }
    console.log('');
    step++;
  }
  if (migratedClaims.length > 0) {
    console.log(`  ${step}. Configure your OIDC provider to emit these JWT claims — see MIGRATION_GUIDE.md#limitations:`);
    for (const [table, claims] of migratedClaims) {
      console.log(`       ${table}: ${claims.join(', ')}`);
    }
    console.log('');
    step++;
  }
  console.log(`  ${step}. Start developing locally:  npm run dev`);
  step++;
  console.log(`  ${step}. When ready for production:  npx bb-data pull  (choose "production" to configure .env.production), then  npm run deploy`);
}

// ── Interactive CLI ────────────────────────────────────────────────────

function prompt(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => {
    rl.question(question, answer => { rl.close(); resolve(answer.trim()); });
  });
}

function promptPassword(question: string): Promise<string> {
  return new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    process.stdout.write(question);
    const stdin = process.stdin;
    if (stdin.isTTY) stdin.setRawMode(true);
    let password = '';
    const onData = (ch: Buffer) => {
      const c = ch.toString();
      if (c === '\x03') {
        if (stdin.isTTY) stdin.setRawMode(false);
        stdin.removeListener('data', onData);
        rl.close();
        process.exit(130);
      } else if (c === '\n' || c === '\r') {
        if (stdin.isTTY) stdin.setRawMode(false);
        stdin.removeListener('data', onData);
        process.stdout.write('\n');
        rl.close();
        resolve(password);
      } else if (c === '\u007f' || c === '\b') {
        password = password.slice(0, -1);
      } else {
        password += c;
      }
    };
    stdin.on('data', onData);
    stdin.resume();
  });
}

// ── Provider detection + dev/prod routing helpers ──────────────────────

/**
 * True when a prior development `db pull` has stored a dev connection — i.e.
 * `.env.local` exists in the project root and assigns a non-empty value to the
 * provider's connection-string env var. This is the prerequisite for configuring
 * production: production mirrors a working dev setup, so we refuse to bootstrap an
 * app straight from a production database (the unsafe path).
 *
 * Pure/fs-only and exported so the dev-vs-prod gate is unit-testable without a TTY.
 */
export function hasDevConnection(projectDir: string): boolean {
  const envLocalPath = path.join(projectDir, '.env.local');
  if (!fs.existsSync(envLocalPath)) return false;
  let content: string;
  try {
    content = fs.readFileSync(envLocalPath, 'utf-8');
  } catch {
    return false;
  }
  const match = content.match(new RegExp(`^\\s*${SUPABASE.connStringEnvVar}\\s*=\\s*(.+)$`, 'm'));
  return match !== null && match[1].trim().length > 0;
}

/**
 * Ensure each entry is present in the project's `.gitignore`, **creating the file
 * if it doesn't exist**. `db pull` writes plaintext DB credentials (`.env.local`,
 * `.env.production`) into the project, so they must be ignored even when the
 * project has no `.gitignore` yet — otherwise a credential could be committed.
 * Matches whole lines (so `.env.production` isn't considered covered by an
 * existing `.env.production.example` entry). Returns whether the file changed and
 * whether it was newly created. Exported for unit testing.
 */
export function ensureGitignored(projectDir: string, entries: string[]): { changed: boolean; created: boolean } {
  const gitignorePath = path.join(projectDir, '.gitignore');
  const preexisting = fs.existsSync(gitignorePath);
  const original = preexisting ? fs.readFileSync(gitignorePath, 'utf-8') : '';
  const lines = new Set(original.split('\n').map(l => l.trim()).filter(l => l.length > 0));

  let content = original;
  let changed = false;
  for (const entry of entries) {
    if (!lines.has(entry)) {
      content += (content.length > 0 && !content.endsWith('\n') ? '\n' : '') + `${entry}\n`;
      lines.add(entry);
      changed = true;
    }
  }
  if (changed) fs.writeFileSync(gitignorePath, content);
  return { changed, created: changed && !preexisting };
}

/**
 * Configure production: write the pasted production connection string to
 * `.env.production` and ensure it is gitignored. Deliberately does NOT touch any
 * dev artifact (`.env.local`, the mock sidecar, generated source) and does NOT
 * introspect — production is expected to share the dev schema (sync it with
 * `npm run deploy`, not from inside a pull). Returns the path written and whether
 * `.gitignore` was updated. Exported for unit testing.
 */
export function writeProductionEnv(projectDir: string, connString: string): { path: string; gitignoreUpdated: boolean } {
  const envProdPath = path.join(projectDir, '.env.production');
  fs.writeFileSync(envProdPath, `${SUPABASE.connStringEnvVar}=${connString}\n`);
  const gi = ensureGitignored(projectDir, ['.env.production']);
  return { path: envProdPath, gitignoreUpdated: gi.changed };
}

/** Parse a dev/prod answer; defaults to dev (the safe choice) on empty/unknown. */
export function parseDevOrProd(answer: string): 'dev' | 'prod' {
  const a = answer.trim().toLowerCase();
  return a === 'prod' || a === 'production' || a === 'p' ? 'prod' : 'dev';
}

// ── Interactive flow (dev) ─────────────────────────────────────────────

/** Up-front statement of what a development pull does and does NOT do. */
function printDevBanner(): void {
  console.log(`Scope — \`db pull\` migrates the DATABASE layer only:
  • migrates: public-schema tables, types, type-safe CRUD, and RLS policies
  • does NOT migrate: Supabase Auth, Storage, Realtime, or Edge Functions
  • if you use a third-party OIDC provider (Auth0, Clerk, Google, Cognito),
    you can wire it into Blocks — see MIGRATION_GUIDE.md#auth
`);

  console.log('This sets up your app from your DEVELOPMENT database:');
  console.log('  • reads your schema (read-only introspection — your database is NOT modified)');
  console.log('  • writes local files only: generated code, .env.local (+ a local mock');
  console.log('    settings sidecar), .env.production.example, and migrations/000_baseline.sql');
  console.log('  • does NOT deploy and does NOT touch production');
  console.log('  • the connection string you paste is stored as your DEVELOPMENT connection\n');
}

async function dbPullDevInteractive(outputDir: string): Promise<void> {
  printDevBanner();
  console.log(SUPABASE_CONN_GUIDANCE.join('\n') + '\n');

  const connectionString = await promptPassword('Connection string: ');

  // Auto-detect the provider from the string (no one-item menu). Supabase encodes
  // the project ref in the username; its absence means we can't introspect it.
  const projectRef = extractProjectRef(connectionString);
  if (projectRef === undefined) {
    console.error('✗ Could not detect a supported provider from that connection string.');
    console.error('  Expected a Supabase URL: postgresql://postgres.<ref>:<password>@<host>:5432/postgres');
    process.exit(1);
  }
  console.log('  Detected provider: Supabase\n');

  // Optional: capture the project's CA certificate so the generated connection
  // verifies the server's TLS identity (otherwise it connects encrypted but
  // unverified). The CA is a public, non-secret cert; it is committed to
  // database.ca.ts and bundled into the deployed function.
  const caFilePath = path.join(outputDir, 'database.ca.ts');
  const hasExistingCa = fs.existsSync(caFilePath) && fs.readFileSync(caFilePath, 'utf-8').includes('-----BEGIN');
  console.log('TLS verification (recommended): download your CA certificate from the Supabase');
  console.log('dashboard → Database Settings → SSL Configuration (prod-ca-2021.crt).');
  const promptText = hasExistingCa
    ? '  Path to CA certificate [Enter to keep the existing one]: '
    : '  Path to CA certificate [Enter to skip]: ';
  const caPath = (await prompt(promptText)).trim();
  let caCert: string | undefined;
  if (caPath) {
    try {
      caCert = fs.readFileSync(caPath, 'utf-8');
      const caRel = path.join(path.basename(outputDir), 'database.ca.ts');
      console.log(`  ✓ CA captured. It will be written to ${caRel} (a public cert, committed with`);
      console.log(`    your app). The generated connection (resolveDbSsl in supabase.ts) pins it, so`);
      console.log(`    your database's TLS certificate is verified — both with \`npm run dev\` and in the`);
      console.log(`    deployed function (the file is bundled). Re-run \`bb-data pull\` to refresh a`);
      console.log(`    rotated CA. Details: MIGRATION_GUIDE.md → "Securing the connection (TLS)".\n`);
    } catch (e) {
      console.warn(`  ⚠ Could not read CA at "${caPath}": ${(e as Error).message}`);
      console.warn('    Continuing without it — the connection will be encrypted but UNVERIFIED.');
      console.warn('    Re-run `npx bb-data pull` with a valid path to enable verification.\n');
    }
  } else if (hasExistingCa) {
    console.log('  ✓ Keeping the CA already configured in database.ca.ts.\n');
  } else {
    console.log('  ⚠ Skipped — the connection will be encrypted but UNVERIFIED (no MITM protection).');
    console.log('    Re-run `npx bb-data pull` and provide the CA to enable verification.\n');
  }

  await dbPull({ connectionString, outputDir, projectRef, caCert });
}

// ── Interactive flow (prod) ────────────────────────────────────────────

async function dbPullProdInteractive(outputDir: string): Promise<void> {
  const projectDir = path.dirname(outputDir);

  console.log('Configure PRODUCTION:');
  console.log('  • writes your production connection string to .env.production (local file)');
  console.log('  • does NOT modify your database and does NOT deploy');
  console.log('  • to apply your schema to production, run `npm run deploy` afterward\n');

  // Gate: production mirrors a working dev setup. Refuse to bootstrap from prod.
  if (!hasDevConnection(projectDir)) {
    console.error('✗ No development database is set up yet.');
    console.error('  Production mirrors a working dev setup — set up development first:');
    console.error('    1. Run `npx bb-data pull` and choose "development".');
    console.error('    2. Once `npm run dev` works, run this again to configure production.');
    process.exit(1);
  }

  console.log(SUPABASE_CONN_GUIDANCE.join('\n'));
  console.log('  ⚠  Use a SEPARATE production project (or branch) — never your dev database.\n');

  const connectionString = await promptPassword('Production connection string: ');
  if (!detectSupabase(connectionString)) {
    console.error('✗ Could not detect a supported provider from that connection string.');
    console.error('  Expected a Supabase URL: postgresql://postgres.<ref>:<password>@<host>:5432/postgres');
    process.exit(1);
  }
  console.log('  Detected provider: Supabase\n');

  // Confirm before clobbering an existing .env.production.
  const envProdPath = path.join(projectDir, '.env.production');
  if (fs.existsSync(envProdPath)) {
    const ans = await prompt('  .env.production already exists. Overwrite? (y/N) ');
    if (ans.toLowerCase() !== 'y') {
      console.log('  Aborted — left .env.production unchanged.');
      process.exit(0);
    }
  }

  const result = writeProductionEnv(projectDir, connectionString);
  console.log(`✓ Wrote ${result.path}`);
  if (result.gitignoreUpdated) console.log('✓ Updated .gitignore');

  console.log('\n─────────────────────────────────────────');
  console.log('What to do next');
  console.log('─────────────────────────────────────────\n');
  console.log('  1. Set any other production secrets (e.g. an OIDC client secret) — see MIGRATION_GUIDE.md#deploy-to-production');
  console.log('  2. Deploy to production:  npm run deploy');
}

// ── Interactive entry point ────────────────────────────────────────────

export async function dbPullInteractive(outputDir: string): Promise<void> {
  console.log('\n📦 Blocks Database Pull\n');

  const answer = await prompt('Is this a development or production database? (dev/prod) [dev] ');
  console.log('');
  if (parseDevOrProd(answer) === 'prod') {
    await dbPullProdInteractive(outputDir);
  } else {
    await dbPullDevInteractive(outputDir);
  }
}

// ── CLI entry point ────────────────────────────────────────────────────

export async function runDbPullCli(): Promise<void> {
  const args = process.argv.slice(3); // skip 'node', 'cli.js', 'pull'
  const outputDir = args.find(a => !a.startsWith('--')) ?? './aws-blocks';

  // `db pull` is an interactive, human-driven onboarding command: it prompts for
  // dev/prod intent and the connection string, so it needs a terminal. Fail fast
  // with guidance instead of hanging on a prompt when stdin isn't a TTY (CI/pipes).
  if (!process.stdin.isTTY) {
    console.error('✗ `db pull` is interactive — run it in a terminal.');
    process.exit(1);
  }

  try {
    await dbPullInteractive(outputDir);
  } catch (err) {
    console.error(`✗ ${(err as Error).message}`);
    process.exit(1);
  }
}
