// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * `bb-data migrate` / `status` / `generate-types` on a local (PGlite) app: they
 * work on the database the dev mock uses (`.bb-data/<fullId>`), never on
 * `.bb-data` itself, and never alongside another process that has it open.
 */

import { test } from 'node:test';
import assert from 'node:assert';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const distDir = dirname(fileURLToPath(import.meta.url));
const CLI = join(distDir, 'cli.js');

/** The test runner's env minus connection-string variables, so the app is local. */
const localEnv = Object.fromEntries(
  Object.entries(process.env).filter(([name]) => !/_(DB_URL|CONNECTION_STRING)$/.test(name) && name !== 'BLOCKS_MIGRATE_URL'),
);

interface Result {
  status: number | null;
  stdout: string;
  stderr: string;
}

function collect(child: ChildProcess): Promise<Result> {
  let stdout = '';
  let stderr = '';
  child.stdout?.on('data', (d) => (stdout += d));
  child.stderr?.on('data', (d) => (stderr += d));
  return new Promise((resolve) => child.on('close', (status) => resolve({ status, stdout, stderr })));
}

function runCli(args: string[], cwd: string): Promise<Result> {
  return collect(spawn(process.execPath, [CLI, ...args], { cwd, env: localEnv, stdio: ['ignore', 'pipe', 'pipe'] }));
}

/**
 * A scaffold-like app: `migrations/001_notes.sql`, and `app.mjs`, which opens the dev
 * mock's `new Database(new Scope('app'), 'main')` (fullId `app-main`) and runs one
 * query, as the first request to `npm run dev` does. With `hold`, it then keeps the
 * database open until its stdin closes.
 */
function makeApp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'bb-data-cli-local-'));
  mkdirSync(join(dir, 'migrations'));
  writeFileSync(join(dir, 'migrations', '001_notes.sql'), 'CREATE TABLE notes (n INT PRIMARY KEY);\n');
  // Resolved here (from inside the package) and imported by URL, so the child app needs no node_modules.
  const coreUrl = import.meta.resolve('@aws-blocks/core');
  const mockUrl = pathToFileURL(join(distDir, 'index.mock.js')).href;
  writeFileSync(
    join(dir, 'app.mjs'),
    `const { Scope } = await import(${JSON.stringify(coreUrl)});
const { Database, sql } = await import(${JSON.stringify(mockUrl)});
const db = new Database(new Scope('app'), 'main', { migrationsPath: './migrations' });
const rows = await db.query(sql\`SELECT count(*)::int AS n FROM notes\`);
console.log('READY ' + rows[0].n);
if (process.argv[2] === 'hold') {
  process.stdin.resume();
  process.stdin.on('end', () => process.exit(0));
}
`,
  );
  return dir;
}

function startApp(dir: string, hold = false): { child: ChildProcess; ready: Promise<void>; done: Promise<Result> } {
  const child = spawn(process.execPath, ['app.mjs', ...(hold ? ['hold'] : [])], { cwd: dir, env: localEnv });
  const done = collect(child);
  const ready = new Promise<void>((resolve, reject) => {
    child.stdout?.on('data', (d) => String(d).includes('READY') && resolve());
    done.then((r) => reject(new Error(`app exited before it was ready: ${r.stderr}`)));
  });
  return { child, ready, done };
}

test('status on a local app reports what the dev mock applied, without seeding a placeholder secret', async () => {
  const dir = makeApp();
  try {
    const app = startApp(dir);
    await app.ready;
    assert.strictEqual((await app.done).status, 0);

    const r = await runCli(['status', 'migrations'], dir);
    assert.strictEqual(r.status, 0, r.stderr);
    assert.match(r.stdout, /Total: 1 \| Applied: 1 \| Pending: 0/);
    assert.doesNotMatch(r.stderr, /external database/i);
    // Reading AppSetting through the mock used to invent and save this secret.
    const settings = join(dir, '.bb-data', 'settings.json');
    assert.ok(!existsSync(settings) || !readFileSync(settings, 'utf8').includes('db-url'));
    // It opened the dev database, not a cluster at .bb-data itself.
    assert.strictEqual(existsSync(join(dir, '.bb-data', 'PG_VERSION')), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('migrate --block applies to .bb-data/<id>, the directory the dev mock then opens', async () => {
  const dir = makeApp();
  try {
    const first = await runCli(['migrate', 'migrations', '--block', 'app-main'], dir);
    assert.strictEqual(first.status, 0, first.stderr);
    assert.match(first.stdout, /Applied 1 migration/);
    assert.strictEqual(existsSync(join(dir, '.bb-data', 'app-main', 'PG_VERSION')), true);
    assert.strictEqual(existsSync(join(dir, '.bb-data', 'PG_VERSION')), false);

    const again = await runCli(['migrate', 'migrations'], dir);
    assert.strictEqual(again.status, 0, again.stderr);
    assert.match(again.stdout, /No pending migrations/);

    const app = startApp(dir);
    await app.ready;
    const result = await app.done;
    assert.strictEqual(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stdout, /\[migrations\] Applied/, 'the mock found the migration already applied');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('migrate refuses while another process has the database open', async () => {
  const dir = makeApp();
  try {
    const app = startApp(dir, true);
    await app.ready;
    const r = await runCli(['migrate', 'migrations'], dir);
    app.child.stdin?.end();
    assert.strictEqual((await app.done).status, 0);

    assert.strictEqual(r.status, 1);
    assert.match(r.stderr, /open in another process/);
    assert.match(r.stderr, /npm run dev:stop/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('three concurrent migrate runs all succeed, apply once, and leave .bb-data in place', async () => {
  const dir = makeApp();
  try {
    mkdirSync(join(dir, '.bb-data'));
    writeFileSync(join(dir, '.bb-data', 'settings.json'), '{"keep":"me"}');

    const runs = await Promise.all([1, 2, 3].map(() => runCli(['migrate', 'migrations', '--block', 'app-main'], dir)));
    for (const r of runs) assert.strictEqual(r.status, 0, r.stderr);
    assert.strictEqual(runs.filter((r) => /Applied 1 migration/.test(r.stdout)).length, 1);
    assert.strictEqual(readFileSync(join(dir, '.bb-data', 'settings.json'), 'utf8'), '{"keep":"me"}');
    const quarantined = [...readdirSync(dir), ...readdirSync(join(dir, '.bb-data'))].filter((e) => e.includes('.corrupt-'));
    assert.deepStrictEqual(quarantined, []);

    const status = await runCli(['status', 'migrations'], dir);
    assert.match(status.stdout, /Applied: 1 \| Pending: 0/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('with several local databases and no --block, status lists them', async () => {
  const dir = makeApp();
  try {
    for (const id of ['app-a', 'app-b']) {
      const r = await runCli(['migrate', 'migrations', '--block', id], dir);
      assert.strictEqual(r.status, 0, r.stderr);
    }
    const r = await runCli(['status', 'migrations'], dir);
    assert.strictEqual(r.status, 1);
    assert.match(r.stderr, /app-a, app-b/);
    assert.match(r.stderr, /--block/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('with no local database yet, status reports all pending and migrate says how to get one; neither creates it', async () => {
  const dir = makeApp();
  try {
    const status = await runCli(['status', 'migrations'], dir);
    assert.strictEqual(status.status, 0, status.stderr);
    assert.match(status.stdout, /Applied: 0 \| Pending: 1/);

    const migrate = await runCli(['migrate', 'migrations'], dir);
    assert.strictEqual(migrate.status, 1);
    assert.match(migrate.stderr, /npm run dev/);
    assert.match(migrate.stderr, /--block/);
    assert.strictEqual(existsSync(join(dir, '.bb-data')), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
