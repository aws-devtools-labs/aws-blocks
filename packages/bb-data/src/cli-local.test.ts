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
import { PGliteEngine } from './engines/pglite-engine.js';

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

const helperUrl = pathToFileURL(join(distDir, 'local-database.js')).href;
const engineUrl = pathToFileURL(join(distDir, 'engines', 'pglite-engine.js')).href;

/** Start a `cli`-role process (what a `bb-data` command does) that holds the lock until its stdin closes. */
async function startCliHolder(dir: string): Promise<{ pid: number; end: () => Promise<Result> }> {
  const script = `const { lockLocalDatabase, localDatabaseDir } = await import(${JSON.stringify(helperUrl)});
lockLocalDatabase(localDatabaseDir('app-main'), 'cli');
console.log('LOCKED');
process.stdin.resume();
process.stdin.on('end', () => process.exit(0));`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], { cwd: dir, env: localEnv });
  const done = collect(child);
  await new Promise<void>((resolve, reject) => {
    child.stdout?.on('data', (d) => String(d).includes('LOCKED') && resolve());
    done.then((r) => reject(new Error(`the holder exited before it took the lock: ${r.stderr}`)));
  });
  return {
    pid: child.pid ?? -1,
    end: () => {
      child.stdin?.end();
      return done;
    },
  };
}

test('when a bb-data command holds the database, the dev mock waits instead of opening it', async () => {
  const dir = makeApp();
  try {
    const holder = await startCliHolder(dir);
    const lock = join(dir, '.bb-data', 'app-main.lock');
    const app = startApp(dir);
    let ready = false;
    app.ready.then(() => (ready = true), () => {});

    // The app is waiting once its own candidate lock record exists next to the lock
    // (it writes `<lock>.<pid>-<uuid>` before trying to take the lock, and keeps it while it waits).
    const candidate = `app-main.lock.${app.child.pid}-`;
    const deadline = Date.now() + 20_000;
    while (!readdirSync(join(dir, '.bb-data')).some((e) => e.startsWith(candidate))) {
      assert.ok(Date.now() < deadline, 'the app never tried to take the lock');
      await new Promise((resolve) => setTimeout(resolve, 50)); // polls a condition, not a guessed duration
    }
    assert.strictEqual(ready, false, 'the app ran a query while the command held the database');
    assert.strictEqual(existsSync(join(dir, '.bb-data', 'app-main', 'PG_VERSION')), false, 'the app opened PGlite');
    const record = JSON.parse(readFileSync(lock, 'utf8'));
    assert.strictEqual(record.pid, holder.pid, 'the lock stays the command\'s');
    assert.strictEqual(record.role, 'cli');

    assert.strictEqual((await holder.end()).status, 0);
    await app.ready;
    const result = await app.done;
    assert.strictEqual(result.status, 0, result.stderr);
    assert.match(result.stdout, /Waiting for pid \d+ \(a bb-data command\)/);
    assert.strictEqual(existsSync(lock), false, 'the app released the lock when it exited');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('concurrent app and CLI processes: one owner at a time, and the database stays intact', async () => {
  const dir = makeApp();
  try {
    // `app` opens the dev mock's Database (the lock is taken in its constructor);
    // `cli` takes the lock and opens PGlite the way a bb-data command does. Each
    // logs when it owns the database and when it is done with it.
    writeFileSync(
      join(dir, 'race.mjs'),
      `import { appendFileSync } from 'node:fs';
const [role, n] = process.argv.slice(2);
const log = (event) => appendFileSync('events.log', event + ' ' + process.pid + '\\n');
try {
  if (role === 'app') {
    const { Scope } = await import(${JSON.stringify(import.meta.resolve('@aws-blocks/core'))});
    const { Database, sql } = await import(${JSON.stringify(pathToFileURL(join(distDir, 'index.mock.js')).href)});
    const db = new Database(new Scope('app'), 'main', { migrationsPath: './migrations' });
    log('OWN');
    await db.execute(sql\`INSERT INTO notes (n) VALUES (\${Number(n)})\`);
  } else {
    const { lockLocalDatabase, localDatabaseDir } = await import(${JSON.stringify(helperUrl)});
    const { PGliteEngine } = await import(${JSON.stringify(engineUrl)});
    const engine = new PGliteEngine(lockLocalDatabase(localDatabaseDir('app-main'), 'cli'));
    log('OWN');
    await engine.execute('CREATE TABLE IF NOT EXISTS cli_rows (n INT PRIMARY KEY)');
    await engine.execute('INSERT INTO cli_rows (n) VALUES (' + Number(n) + ')');
    await engine.destroy();
  }
  log('DONE');
} catch (e) {
  console.error(e.message);
  process.exit(1);
}
`,
    );
    const roles = ['app', 'cli', 'app', 'cli', 'app', 'cli'];
    const runs = await Promise.all(
      roles.map((role, n) =>
        collect(spawn(process.execPath, ['race.mjs', role, String(n)], { cwd: dir, env: localEnv })).then((r) => ({ role, ...r })),
      ),
    );

    // Every app ran. A command either ran, or refused because an app held the database.
    for (const run of runs) {
      if (run.role === 'app') assert.strictEqual(run.status, 0, run.stderr);
      else assert.ok(run.status === 0 || /open in another process/.test(run.stderr), run.stderr);
    }
    // Ownership never overlapped: each OWN is followed by the same process's DONE.
    const events = readFileSync(join(dir, 'events.log'), 'utf8').trim().split('\n');
    for (let i = 0; i < events.length; i += 2) {
      const [own, ownPid] = events[i].split(' ');
      const [done, donePid] = (events[i + 1] ?? '').split(' ');
      assert.deepStrictEqual([own, done, donePid], ['OWN', 'DONE', ownPid], events.join('\n'));
    }
    const succeeded = runs.filter((r) => r.status === 0);
    assert.strictEqual(events.length, succeeded.length * 2);

    // The database opens and holds every row that was written; nothing was quarantined.
    const engine = new PGliteEngine(join(dir, '.bb-data', 'app-main'));
    try {
      const [notes] = await engine.query<{ n: number }>('SELECT count(*)::int AS n FROM notes');
      assert.strictEqual(notes.n, 3);
      const cliRuns = succeeded.filter((r) => r.role === 'cli').length;
      if (cliRuns > 0) {
        const [rows] = await engine.query<{ n: number }>('SELECT count(*)::int AS n FROM cli_rows');
        assert.strictEqual(rows.n, cliRuns);
      }
    } finally {
      await engine.destroy();
    }
    const quarantined = [...readdirSync(dir), ...readdirSync(join(dir, '.bb-data'))].filter((e) => e.includes('.corrupt-'));
    assert.deepStrictEqual(quarantined, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
