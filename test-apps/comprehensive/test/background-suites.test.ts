// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for the background suite runner (./background-suites.ts), with a
 * fake child in place of run-background-suite.ts. The runner's exit-code check
 * is the only thing that turns a failing background suite into a failing e2e
 * job, so it is tested here rather than only observed in a red CI run.
 *
 * Run: npm run test:background-suites (root), or from test-apps/comprehensive
 *   npx tsx --test test/background-suites.test.ts
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { backgroundSuites } from './background-suites.js';

const fixtures = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const entry = join(fixtures, 'fake-background-suite.ts');

/**
 * Collects the children's prefixed output instead of printing it. Under
 * `node --test` this file's stdout carries the runner's own reports, so the
 * children's lines (a failing fake test among them) stay out of it.
 */
function sink() {
  const lines: string[] = [];
  return { lines, output: { stdout: (l: string) => lines.push(l), stderr: (l: string) => lines.push(l) } };
}
const quiet = () => ({ entry, output: sink().output });

test('done() resolves when the child suite passes', async () => {
  const [suite] = backgroundSuites(['pass'], quiet()).suites;
  await suite.done();
});

test('done() rejects and names the failing test when one child test fails', async () => {
  const [suite] = backgroundSuites(['fail'], quiet()).suites;
  await assert.rejects(suite.done(), (err: Error) => {
    assert.match(err.message, /Background suite "fail" failed \(exit 1\)/);
    assert.match(err.message, /fake background test fails/);
    assert.doesNotMatch(err.message, /fake background test passes/);
    return true;
  });
});

test('done() rejects when the child crashes at import', async () => {
  const [suite] = backgroundSuites(['crash'], quiet()).suites;
  await assert.rejects(suite.done(), /Background suite "crash" failed \(exit 1\)/);
});

test('done() rejects when the entry cannot be loaded', async () => {
  const [suite] = backgroundSuites(['pass'], { entry: join(tmpdir(), 'no-such-background-suite.ts'), output: sink().output }).suites;
  await assert.rejects(suite.done(), /Background suite "pass" failed/);
});

test('settle() waits for started children that no done() test awaits', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'background-suites-'));
  const marker = join(dir, 'marker');
  const previous = process.env.FAKE_SUITE_MARKER;
  process.env.FAKE_SUITE_MARKER = marker;
  try {
    const background = backgroundSuites(['slow'], quiet());
    background.start();
    await background.settle();
    assert.ok(existsSync(marker), 'settle() returned before the child finished');
  } finally {
    if (previous === undefined) delete process.env.FAKE_SUITE_MARKER;
    else process.env.FAKE_SUITE_MARKER = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('settle() also waits for a child that fails, without rejecting', async () => {
  const background = backgroundSuites(['fail', 'pass'], quiet());
  background.start();
  await background.settle();
  await assert.rejects(background.suites[0].done());
  await background.suites[1].done();
});

test('a test filter in NODE_OPTIONS does not reach the child', async () => {
  const previous = process.env.NODE_OPTIONS;
  process.env.NODE_OPTIONS = `${previous ?? ''} --test-name-pattern=no-test-has-this-name`.trim();
  try {
    // With the filter the child would run no test and exit 0.
    const [suite] = backgroundSuites(['fail'], quiet()).suites;
    await assert.rejects(suite.done(), /fake background test fails/);
  } finally {
    if (previous === undefined) delete process.env.NODE_OPTIONS;
    else process.env.NODE_OPTIONS = previous;
  }
});

test('a test filter in the parent\'s flags does not reach the child', () => {
  for (const filter of [['--test-name-pattern=no-test-has-this-name'], ['--test-name-pattern', 'no-test-has-this-name']]) {
    const r = spawnSync(process.execPath, [...process.execArgv, ...filter, join(fixtures, 'filtered-parent.ts')], {
      encoding: 'utf8',
    });
    assert.equal(r.stdout.trim(), 'rejected', `${filter.join(' ')}: ${r.stderr}`);
  }
});

test('names the failing tests from colored reporter output too', async () => {
  const previous = process.env.FORCE_COLOR;
  process.env.FORCE_COLOR = '1';
  try {
    const [suite] = backgroundSuites(['fail'], quiet()).suites;
    await assert.rejects(suite.done(), /: \u2716 fake background test fails/);
  } finally {
    if (previous === undefined) delete process.env.FORCE_COLOR;
    else process.env.FORCE_COLOR = previous;
  }
});

test('passes the children\'s output on with a suite prefix', async () => {
  const { lines, output } = sink();
  await backgroundSuites(['pass'], { entry, output }).suites[0].done();
  assert.ok(lines.length > 0 && lines.every((l) => l.startsWith('[pass] ')), JSON.stringify(lines));
});

test('settle() resolves at once when nothing was started', async () => {
  await backgroundSuites(['pass'], quiet()).settle();
});
