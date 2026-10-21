// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for the R1 dev/prod routing helpers: the dev-vs-prod intent parse,
 * the "is dev set up?" gate that production configuration depends on, and the
 * `.env.production` writer. All are DB-free and TTY-free (no prompts), so they
 * cover the routing decisions without driving the interactive orchestration.
 *
 * The `dbPull` env-file tests run the real orchestration in a child process with
 * only introspection and the pg_dump baseline stubbed, then read `.env.local`
 * back through `@aws-blocks/core`'s env loader — the same path `npm run dev` and
 * `npm run sandbox` take.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { parseEnv } from 'node:util';
import { ensureGitignored, hasDevConnection, parseDevOrProd, writeProductionEnv } from './pull.js';

const SUPA_DEV = 'postgresql://postgres.devref0001:pw@aws-0-us-east-1.pooler.supabase.com:5432/postgres';
const SUPA_PROD = 'postgresql://postgres.prodref9999:pw@aws-0-us-east-1.pooler.supabase.com:5432/postgres';

function tmpProject(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'db-pull-r1-'));
}

describe('parseDevOrProd', () => {
  test('defaults to dev on empty input (the safe choice)', () => {
    assert.equal(parseDevOrProd(''), 'dev');
    assert.equal(parseDevOrProd('   '), 'dev');
  });

  test('recognizes prod / production / p (case-insensitive)', () => {
    assert.equal(parseDevOrProd('prod'), 'prod');
    assert.equal(parseDevOrProd('PRODUCTION'), 'prod');
    assert.equal(parseDevOrProd('  Prod '), 'prod');
    assert.equal(parseDevOrProd('p'), 'prod');
  });

  test('recognizes dev and falls back to dev on anything unknown', () => {
    assert.equal(parseDevOrProd('dev'), 'dev');
    assert.equal(parseDevOrProd('development'), 'dev');
    assert.equal(parseDevOrProd('whatever'), 'dev');
  });
});

describe('hasDevConnection (production prerequisite gate)', () => {
  test('false when .env.local is absent', () => {
    const dir = tmpProject();
    try {
      assert.equal(hasDevConnection(dir), false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('true when .env.local holds a non-empty SUPABASE_DB_URL', () => {
    const dir = tmpProject();
    try {
      fs.writeFileSync(path.join(dir, '.env.local'), `SUPABASE_DB_URL=${SUPA_DEV}\n`);
      assert.equal(hasDevConnection(dir), true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('true when .env.local holds a non-empty `export SUPABASE_DB_URL=` entry', () => {
    const dir = tmpProject();
    try {
      fs.writeFileSync(path.join(dir, '.env.local'), `# dev\nexport SUPABASE_DB_URL=${SUPA_DEV} # dev db\n`);
      assert.equal(hasDevConnection(dir), true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('reads the value as core\'s loader does (a commented-out or empty export does not count)', () => {
    const dir = tmpProject();
    try {
      fs.writeFileSync(path.join(dir, '.env.local'), `# SUPABASE_DB_URL=${SUPA_DEV}\nexport SUPABASE_DB_URL=\n`);
      assert.equal(hasDevConnection(dir), false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('false when the connection var is present but empty', () => {
    const dir = tmpProject();
    try {
      fs.writeFileSync(path.join(dir, '.env.local'), 'SUPABASE_DB_URL=\n');
      assert.equal(hasDevConnection(dir), false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('false when .env.local has unrelated vars only', () => {
    const dir = tmpProject();
    try {
      fs.writeFileSync(path.join(dir, '.env.local'), 'SOME_OTHER=1\nFOO=bar\n');
      assert.equal(hasDevConnection(dir), false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('writeProductionEnv', () => {
  test('writes .env.production with the connection string and does not touch dev artifacts', () => {
    const dir = tmpProject();
    try {
      // Seed dev artifacts that must remain untouched.
      fs.writeFileSync(path.join(dir, '.env.local'), `SUPABASE_DB_URL=${SUPA_DEV}\n`);

      const result = writeProductionEnv(dir, SUPA_PROD);

      assert.equal(result.path, path.join(dir, '.env.production'));
      assert.equal(
        fs.readFileSync(path.join(dir, '.env.production'), 'utf-8'),
        `SUPABASE_DB_URL=${SUPA_PROD}\n`,
      );
      // Dev connection is unchanged — prod config must not rewrite .env.local.
      assert.equal(
        fs.readFileSync(path.join(dir, '.env.local'), 'utf-8'),
        `SUPABASE_DB_URL=${SUPA_DEV}\n`,
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('adds .env.production to an existing .gitignore exactly once', () => {
    const dir = tmpProject();
    try {
      fs.writeFileSync(path.join(dir, '.gitignore'), 'node_modules\n.env.local\n');
      const first = writeProductionEnv(dir, SUPA_PROD);
      assert.equal(first.gitignoreUpdated, true);
      const gitignore = fs.readFileSync(path.join(dir, '.gitignore'), 'utf-8');
      assert.ok(gitignore.includes('.env.production'), 'gitignore now ignores .env.production');

      // Idempotent: a second write does not append a duplicate entry.
      const second = writeProductionEnv(dir, SUPA_PROD);
      assert.equal(second.gitignoreUpdated, false);
      const occurrences = gitignore.split('.env.production').length - 1;
      assert.equal(occurrences, 1, 'no duplicate .env.production line');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('creates a .gitignore (ignoring .env.production) when none exists — credential safety', () => {
    const dir = tmpProject();
    try {
      const result = writeProductionEnv(dir, SUPA_PROD);
      assert.equal(result.gitignoreUpdated, true);
      const gitignorePath = path.join(dir, '.gitignore');
      assert.equal(fs.existsSync(gitignorePath), true, '.gitignore was created');
      assert.ok(
        fs.readFileSync(gitignorePath, 'utf-8').includes('.env.production'),
        'the created .gitignore ignores .env.production',
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('keeps every other entry, comment and blank line of an existing .env.production', () => {
    const dir = tmpProject();
    try {
      const envProdPath = path.join(dir, '.env.production');
      fs.writeFileSync(envProdPath, '# production\nOTHER_SECRET=value\n\nexport AWS_PROFILE=prod # deploy profile\n');
      writeProductionEnv(dir, SUPA_PROD);
      assert.equal(
        fs.readFileSync(envProdPath, 'utf-8'),
        `# production\nOTHER_SECRET=value\n\nexport AWS_PROFILE=prod # deploy profile\nSUPABASE_DB_URL=${SUPA_PROD}\n`,
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('replaces an existing SUPABASE_DB_URL in place instead of adding a second one', () => {
    const dir = tmpProject();
    try {
      const envProdPath = path.join(dir, '.env.production');
      fs.writeFileSync(envProdPath, `A=1\nSUPABASE_DB_URL=${SUPA_DEV} # old\nB=2\n`);
      writeProductionEnv(dir, SUPA_PROD);
      assert.equal(fs.readFileSync(envProdPath, 'utf-8'), `A=1\nSUPABASE_DB_URL=${SUPA_PROD}\nB=2\n`);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('keeps the permissions of an existing .env.production', { skip: process.platform === 'win32' }, () => {
    const dir = tmpProject();
    try {
      const envProdPath = path.join(dir, '.env.production');
      fs.writeFileSync(envProdPath, 'OTHER_SECRET=value\n', { mode: 0o600 });
      fs.chmodSync(envProdPath, 0o600);
      writeProductionEnv(dir, SUPA_PROD);
      assert.equal(fs.statSync(envProdPath).mode & 0o777, 0o600);
      assert.equal(fs.readFileSync(envProdPath, 'utf-8'), `OTHER_SECRET=value\nSUPABASE_DB_URL=${SUPA_PROD}\n`);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('quotes a connection string that would otherwise be cut at "#"', () => {
    const dir = tmpProject();
    try {
      const conn = 'postgresql://postgres.prodref9999:p#ss=w0rd@aws-0-us-east-1.pooler.supabase.com:5432/postgres';
      writeProductionEnv(dir, conn);
      const parsed = parseEnv(fs.readFileSync(path.join(dir, '.env.production'), 'utf-8'));
      assert.equal(parsed.SUPABASE_DB_URL, conn);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('ensureGitignored', () => {
  test('creates .gitignore with the entries when none exists', () => {
    const dir = tmpProject();
    try {
      const r = ensureGitignored(dir, ['.env.local', '.env.production']);
      assert.deepEqual(r, { changed: true, created: true });
      const content = fs.readFileSync(path.join(dir, '.gitignore'), 'utf-8');
      assert.ok(content.includes('.env.local'));
      assert.ok(content.includes('.env.production'));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('appends only missing entries to an existing .gitignore (changed, not created)', () => {
    const dir = tmpProject();
    try {
      fs.writeFileSync(path.join(dir, '.gitignore'), 'node_modules\n.env.local\n');
      const r = ensureGitignored(dir, ['.env.local', '.env.production']);
      assert.deepEqual(r, { changed: true, created: false });
      const content = fs.readFileSync(path.join(dir, '.gitignore'), 'utf-8');
      assert.equal(content.split('.env.local').length - 1, 1, 'no duplicate .env.local');
      assert.ok(content.includes('.env.production'));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('is a no-op when all entries are already present', () => {
    const dir = tmpProject();
    try {
      fs.writeFileSync(path.join(dir, '.gitignore'), '.env.local\n.env.production\n');
      const r = ensureGitignored(dir, ['.env.local', '.env.production']);
      assert.deepEqual(r, { changed: false, created: false });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('matches whole lines — .env.production.example does not mask .env.production', () => {
    const dir = tmpProject();
    try {
      fs.writeFileSync(path.join(dir, '.gitignore'), '.env.production.example\n');
      const r = ensureGitignored(dir, ['.env.production']);
      assert.equal(r.changed, true, '.env.production added despite the .example substring');
      const lines = fs.readFileSync(path.join(dir, '.gitignore'), 'utf-8').split('\n');
      assert.ok(lines.includes('.env.production'), 'exact .env.production line present');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── dbPull writes .env.local (real orchestration, introspection stubbed) ──

const pullUrl = new URL('./pull.js', import.meta.url).href;
const childScript = (conn: string) => `
import { mock } from 'node:test';
const introspectUrl = ${JSON.stringify(new URL('./introspect.js', import.meta.url).href)};
const baselineUrl = ${JSON.stringify(new URL('../migrations/baseline.js', import.meta.url).href)};
// The real modules are loaded first so the stubs keep their other exports.
const realIntrospect = await import(introspectUrl);
const realBaseline = await import(baselineUrl);
mock.module(introspectUrl, {
  namedExports: {
    ...realIntrospect,
    introspect: async () => ({
      tables: [{
        name: 'notes',
        columns: [{ table_name: 'notes', column_name: 'id', data_type: 'uuid', is_nullable: 'NO', column_default: 'gen_random_uuid()', ordinal_position: 1 }],
        primaryKey: 'id',
        autoGenerated: ['id'],
        hasRls: false,
        missingGrants: false,
      }],
      tablesUsingSupabaseAuth: new Set(),
      nonStandardClaims: new Map(),
    }),
  },
});
mock.module(baselineUrl, {
  namedExports: { ...realBaseline, generateBaseline: async () => ({ written: false, path: 'migrations/000_baseline.sql' }) },
});
// Imported only after mock.module() so pull.js binds to the stubs above.
const { dbPull } = await import(${JSON.stringify(pullUrl)});
await dbPull({ connectionString: ${JSON.stringify(conn)}, outputDir: 'aws-blocks', projectRef: 'devref0001' });
const { loadEnvFile } = await import(${JSON.stringify(import.meta.resolve('@aws-blocks/core/scripts'))});
loadEnvFile('.env.local');
const seen = {};
for (const k of ['SUPABASE_DB_URL', 'AWS_PROFILE', 'OIDC_CLIENT_SECRET', 'QUOTED', 'EXPORTED', 'DUP']) seen[k] = process.env[k];
console.log('ENV=' + JSON.stringify(seen));
`;

/** Run `dbPull` in a child process in `dir`, answering "y" to its consent prompt. */
function spawnDbPull(dir: string, conn: string) {
  return spawnSync(
    process.execPath,
    ['--experimental-test-module-mocks', '--no-warnings', '--input-type=module', '-e', childScript(conn)],
    {
      cwd: dir,
      input: 'y\n',
      encoding: 'utf8',
      timeout: 30_000,
      env: { PATH: process.env.PATH, HOME: dir, AWS_BLOCKS_DISABLE_TELEMETRY: '1' },
    },
  );
}

/** Run `dbPull` in `dir` and require it to succeed; returns what core's env loader then reads. */
function runDbPull(dir: string, conn: string): Record<string, string | undefined> {
  const child = spawnDbPull(dir, conn);
  assert.equal(child.status, 0, `dbPull child failed:\n${child.stdout}\n${child.stderr}`);
  const line = child.stdout.split('\n').find(l => l.startsWith('ENV='));
  assert.ok(line, `dbPull child produced no env report:\n${child.stdout}`);
  return JSON.parse(line.slice('ENV='.length));
}

describe('dbPull .env.local handling', () => {
  test('updates only SUPABASE_DB_URL, keeping other settings, comments, order and permissions', { skip: process.platform === 'win32' }, () => {
    const dir = tmpProject();
    try {
      const envPath = path.join(dir, '.env.local');
      const before = [
        '# local settings',
        'AWS_PROFILE=deployment',
        `SUPABASE_DB_URL=${SUPA_PROD}`,
        '',
        'OIDC_CLIENT_SECRET=keep-me',
        'QUOTED="a # b = c"',
        'export EXPORTED=yes',
        'DUP=first',
        'DUP=second',
        '',
      ].join('\n');
      fs.writeFileSync(envPath, before, { mode: 0o600 });
      fs.chmodSync(envPath, 0o600);

      const seen = runDbPull(dir, SUPA_DEV);

      assert.equal(fs.readFileSync(envPath, 'utf-8'), before.replace(SUPA_PROD, SUPA_DEV));
      assert.equal(fs.statSync(envPath).mode & 0o777, 0o600);
      assert.deepEqual(seen, {
        SUPABASE_DB_URL: SUPA_DEV,
        AWS_PROFILE: 'deployment',
        OIDC_CLIENT_SECRET: 'keep-me',
        QUOTED: 'a # b = c',
        EXPORTED: 'yes',
        DUP: 'second',
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('creates .env.local when missing', () => {
    const dir = tmpProject();
    try {
      const seen = runDbPull(dir, SUPA_DEV);
      assert.equal(fs.readFileSync(path.join(dir, '.env.local'), 'utf-8'), `SUPABASE_DB_URL=${SUPA_DEV}\n`);
      assert.equal(seen.SUPABASE_DB_URL, SUPA_DEV);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('production is eligible after a dev pull updates an exported SUPABASE_DB_URL', () => {
    const dir = tmpProject();
    try {
      const envPath = path.join(dir, '.env.local');
      fs.writeFileSync(envPath, 'export SUPABASE_DB_URL=postgresql://old\nAWS_PROFILE=deployment\n');
      const seen = runDbPull(dir, SUPA_DEV);
      assert.equal(fs.readFileSync(envPath, 'utf-8'), `export SUPABASE_DB_URL=${SUPA_DEV}\nAWS_PROFILE=deployment\n`);
      assert.equal(seen.SUPABASE_DB_URL, SUPA_DEV);
      assert.equal(hasDevConnection(dir), true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a connection string containing "#" reads back intact through core\'s loader', () => {
    const dir = tmpProject();
    try {
      const conn = 'postgresql://postgres.devref0001:p#ss=w0rd@aws-0-us-east-1.pooler.supabase.com:5432/postgres';
      fs.writeFileSync(path.join(dir, '.env.local'), 'AWS_PROFILE=deployment\r\n');
      const seen = runDbPull(dir, conn);
      assert.equal(seen.SUPABASE_DB_URL, conn);
      assert.equal(seen.AWS_PROFILE, 'deployment');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('fails before generating anything when .env.local cannot be updated', () => {
    const dir = tmpProject();
    try {
      // Node reads this file as A="SUPABASE_DB_URL=old", so no edit keeps A as it is.
      const envPath = path.join(dir, '.env.local');
      const before = 'A= \nSUPABASE_DB_URL=old\n';
      fs.writeFileSync(envPath, before);

      const child = spawnDbPull(dir, SUPA_DEV);

      assert.notEqual(child.status, 0, `dbPull should fail:\n${child.stdout}`);
      assert.match(child.stderr, /Could not update SUPABASE_DB_URL without changing how other entries are read \(A\)/);
      for (const file of ['database.types.ts', 'database.meta.ts', 'database.ca.ts', 'supabase.ts', 'MIGRATION_GUIDE.md']) {
        assert.equal(fs.existsSync(path.join(dir, 'aws-blocks', file)), false, `${file} must not be written`);
      }
      assert.equal(fs.existsSync(path.join(dir, '.bb-data', 'settings.json')), false, 'db-url AppSetting must not be seeded');
      assert.equal(fs.readFileSync(envPath, 'utf-8'), before);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
