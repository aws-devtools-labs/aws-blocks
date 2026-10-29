// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import ts from 'typescript';
import { createCrudHandlers } from '../crud/index.js';
import type { CrudOptions, TableSchema, TableTypeMeta } from '../crud/types.js';
import { RLSEnabledDatabase } from '../database.js';
import { PGliteEngine } from '../engines/pglite-engine.js';
import { GUIDE_AUTH_TO_LIMITATIONS, GUIDE_USERID_NOTE, WIRING_CRUD_FN, WIRING_RESOLVE_SSL_FN } from './templates.js';

/**
 * The generated wiring is emitted as a TypeScript *string* and only ever
 * type-checked (via the db-pull-typecheck app), never executed in our suite. To
 * actually exercise the security-critical branches of the emitted
 * `resolveDbSsl()` — most importantly the deployed-Lambda fail-closed path — we
 * transpile the snippet to JS and run it with injected dependencies.
 */
function buildResolveDbSsl(opts: {
  committedCa: string;
  env: Record<string, string | undefined>;
  files?: Record<string, string>;
}): () => { ca?: string; rejectUnauthorized: boolean } {
  const js = ts.transpileModule(WIRING_RESOLVE_SSL_FN, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText;

  const readFileSync = (p: string): string => {
    const f = opts.files?.[p];
    if (f === undefined) {
      const err = new Error(`ENOENT: no such file, open '${p}'`);
      throw err;
    }
    return f;
  };
  const fakeProcess = { env: opts.env } as unknown as NodeJS.Process;
  const silentConsole = { log() {}, warn() {} } as unknown as Console;

  // eslint-disable-next-line no-new-func
  const factory = new Function(
    'readFileSync',
    'DATABASE_CA_CERT',
    'process',
    'console',
    `${js}\n;return resolveDbSsl;`,
  );
  return factory(readFileSync, opts.committedCa, fakeProcess, silentConsole);
}

const PEM = '-----BEGIN CERTIFICATE-----\nMIIBexample\n-----END CERTIFICATE-----';

describe('generated resolveDbSsl() runtime behavior', () => {
  test('deployed Lambda with no CA → fails closed (throws)', () => {
    const resolveDbSsl = buildResolveDbSsl({
      committedCa: '',
      env: { AWS_LAMBDA_FUNCTION_NAME: 'my-fn' },
    });
    assert.throws(() => resolveDbSsl(), /refusing to connect without verifying/);
  });

  test('local dev with no CA → encrypted but unverified (no throw)', () => {
    const resolveDbSsl = buildResolveDbSsl({ committedCa: '', env: {} });
    assert.deepStrictEqual(resolveDbSsl(), { rejectUnauthorized: false });
  });

  test('committed database.ca.ts cert → pins CA and verifies (works in Lambda)', () => {
    const resolveDbSsl = buildResolveDbSsl({
      committedCa: PEM,
      env: { AWS_LAMBDA_FUNCTION_NAME: 'my-fn' },
    });
    assert.deepStrictEqual(resolveDbSsl(), { ca: PEM, rejectUnauthorized: true });
  });

  test('DATABASE_CA_CERT inline PEM overrides the committed cert', () => {
    const override = '-----BEGIN CERTIFICATE-----\nOVERRIDE\n-----END CERTIFICATE-----';
    const resolveDbSsl = buildResolveDbSsl({
      committedCa: PEM,
      env: { DATABASE_CA_CERT: override },
    });
    assert.deepStrictEqual(resolveDbSsl(), { ca: override, rejectUnauthorized: true });
  });

  test('DATABASE_CA_CERT as a file path reads and pins the cert', () => {
    const resolveDbSsl = buildResolveDbSsl({
      committedCa: '',
      env: { DATABASE_CA_CERT: '/etc/ssl/prod-ca-2021.crt' },
      files: { '/etc/ssl/prod-ca-2021.crt': PEM },
    });
    assert.deepStrictEqual(resolveDbSsl(), { ca: PEM, rejectUnauthorized: true });
  });

  test('DATABASE_CA_CERT pointing at a missing file → clear TLS error', () => {
    const resolveDbSsl = buildResolveDbSsl({
      committedCa: '',
      env: { DATABASE_CA_CERT: '/nope/missing.crt' },
    });
    assert.throws(() => resolveDbSsl(), /could not read the CA/);
  });

  test('DATABASE_CA_CERT file that is not a certificate → rejected', () => {
    const resolveDbSsl = buildResolveDbSsl({
      committedCa: '',
      env: { DATABASE_CA_CERT: '/etc/ssl/notacert.txt' },
      files: { '/etc/ssl/notacert.txt': 'not a pem' },
    });
    assert.throws(() => resolveDbSsl(), /not a PEM certificate/);
  });
});

// ── supabaseCrud(): which subject Postgres RLS sees ─────────────────────────

/**
 * What `Auth.requireAuth()` returns (`AuthenticatedUser` in `@aws-blocks/bb-auth`)
 * for the two kinds of user, field for field: a user who signed in through an
 * `oidcProviders` entry directly (userId `${iss}:${sub}`, the provider's verified
 * `claims`), and a Cognito user-pool user (no `claims`).
 */
const ISSUER = 'https://tenant.auth0.com/';
const RAW_SUB = 'auth0|abc123';
const DIRECT_OIDC_USER = {
  userId: `${ISSUER}:${RAW_SUB}`,
  username: 'Ada',
  userSub: `${ISSUER}:${RAW_SUB}`,
  groups: [],
  attributes: { email: 'ada@example.com' },
  signInProvider: 'auth0',
  claims: Object.freeze({ iss: ISSUER, sub: RAW_SUB, aud: 'client-1', email: 'ada@example.com' }),
};
const POOL_USER = {
  userId: 'pat',
  username: 'pat',
  userSub: '8f1b6d1e-0000-4000-8000-000000000001',
  groups: [],
  attributes: {},
  signInProvider: 'password',
};

const RLS_DIR = `.bb-data-wiring-rls-${process.pid}`;
let rlsEngine: PGliteEngine | undefined;

afterEach(async () => {
  if (rlsEngine) await rlsEngine.destroy().catch(() => {});
  rlsEngine = undefined;
  rmSync(RLS_DIR, { recursive: true, force: true });
});

/** A migrated Supabase table whose RLS policy matches the raw provider `sub`, as Supabase apps write it. */
async function supabaseNotes(): Promise<RLSEnabledDatabase> {
  rlsEngine = new PGliteEngine(RLS_DIR);
  await rlsEngine.execute(`DO $$ BEGIN
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
  END $$`);
  await rlsEngine.execute(`GRANT USAGE ON SCHEMA public TO authenticated`);
  await rlsEngine.execute(`CREATE TABLE notes (
    id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
    body TEXT NOT NULL,
    user_id TEXT NOT NULL DEFAULT (current_setting('request.jwt.claims', true)::jsonb->>'sub')
  )`);
  await rlsEngine.execute(`ALTER TABLE notes ENABLE ROW LEVEL SECURITY`);
  await rlsEngine.execute(`CREATE POLICY own_notes ON notes FOR ALL TO authenticated
    USING (user_id = current_setting('request.jwt.claims', true)::jsonb->>'sub')
    WITH CHECK (user_id = current_setting('request.jwt.claims', true)::jsonb->>'sub')`);
  await rlsEngine.execute(`GRANT SELECT, INSERT, UPDATE, DELETE ON notes TO authenticated`);
  await rlsEngine.execute(`INSERT INTO notes (id, body, user_id) VALUES ('n1', 'from Supabase', '${RAW_SUB}')`);
  return new RLSEnabledDatabase(rlsEngine);
}

type Handlers = Record<string, (...args: unknown[]) => Promise<any>>;

/** Run the generated `supabaseCrud()` against `rlsDb`, with `user` as what `auth.requireAuth()` returns. */
function generatedSupabaseCrud(rlsDb: RLSEnabledDatabase, user: object): Handlers {
  const schema: TableSchema = {
    notes: { singular: 'note', plural: 'notes', primaryKey: 'id', columns: ['id', 'body', 'user_id'], autoGenerated: ['id', 'user_id'] },
  };
  const js = ts.transpileModule(WIRING_CRUD_FN.replace(/^export /m, ''), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText;
  const db = { crud: (options: CrudOptions<Record<string, TableTypeMeta>>) => createCrudHandlers(rlsDb, schema, options) };
  // eslint-disable-next-line no-new-func
  const supabaseCrud = new Function('db', 'tableMeta', `${js}\n;return supabaseCrud;`)(db, schema);
  return supabaseCrud({}, { requireAuth: async () => user });
}

describe('generated supabaseCrud(): the subject Postgres RLS sees', () => {
  test('a directly federated Auth user: claims.sub (the raw provider sub), so migrated rows keep matching', async () => {
    const crud = generatedSupabaseCrud(await supabaseNotes(), DIRECT_OIDC_USER);
    assert.deepEqual((await crud.listNotes()).map((r: { id: string }) => r.id), ['n1'], 'the Supabase-era row is visible');
    const created = await crud.createNote({ body: 'new' });
    assert.equal(created.user_id, RAW_SUB, 'Postgres saw request.jwt.claims.sub = the raw sub, not the prefixed userId');
  });

  test('a user-pool Auth user (no claims): RLS sees userId', async () => {
    const crud = generatedSupabaseCrud(await supabaseNotes(), POOL_USER);
    assert.deepEqual(await crud.listNotes(), [], 'rows keyed on another subject stay hidden');
    const created = await crud.createNote({ body: 'mine' });
    assert.equal(created.user_id, POOL_USER.userId);
  });

  test('the generated MIGRATION_GUIDE.md describes exactly that', () => {
    const guide = GUIDE_AUTH_TO_LIMITATIONS + GUIDE_USERID_NOTE;
    assert.match(guide, /`claims\.sub` \(the raw provider\s+`sub`\) is what reaches RLS/);
    assert.match(guide, /has no `claims`, so RLS sees their `userId`/);
    // AuthenticatedUser.claims is optional (direct federation only): the guide never reads it unguarded.
    assert.doesNotMatch(guide, /user\.claims\.sub/);
    assert.match(guide, /user\.claims\?\.sub/);
  });
});
