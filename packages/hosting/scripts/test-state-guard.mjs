// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Global-state guard for the package's unit tests, loaded by `npm test` with
// `--import`.
//
// `npm test` runs every test file in one Node process
// (`--experimental-test-isolation=none`), so process-wide state that one file
// changes and does not restore is still changed when later files run. Without
// per-file processes nothing would notice: the later file fails, or passes for
// the wrong reason, far from the file that caused it.
//
// This module records the state listed in `GLOBALS` (plus `process.env`,
// `process.cwd()` and `process.exitCode`) before any test file loads, and
// checks it twice per test file:
//   - once the file has been imported: the runner imports every file before it
//     runs any test, so a change made at module scope reaches every file;
//   - after the file's last test, in a test this module appends to the file
//     (`global state restored: <file>`), which the runner runs before the next
//     file's tests.
// A check that finds a change fails, naming the file and what changed, and
// then puts the recorded state back, so no other file sees the change.
//
// The guard needs `module.registerHooks` (Node 22.15+). Without it, this
// module prints one warning and the tests run unguarded.
//
// Not checked: module-level state of the code under test, mocks of module
// exports, temp files, and open handles.
import { strict as assert } from 'node:assert';
import nodeModule from 'node:module';
import { relative } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

/** Properties tests commonly replace, as `[label, owner, key]`. */
const GLOBALS = [
  ['console.log', console, 'log'],
  ['console.info', console, 'info'],
  ['console.warn', console, 'warn'],
  ['console.error', console, 'error'],
  ['console.debug', console, 'debug'],
  ['process.stdout.write', process.stdout, 'write'],
  ['process.stderr.write', process.stderr, 'write'],
  ['process.exit', process, 'exit'],
  ['fetch', globalThis, 'fetch'],
  ['Date', globalThis, 'Date'],
  ['setTimeout', globalThis, 'setTimeout'],
  ['setInterval', globalThis, 'setInterval'],
  ['setImmediate', globalThis, 'setImmediate'],
  ['clearTimeout', globalThis, 'clearTimeout'],
  ['clearInterval', globalThis, 'clearInterval'],
  ['clearImmediate', globalThis, 'clearImmediate'],
];

const baseline = {
  env: process.env,
  envEntries: { ...process.env },
  cwd: process.cwd(),
  exitCode: process.exitCode,
  globals: GLOBALS.map(([label, owner, key]) => ({
    label,
    owner,
    key,
    value: owner[key],
    own: Object.getOwnPropertyDescriptor(owner, key),
  })),
};

/** Lists what differs from the baseline, then restores the baseline. */
function takeChanges() {
  const changes = [];
  if (process.env !== baseline.env) {
    changes.push('process.env was replaced');
    process.env = baseline.env;
  }
  const keys = new Set([...Object.keys(baseline.envEntries), ...Object.keys(process.env)]);
  for (const key of [...keys].sort()) {
    const before = baseline.envEntries[key];
    const now = process.env[key];
    if (before === now) continue;
    if (before === undefined) {
      changes.push(`process.env.${key} was set`);
      delete process.env[key];
    } else {
      changes.push(now === undefined ? `process.env.${key} was deleted` : `process.env.${key} was changed`);
      process.env[key] = before;
    }
  }
  if (process.cwd() !== baseline.cwd) {
    changes.push(`process.cwd() is ${process.cwd()}`);
    process.chdir(baseline.cwd);
  }
  if (process.exitCode !== baseline.exitCode) {
    changes.push(`process.exitCode is ${process.exitCode}`);
    process.exitCode = baseline.exitCode;
  }
  for (const { label, owner, key, value, own } of baseline.globals) {
    if (owner[key] === value) continue;
    changes.push(`${label} was replaced`);
    if (own) Object.defineProperty(owner, key, own);
    else delete owner[key];
  }
  return changes;
}

function failure(file, when, changes) {
  return [
    `${file} left process-wide state changed ${when}:`,
    ...changes.map((change) => `  - ${change}`),
    'npm test runs every test file in one process, so restore what a test changes in an after()/afterEach() hook ' +
      'or a finally block (and set module-scope state in a before() hook instead). The original state has been put back.',
  ].join('\n');
}

/**
 * Called from the end of every test file (see the load hook): checks the
 * file's module scope now and registers the after-its-tests check.
 */
export function guardTestFile(url) {
  const file = relative(baseline.cwd, fileURLToPath(url));
  const atImport = takeChanges();
  if (atImport.length > 0) {
    test(`global state restored: ${file} (module scope)`, () => assert.fail(failure(file, 'at module scope', atImport)));
  }
  test(`global state restored: ${file}`, () => {
    const changes = takeChanges();
    if (changes.length > 0) assert.fail(failure(file, 'after its tests', changes));
  });
}

const SELF = import.meta.url;
const decoder = new TextDecoder();

/** Adds the guard to each test file as it loads. */
function appendGuard(url, context, nextLoad) {
  const result = nextLoad(url, context);
  if (result.format !== 'module' || !/\.test\.m?js$/.test(url) || !url.startsWith('file:') || url.includes('/node_modules/')) {
    return result;
  }
  const source = typeof result.source === 'string' ? result.source : decoder.decode(result.source);
  // Appended, so it runs after the file's own top-level code and registers its test after the file's tests.
  return {
    ...result,
    source: `${source}\n;import { guardTestFile as __blocksGuardTestFile } from ${JSON.stringify(SELF)};\n__blocksGuardTestFile(import.meta.url);\n`,
  };
}

// `module.registerHooks` arrived in Node 22.15; on older 22.x the tests still run, unguarded.
if (typeof nodeModule.registerHooks === 'function') {
  nodeModule.registerHooks({ load: appendGuard });
} else {
  process.emitWarning(
    'Skipping the cross-file global-state guard: this Node.js has no module.registerHooks (added in 22.15). ' +
      'Test files are not checked for state they leave changed.',
  );
}
