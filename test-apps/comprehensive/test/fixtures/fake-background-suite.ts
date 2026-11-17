// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Stand-in for run-background-suite.ts in background-suites.test.ts. The
 * suite name picks the behaviour: `pass`, `fail` (one failing test), `crash`
 * (throws at import, before any test), `slow` (writes FAKE_SUITE_MARKER
 * after a second) or `env` (prints the NODE_OPTIONS it was started with).
 */

import { writeFileSync } from 'node:fs';
import { test } from 'node:test';
import { setTimeout } from 'node:timers/promises';

const mode = process.argv[2];
if (mode === 'crash') throw new Error('fake background suite crashed at import');

test('fake background test passes', () => {});

if (mode === 'fail') {
  test('fake background test fails', () => {
    throw new Error('fake failure');
  });
}

if (mode === 'slow') {
  test('fake background test finishes late', async () => {
    await setTimeout(1000);
    const marker = process.env.FAKE_SUITE_MARKER;
    if (marker) writeFileSync(marker, 'done');
  });
}

if (mode === 'env') {
  test('fake background test prints its NODE_OPTIONS', () => {
    console.log(`NODE_OPTIONS=${process.env.NODE_OPTIONS ?? ''}`);
  });
}
