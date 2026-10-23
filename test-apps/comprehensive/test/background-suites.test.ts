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
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { backgroundSuites } from './background-suites.js';

const entry = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-background-suite.ts');

test('done() resolves when the child suite passes', async () => {
  const [suite] = backgroundSuites(['pass'], { entry }).suites;
  await suite.done();
});

test('done() rejects and names the failing test when one child test fails', async () => {
  const [suite] = backgroundSuites(['fail'], { entry }).suites;
  await assert.rejects(suite.done(), (err: Error) => {
    assert.match(err.message, /Background suite "fail" failed \(exit 1\)/);
    assert.match(err.message, /fake background test fails/);
    assert.doesNotMatch(err.message, /fake background test passes/);
    return true;
  });
});

test('done() rejects when the child crashes at import', async () => {
  const [suite] = backgroundSuites(['crash'], { entry }).suites;
  await assert.rejects(suite.done(), /Background suite "crash" failed \(exit 1\)/);
});

test('done() rejects when the entry cannot be loaded', async () => {
  const [suite] = backgroundSuites(['pass'], { entry: join(tmpdir(), 'no-such-background-suite.ts') }).suites;
  await assert.rejects(suite.done(), /Background suite "pass" failed/);
});

test('settle() waits for started children that no done() test awaits', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'background-suites-'));
  const marker = join(dir, 'marker');
  const previous = process.env.FAKE_SUITE_MARKER;
  process.env.FAKE_SUITE_MARKER = marker;
  try {
    const background = backgroundSuites(['slow'], { entry });
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
  const background = backgroundSuites(['fail', 'pass'], { entry });
  background.start();
  await background.settle();
  await assert.rejects(background.suites[0].done());
  await background.suites[1].done();
});

test('settle() resolves at once when nothing was started', async () => {
  await backgroundSuites(['pass'], { entry }).settle();
});
