// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Two app processes (two `npm run dev` servers of one app) on one local database.
 * PGlite runs PostgreSQL inside one process; when a second process opened the
 * same data directory (removing the first one's `postmaster.pid` as "stale"), the
 * first server's acknowledged writes were lost after a restart. Each test runs
 * real processes that open the dev mock's `Database(new Scope('app'), 'main')`.
 */

import { test } from 'node:test';
import assert from 'node:assert';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { PGliteEngine } from './engines/pglite-engine.js';

const distDir = dirname(fileURLToPath(import.meta.url));
const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('BLOCKS_TEST_DB_LOCK_')));

/**
 * `app.mjs <mode>`:
 *   writer  — insert rows until stdin closes, printing `COUNT <n>` as writes are
 *             acknowledged; on SIGTERM, exit via process.exit after `EXIT_DELAY_MS`
 *             (as the dev server's cleanup does); prints `ACKED <n>` at the end.
 *   second  — open the Database; prints `REFUSED <message>` and exits 2 if that throws.
 *   twice   — open the Database twice in this process and report on postmaster.pid.
 *   once    — open the Database, run one query, exit.
 */
const APP = `import { existsSync } from 'node:fs';
const { Scope } = await import(${JSON.stringify(import.meta.resolve('@aws-blocks/core'))});
const { Database, sql } = await import(${JSON.stringify(pathToFileURL(join(distDir, 'index.mock.js')).href)});
const mode = process.argv[2];
const open = () => new Database(new Scope('app'), 'main', { migrationsPath: './migrations' });
let db;
try {
  db = open();
} catch (e) {
  console.log('REFUSED ' + e.message);
  process.exit(2);
}
if (mode === 'second' || mode === 'once') {
  await db.query(sql\`SELECT 1\`);
  console.log('OPENED');
  process.exit(0);
}
if (mode === 'twice') {
  await db.query(sql\`SELECT 1\`);
  const before = existsSync('.bb-data/app-main/postmaster.pid');
  open();
  const after = existsSync('.bb-data/app-main/postmaster.pid');
  await db.query(sql\`SELECT 1\`);
  console.log('PIDFILE ' + JSON.stringify({ before, after }));
  process.exit(0);
}
let acked = 0;
let stop = false;
process.stdin.resume();
process.stdin.on('end', () => (stop = true));
process.on('SIGTERM', () => setTimeout(() => process.exit(0), Number(process.env.EXIT_DELAY_MS ?? 0)));
while (!stop) {
  await db.execute(sql\`INSERT INTO writes (by_pid) VALUES (\${process.pid})\`);
  acked++;
  if (acked % 25 === 0 || acked === 1) console.log('COUNT ' + acked);
  await new Promise((resolve) => setImmediate(resolve)); // let stdin and signals through, as a server's event loop does
}
console.log('ACKED ' + acked);
process.exit(0);
`;

function makeApp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'bb-data-app-lock-'));
  mkdirSync(join(dir, 'migrations'));
  writeFileSync(join(dir, 'migrations', '001_writes.sql'), 'CREATE TABLE writes (id SERIAL PRIMARY KEY, by_pid INT);\n');
  writeFileSync(join(dir, 'app.mjs'), APP);
  return dir;
}

interface App {
  child: ChildProcess;
  out: () => string;
  exited: Promise<number | null>;
  /** Resolves once stdout contains `text`. */
  printed: (text: string | RegExp) => Promise<void>;
}

function startApp(dir: string, mode: string, extraEnv: Record<string, string> = {}): App {
  const child = spawn(process.execPath, ['app.mjs', mode], { cwd: dir, env: { ...env, ...extraEnv } });
  let out = '';
  const waiters: Array<() => void> = [];
  child.stdout?.on('data', (d) => {
    out += d;
    for (const w of waiters.splice(0)) w();
  });
  child.stderr?.on('data', (d) => (out += d));
  const exited = new Promise<number | null>((resolve) => child.on('exit', resolve));
  const printed = (text: string | RegExp) =>
    new Promise<void>((resolve, reject) => {
      const check = () => {
        if (typeof text === 'string' ? out.includes(text) : text.test(out)) return resolve();
        waiters.push(check);
      };
      exited.then(() => (typeof text === 'string' ? out.includes(text) : text.test(out)) || reject(new Error(`exited without printing ${text}:\n${out}`)));
      check();
    });
  return { child, out: () => out, exited, printed };
}

function lastCount(app: App): number {
  const counts = [...app.out().matchAll(/COUNT (\d+)/g)];
  return counts.length > 0 ? Number(counts[counts.length - 1][1]) : 0;
}

async function countRows(dir: string): Promise<number> {
  const engine = new PGliteEngine(join(dir, '.bb-data', 'app-main'));
  try {
    const [row] = await engine.query<{ n: number }>('SELECT count(*)::int AS n FROM writes');
    return row.n;
  } finally {
    await engine.destroy();
  }
}

test('a second app process waits, then refuses and never opens the database; the first keeps every acked write', async () => {
  const dir = makeApp();
  const apps: App[] = [];
  try {
    const first = startApp(dir, 'writer');
    apps.push(first);
    await first.printed('COUNT 25');
    const pidFile = join(dir, '.bb-data', 'app-main', 'postmaster.pid');
    const lock = join(dir, '.bb-data', 'app-main.lock');
    const pidFileBefore = statSync(pidFile);

    const started = Date.now();
    const second = startApp(dir, 'second');
    apps.push(second);
    const code = await second.exited;
    const waited = Date.now() - started;

    assert.strictEqual(code, 2, second.out());
    assert.match(second.out(), new RegExp(`REFUSED .*in use by another app process \\(pid ${first.child.pid}\\)`));
    assert.match(second.out(), /Is another `npm run dev` running for this app/);
    assert.doesNotMatch(second.out(), /OPENED|Removed stale postmaster\.pid/);
    assert.ok(waited >= 10_000 && waited < 25_000, `waited ${waited} ms (bounded wait of 10 s)`);
    // The first process's PostgreSQL state was never touched, and it still owns the lock.
    const pidFileAfter = statSync(pidFile);
    assert.strictEqual(pidFileAfter.ino, pidFileBefore.ino, 'postmaster.pid was removed and recreated');
    assert.strictEqual(JSON.parse(readFileSync(lock, 'utf8')).pid, first.child.pid);

    // The first one keeps writing after the refusal.
    const atRefusal = lastCount(first);
    await first.printed(`COUNT ${atRefusal + 25}\n`);
    first.child.stdin?.end();
    assert.strictEqual(await first.exited, 0, first.out());
    const acked = Number(/ACKED (\d+)/.exec(first.out())?.[1]);
    assert.ok(acked > atRefusal);

    // Reopened after the first stops: every acknowledged write is there.
    assert.strictEqual(await countRows(dir), acked);
  } finally {
    for (const app of apps) app.child.kill('SIGKILL');
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a second Database with the same fullId in one process leaves the live postmaster.pid alone', async () => {
  const dir = makeApp();
  try {
    const app = startApp(dir, 'twice');
    assert.strictEqual(await app.exited, 0, app.out());
    assert.match(app.out(), /PIDFILE \{"before":true,"after":true\}/);
    assert.doesNotMatch(app.out(), /Removed stale postmaster\.pid/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a restart: the next app process waits for the exiting one, then takes over; a clean exit releases the lock', async () => {
  const dir = makeApp();
  const apps: App[] = [];
  try {
    // Like a `tsx watch` restart: the old process gets SIGTERM and takes 1.5 s to
    // exit (through process.exit, as the dev server's cleanup does); the new one
    // starts meanwhile.
    const old = startApp(dir, 'writer', { EXIT_DELAY_MS: '1500' });
    apps.push(old);
    await old.printed('COUNT 25');
    old.child.kill('SIGTERM');
    const next = startApp(dir, 'once');
    apps.push(next);
    assert.strictEqual(await old.exited, 0, old.out());
    assert.strictEqual(await next.exited, 0, next.out());
    assert.match(next.out(), /Waiting for pid \d+ \(an app\)/);
    assert.match(next.out(), /OPENED/);

    // Both exited through process.exit: the lock is released.
    assert.strictEqual(existsSync(join(dir, '.bb-data', 'app-main.lock')), false);
    const again = startApp(dir, 'once');
    apps.push(again);
    assert.strictEqual(await again.exited, 0, again.out());
    assert.doesNotMatch(again.out(), /Waiting for pid/);
  } finally {
    for (const app of apps) app.child.kill('SIGKILL');
    rmSync(dir, { recursive: true, force: true });
  }
});
