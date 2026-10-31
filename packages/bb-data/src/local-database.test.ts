// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  listLocalDatabases,
  localDatabaseDir,
  lockLocalDatabase,
  markLocalDatabaseOpen,
  requireLocalDatabaseDir,
  resolveLocalDatabaseDir,
} from './local-database.js';

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

function writeLock(fullId: string, record: { pid: number; by: string }): string {
  const path = `${localDatabaseDir(fullId)}.lock`;
  mkdirSync('.bb-data', { recursive: true });
  writeFileSync(path, JSON.stringify(record));
  return path;
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

test('lockLocalDatabase takes a free database and records this process', async () => {
  assert.strictEqual(await lockLocalDatabase(localDatabaseDir('my-app-main')), localDatabaseDir('my-app-main'));
  const record = JSON.parse(readFileSync(`${localDatabaseDir('my-app-main')}.lock`, 'utf8'));
  assert.deepStrictEqual(record, { pid: process.pid, by: 'cli' });
});

test('lockLocalDatabase takes over a lock whose process is gone', async () => {
  writeLock('my-app-main', { pid: deadPid(), by: 'app' });
  await lockLocalDatabase(localDatabaseDir('my-app-main'));
  const record = JSON.parse(readFileSync(`${localDatabaseDir('my-app-main')}.lock`, 'utf8'));
  assert.strictEqual(record.pid, process.pid);
});

test('lockLocalDatabase refuses at once while an app process (npm run dev) has the database open', async () => {
  const path = writeLock('my-app-main', { pid: process.ppid, by: 'app' });
  await assert.rejects(lockLocalDatabase(localDatabaseDir('my-app-main')), /open in another process .*npm run dev:stop/s);
  assert.strictEqual(existsSync(path), true, 'the app keeps its record');
});

test('lockLocalDatabase waits for another bb-data command, then gives up after the timeout', async () => {
  writeLock('my-app-main', { pid: process.ppid, by: 'cli' });
  const started = Date.now();
  await assert.rejects(lockLocalDatabase(localDatabaseDir('my-app-main'), 500), /Another bb-data command .* is still using/);
  assert.ok(Date.now() - started >= 500);
});

test('markLocalDatabaseOpen records the app process without refusing', () => {
  writeLock('my-app-main', { pid: process.ppid, by: 'cli' });
  markLocalDatabaseOpen(localDatabaseDir('my-app-main'));
  const record = JSON.parse(readFileSync(`${localDatabaseDir('my-app-main')}.lock`, 'utf8'));
  assert.deepStrictEqual(record, { pid: process.pid, by: 'app' });
});
