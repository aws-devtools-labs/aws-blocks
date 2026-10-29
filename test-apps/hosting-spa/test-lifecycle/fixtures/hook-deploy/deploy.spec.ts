// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { test, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { DEPLOY_BLOCK_S, record } from '../timing.js';

let outputs = '';

test.beforeAll(async () => {
  record('deploy');
  execFileSync('sleep', [DEPLOY_BLOCK_S]); // a synchronous CloudFront deploy
  outputs = await readFile(new URL(import.meta.url), 'utf-8'); // yields, like the SSM secret read
});

test.afterAll(() => {
  record('destroy');
});

test('runs against the deployed stack', () => {
  record(`test retry=${test.info().retry}`);
  expect(outputs).not.toBe('');
});
