// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The local-database lock under contention, with real processes. A live lock must
 * never be removed or moved, and at most one process may own the database at a
 * time. Owners append `ENTER <pid>` / `EXIT <pid>` (or `LOST <pid>` when their
 * record was gone) to one shared O_APPEND log, whose line order is the global order.
 */

import { test } from 'node:test';
import assert from 'node:assert';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { PGliteEngine } from './engines/pglite-engine.js';

const distDir = dirname(fileURLToPath(import.meta.url));
const helperUrl = pathToFileURL(join(distDir, 'local-database.js')).href;
const engineUrl = pathToFileURL(join(distDir, 'engines', 'pglite-engine.js')).href;

const env = Object.fromEntries(
  Object.entries(process.env).filter(([name]) => !name.startsWith('BLOCKS_TEST_DB_LOCK_')),
);

/**
 * A contender: takes the lock for `app-main` with the given role, logs ENTER, then
 * holds it until its stdin closes (`hold`), writes a row to the PGlite database
 * (`write`), or holds it for 30 ms (`brief`). On the way out it checks that the
 * lock still holds its own record: EXIT if so, LOST (exit 3) if a live lock of
 * its was removed.
 */
const CONTENDER = `import { appendFileSync, readFileSync } from 'node:fs';
const { lockLocalDatabase, localDatabaseDir } = await import(${JSON.stringify(helperUrl)});
const [role, mode] = process.argv.slice(2);
const dataDir = localDatabaseDir('app-main');
const log = (event) => appendFileSync('events.log', event + ' ' + process.pid + '\\n');
try {
  lockLocalDatabase(dataDir, role);
} catch (e) {
  console.error(e.message);
  process.exit(1);
}
const mine = readFileSync(dataDir + '.lock', 'utf8');
log('ENTER');
console.log('OWN');
const finish = () => {
  let now = null;
  try { now = readFileSync(dataDir + '.lock', 'utf8'); } catch {}
  log(now === mine ? 'EXIT' : 'LOST');
  process.exit(now === mine ? 0 : 3);
};
if (mode === 'hold') {
  process.stdin.resume();
  process.stdin.on('end', finish);
} else if (mode === 'brief') {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30);
  finish();
} else {
  const { PGliteEngine } = await import(${JSON.stringify(engineUrl)});
  const engine = new PGliteEngine(dataDir);
  await engine.execute('INSERT INTO owners (pid) VALUES (' + process.pid + ')');
  await engine.destroy();
  finish();
}
`;

interface Contender {
  child: ChildProcess;
  pid: number;
  owns: Promise<void>;
  exited: Promise<number | null>;
  stderr: () => string;
}

function startContender(
  dir: string,
  role: 'app' | 'cli',
  mode: 'hold' | 'write' | 'brief',
  extraEnv: Record<string, string> = {},
): Contender {
  const child = spawn(process.execPath, ['contender.mjs', role, mode], { cwd: dir, env: { ...env, ...extraEnv } });
  let stderr = '';
  child.stderr?.on('data', (d) => (stderr += d));
  const exited = new Promise<number | null>((resolve) => child.on('exit', resolve));
  const owns = new Promise<void>((resolve) => child.stdout?.on('data', (d) => String(d).includes('OWN') && resolve()));
  assert.ok(child.pid);
  return { child, pid: child.pid, owns, exited, stderr: () => stderr };
}

function makeApp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'bb-data-lock-race-'));
  mkdirSync(join(dir, '.bb-data'));
  writeFileSync(join(dir, 'contender.mjs'), CONTENDER);
  writeFileSync(join(dir, 'events.log'), '');
  return dir;
}

/** A lock record whose process has exited. */
function seedDeadLock(dir: string): string {
  const pid = spawnSync(process.execPath, ['-e', '']).pid;
  const raw = JSON.stringify({ pid, start: null, role: 'cli', token: `dead-${pid}-${Math.random().toString(36).slice(2)}` });
  writeFileSync(join(dir, '.bb-data', 'app-main.lock'), raw);
  return raw;
}

/** Polls a condition (the processes signal through files), failing after `ms`. */
async function until(what: string, condition: () => boolean, ms = 20_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!condition()) {
    assert.ok(Date.now() < deadline, `timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20)); // polls a condition, not a guessed duration
  }
}

/** At most one owner at any point of the shared log, and no owner lost its lock. */
function assertExclusive(dir: string): string[] {
  const events = readFileSync(join(dir, 'events.log'), 'utf8').trim().split('\n').filter(Boolean);
  let owner: string | null = null;
  for (const [i, line] of events.entries()) {
    const [event, pid] = line.split(' ');
    if (event === 'ENTER') {
      assert.strictEqual(owner, null, `pid ${pid} entered while ${owner} owned the database (event ${i}):\n${events.join('\n')}`);
      owner = pid;
    } else {
      assert.strictEqual(event, 'EXIT', `pid ${pid} lost its lock while it was alive (event ${i}):\n${events.join('\n')}`);
      assert.strictEqual(pid, owner, `pid ${pid} exited without owning the database (event ${i})`);
      owner = null;
    }
  }
  return events;
}

test('a contender that inspected a dead lock never removes the live lock that replaced it', async () => {
  // The interleaving: A and B both see the same dead record. A takes over and
  // holds the lock. B resumes its takeover of the dead record. C arrives while B
  // is mid-takeover. A's lock must survive, and C must wait for A.
  const dir = makeApp();
  const hooks = join(dir, 'hooks');
  mkdirSync(hooks);
  const hook = (p: Contender, step: string) => existsSync(join(hooks, `${p.pid}.${step}`));
  const go = (p: Contender, step: string) => writeFileSync(join(hooks, `${p.pid}.${step}.go`), '');
  const all: Contender[] = [];
  try {
    seedDeadLock(dir);
    const b = startContender(dir, 'app', 'hold', {
      BLOCKS_TEST_DB_LOCK_HOOKS: hooks,
      BLOCKS_TEST_DB_LOCK_PAUSE: 'stale-inspected,takeover',
    });
    all.push(b);
    await until('B to inspect the dead lock', () => hook(b, 'stale-inspected'));

    const a = startContender(dir, 'cli', 'hold', { BLOCKS_TEST_DB_LOCK_HOOKS: hooks });
    all.push(a);
    await a.owns;
    const lock = join(dir, '.bb-data', 'app-main.lock');
    assert.strictEqual(JSON.parse(readFileSync(lock, 'utf8')).pid, a.pid);

    go(b, 'stale-inspected');
    await until('B to start its takeover', () => hook(b, 'takeover'));

    const c = startContender(dir, 'cli', 'hold', { BLOCKS_TEST_DB_LOCK_HOOKS: hooks });
    all.push(c);
    let cOwns = false;
    c.owns.then(() => (cOwns = true));
    await until('C to find a holder or take the lock', () => cOwns || hook(c, 'live-holder'));

    go(b, 'takeover');
    await until('B to find the live holder', () => hook(b, 'live-holder'));
    assert.strictEqual(cOwns, false, 'C took the lock while A held it');
    assert.strictEqual(JSON.parse(readFileSync(lock, 'utf8')).pid, a.pid, "A's live lock was removed");

    // Let everyone finish: B and C release the database as soon as they own it.
    for (const p of [b, c]) p.owns.then(() => p.child.stdin?.end());
    a.child.stdin?.end();
    assert.strictEqual(await a.exited, 0, `A lost its lock: ${a.stderr()}`);
    // An app holder makes a command refuse (exit 1); anything else must be a clean exit.
    for (const p of [b, c]) assert.ok([0, 1].includes((await p.exited) ?? -1), p.stderr());
    assertExclusive(dir);
    assert.deepStrictEqual(readdirSync(join(dir, '.bb-data')).filter((e) => e.includes('.reap-')), []);
  } finally {
    for (const p of all) p.child.kill('SIGKILL');
    rmSync(dir, { recursive: true, force: true });
  }
});

test('50 rounds of three contenders on a dead lock: one owner at a time, the database intact', async () => {
  const dir = makeApp();
  try {
    const setup = new PGliteEngine(join(dir, '.bb-data', 'app-main'));
    await setup.execute('CREATE TABLE owners (pid INT)');
    await setup.destroy();

    const rounds = 50;
    const roles: Array<'app' | 'cli'>[] = [['app', 'cli', 'cli'], ['cli', 'app', 'cli'], ['cli', 'cli', 'app']];
    let owners = 0;
    let rows = 0;
    for (let round = 0; round < rounds; round++) {
      seedDeadLock(dir);
      // Apps write a row to PGlite (as the dev server would); commands hold the lock briefly.
      const order = roles[round % roles.length];
      const contenders = order.map((role) => startContender(dir, role, role === 'app' ? 'write' : 'brief'));
      for (const [i, p] of contenders.entries()) {
        const code = await p.exited;
        // A command refuses (exit 1) when an app holds the database; that is the only allowed failure.
        assert.ok(code === 0 || (code === 1 && /open in another process/.test(p.stderr())), `round ${round}: exit ${code}: ${p.stderr()}`);
        if (code === 0) owners++;
        if (code === 0 && order[i] === 'app') rows++;
      }
    }

    const events = assertExclusive(dir);
    assert.strictEqual(events.length, owners * 2);
    const engine = new PGliteEngine(join(dir, '.bb-data', 'app-main'));
    try {
      const [row] = await engine.query<{ n: number }>('SELECT count(*)::int AS n FROM owners');
      assert.strictEqual(row.n, rows);
      assert.strictEqual(rows, rounds, 'every app wrote its row');
    } finally {
      await engine.destroy();
    }
    const left = readdirSync(join(dir, '.bb-data')).filter((e) => e !== 'app-main');
    assert.deepStrictEqual(left.filter((e) => e.includes('.corrupt-') || e.includes('.reap-')), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
