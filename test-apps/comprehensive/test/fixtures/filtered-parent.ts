// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Parent stand-in for background-suites.test.ts: runs the `fail` fake suite and
 * prints `rejected` or `resolved`. The test spawns it with a --test-name-pattern
 * in its flags, which must not reach the child.
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { backgroundSuites } from '../background-suites.js';

const entry = join(dirname(fileURLToPath(import.meta.url)), 'fake-background-suite.ts');
const [suite] = backgroundSuites(['fail'], { entry, output: { stdout: () => {}, stderr: () => {} } }).suites;
await suite.done().then(
  () => console.log('resolved'),
  () => console.log('rejected'),
);
