// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  listLocalDatabases,
  localDatabaseDir,
  lockLocalDatabase,
  requireLocalDatabaseDir,
  resolveLocalDatabaseDir,
} from './local-database.js';

const helperUrl = pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), 'local-database.js')).href;

// The helpers resolve `.bb-data` against the working directory, as the dev server and CLI do.
const startDir = process.cwd();
let appDir: string;

before(() => {
  appDir = mkdtempSync(join(tmpdir(), 'bb-data-local-db-'));
  process.chdir(appDir);
});

after(() => {
  process.chdir(startDir);
  rmSync(appDir, { recursive: true, force: true });
});

beforeEach(() => {
  rmSync('.bb-data', { recursive: true, force: true });
});

/** The entries an initialized PGlite data directory is recognized by. */
function fakeDatabase(fullId: string): void {
  const dir = localDatabaseDir(fullId);
  mkdirSync(join(dir, 'base'), { recursive: true });
  mkdirSync(join(dir, 'global'), { recursive: true });
  writeFileSync(join(dir, 'PG_VERSION'), '16\n');
  writeFileSync(join(dir, 'global', 'pg_control'), '');
}

const LOCK = `${localDatabaseDir('my-app-main')}.lock`;

interface LockFile {
  pid: number;
  start: string | null;
  role: string;
  token: string;
}

function writeLock(record: LockFile): string {
  mkdirSync('.bb-data', { recursive: true });
  const raw = JSON.stringify(record);
  writeFileSync(LOCK, raw);
  return raw;
}

function readLock(): LockFile {
  return JSON.parse(readFileSync(LOCK, 'utf8'));
}

/** A pid that belonged to a process which has exited. */
function deadPid(): number {
  const pid = spawnSync(process.execPath, ['-e', '']).pid;
  assert.ok(pid);
  return pid;
}

test('the dev mock and the CLI use .bb-data/<fullId>', () => {
  assert.strictEqual(localDatabaseDir('my-app-main'), join('.bb-data', 'my-app-main'));
});

test('lists only directories that hold an initialized PGlite database', () => {
  fakeDatabase('my-app-main');
  fakeDatabase('my-app-audit');
  mkdirSync(join('.bb-data', 'my-app-auth-users'));
  writeFileSync(join('.bb-data', 'my-app-auth-users', 'store.json'), '{}');
  mkdirSync(join('.bb-data', 'my-app-half'));
  writeFileSync(join('.bb-data', 'my-app-half', 'PG_VERSION'), '16\n');
  writeFileSync(join('.bb-data', 'settings.json'), '{}');
  writeFileSync(join('.bb-data', 'my-app-main.lock'), '{}');
  assert.deepStrictEqual(listLocalDatabases(), ['my-app-audit', 'my-app-main']);
});

test('defaults to the only local database, and to null when there is none', () => {
  assert.strictEqual(resolveLocalDatabaseDir(undefined), null);
  fakeDatabase('my-app-main');
  assert.strictEqual(resolveLocalDatabaseDir(undefined), localDatabaseDir('my-app-main'));
});

test('asks for --block when there are several, listing them', () => {
  fakeDatabase('my-app-main');
  fakeDatabase('my-app-audit');
  assert.throws(() => resolveLocalDatabaseDir(undefined), /my-app-audit, my-app-main\. Pass --block <id>/);
  assert.strictEqual(resolveLocalDatabaseDir('my-app-audit'), localDatabaseDir('my-app-audit'));
});

test('--block takes a directory name, not a path', () => {
  for (const bad of ['', '.', '..', '../elsewhere', 'a/b', 'a\\b']) {
    assert.throws(() => resolveLocalDatabaseDir(bad), /--block expects a database id/, bad);
  }
});

test('requireLocalDatabaseDir explains how to get a database, and checks it exists when asked', () => {
  assert.throws(() => requireLocalDatabaseDir(undefined), /npm run dev.*--block <id>/s);
  assert.strictEqual(requireLocalDatabaseDir('my-app-new'), localDatabaseDir('my-app-new'));
  fakeDatabase('my-app-main');
  assert.throws(
    () => requireLocalDatabaseDir('my-app-mian', { mustExist: true }),
    /no local database in .*my-app-mian\. Local databases: my-app-main\./,
  );
  assert.strictEqual(requireLocalDatabaseDir('my-app-main', { mustExist: true }), localDatabaseDir('my-app-main'));
});

test('lockLocalDatabase takes a free database and records this process, its start time and role', () => {
  assert.strictEqual(lockLocalDatabase(localDatabaseDir('my-app-main'), 'cli'), localDatabaseDir('my-app-main'));
  const record = readLock();
  assert.strictEqual(record.pid, process.pid);
  assert.strictEqual(record.role, 'cli');
  assert.ok(record.token);
  if (process.platform === 'linux') assert.ok(record.start, 'start time recorded');
  // The same process gets it again (several Databases with one fullId).
  assert.strictEqual(lockLocalDatabase(localDatabaseDir('my-app-main'), 'app'), localDatabaseDir('my-app-main'));
  assert.strictEqual(readLock().token, record.token);
});

test('lockLocalDatabase takes over a lock whose process is gone', () => {
  writeLock({ pid: deadPid(), start: null, role: 'app', token: 'old' });
  lockLocalDatabase(localDatabaseDir('my-app-main'), 'cli');
  assert.strictEqual(readLock().pid, process.pid);
});

test(
  'lockLocalDatabase takes over a lock whose pid now belongs to another process',
  { skip: process.platform !== 'linux' && process.platform !== 'darwin' },
  () => {
    // process.ppid is alive, but did not start at this time: the pid was reused.
    writeLock({ pid: process.ppid, start: 'not-its-start-time', role: 'cli', token: 'old' });
    lockLocalDatabase(localDatabaseDir('my-app-main'), 'cli', 0);
    assert.strictEqual(readLock().pid, process.pid);
  },
);

test('the CLI refuses at once while an app process (npm run dev) holds the database', () => {
  const raw = writeLock({ pid: process.ppid, start: null, role: 'app', token: 'dev' });
  const started = Date.now();
  assert.throws(
    () => lockLocalDatabase(localDatabaseDir('my-app-main'), 'cli'),
    /open in another process .*npm run dev:stop/s,
  );
  assert.ok(Date.now() - started < 5_000, 'did not wait for the dev server');
  assert.strictEqual(readFileSync(LOCK, 'utf8'), raw, 'the app keeps its lock');
});

test('the app waits for a bb-data command, then refuses without taking the lock', () => {
  const raw = writeLock({ pid: process.ppid, start: null, role: 'cli', token: 'migrate' });
  const started = Date.now();
  assert.throws(
    () => lockLocalDatabase(localDatabaseDir('my-app-main'), 'app', 500),
    /in use by a `bb-data` command .*Wait for it to finish/s,
  );
  assert.ok(Date.now() - started >= 500);
  assert.strictEqual(readFileSync(LOCK, 'utf8'), raw, 'the command keeps its lock');
});

/** Start a child that takes the lock, reports LOCKED, and holds it until its stdin closes. */
async function childHolder(): Promise<{ end: () => Promise<number | null> }> {
  const script = `const { lockLocalDatabase, localDatabaseDir } = await import(${JSON.stringify(helperUrl)});
lockLocalDatabase(localDatabaseDir('my-app-main'), 'cli');
console.log('LOCKED');
process.stdin.resume();
process.stdin.on('end', () => process.exit(0));`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], { cwd: appDir });
  const exited = new Promise<number | null>((resolve) => child.on('exit', resolve));
  await new Promise<void>((resolve, reject) => {
    child.stdout.on('data', (d) => String(d).includes('LOCKED') && resolve());
    exited.then(() => reject(new Error('the holder exited before it took the lock')));
  });
  return {
    end: () => {
      child.stdin.end();
      return exited;
    },
  };
}

test('a process releases its lock when it exits', async () => {
  const holder = await childHolder();
  assert.strictEqual(readLock().role, 'cli');
  assert.strictEqual(await holder.end(), 0);
  assert.strictEqual(existsSync(LOCK), false);
});

test('a process never releases a lock that is no longer its own', async () => {
  const holder = await childHolder();
  const other = writeLock({ pid: process.pid, start: null, role: 'app', token: 'someone-else' });
  assert.strictEqual(await holder.end(), 0);
  assert.strictEqual(readFileSync(LOCK, 'utf8'), other);
});

test('a reap file left by a reaper that died is reaped by the same rule, then the lock is taken', () => {
  writeLock({ pid: deadPid(), start: null, role: 'cli', token: 'dead-holder' });
  writeFileSync(`${LOCK}.reap-dead-holder`, JSON.stringify({ pid: deadPid(), start: null, role: 'reap', token: 'dead-reaper' }));
  lockLocalDatabase(localDatabaseDir('my-app-main'), 'cli');
  assert.strictEqual(readLock().pid, process.pid);
  assert.deepStrictEqual(readdirSync('.bb-data').filter((e) => e.includes('.reap-')), []);
});

test("a contender never touches a live reaper's file, nor the lock it is reaping", () => {
  const lock = writeLock({ pid: deadPid(), start: null, role: 'cli', token: 'dead-holder' });
  const reaper = JSON.stringify({ pid: process.ppid, start: null, role: 'reap', token: 'live-reaper' });
  writeFileSync(`${LOCK}.reap-dead-holder`, reaper);
  assert.throws(() => lockLocalDatabase(localDatabaseDir('my-app-main'), 'cli', 300), /still removing a stale/);
  assert.strictEqual(readFileSync(LOCK, 'utf8'), lock);
  assert.strictEqual(readFileSync(`${LOCK}.reap-dead-holder`, 'utf8'), reaper);
});

test('after taking the lock, temp files and reap files of dead processes are removed', () => {
  mkdirSync('.bb-data', { recursive: true });
  const dead = deadPid();
  writeFileSync(`${LOCK}.${dead}-00000000-0000-4000-8000-000000000000`, '{}');
  writeFileSync(`${LOCK}.reap-orphan`, JSON.stringify({ pid: dead, start: null, role: 'reap', token: 'orphan' }));
  const live = `${LOCK}.reap-busy`;
  writeFileSync(live, JSON.stringify({ pid: process.ppid, start: null, role: 'reap', token: 'busy' }));
  lockLocalDatabase(localDatabaseDir('my-app-main'), 'cli');
  assert.deepStrictEqual(readdirSync('.bb-data').sort(), ['my-app-main.lock', 'my-app-main.lock.reap-busy']);
});
