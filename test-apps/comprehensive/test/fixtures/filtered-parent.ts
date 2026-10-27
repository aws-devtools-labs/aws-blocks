// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Parent stand-in for background-suites.test.ts: runs one fake suite (the
 * first argument, default `fail`) and prints `rejected` or `resolved`. The
 * test spawns it with flags (a --test-name-pattern, an inspector flag) that
 * must not reach the child.
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { backgroundSuites } from '../background-suites.js';

const entry = join(dirname(fileURLToPath(import.meta.url)), 'fake-background-suite.ts');
const [suite] = backgroundSuites([process.argv[2] ?? 'fail'], { entry, output: { stdout: () => {}, stderr: () => {} } }).suites;
await suite.done().then(
  () => console.log('resolved'),
  () => console.log('rejected'),
);
