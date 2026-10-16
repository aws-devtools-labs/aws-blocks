// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { record } from '../timing.js';

let outputs = '';

// Like the hosting specs' beforeAll: read what globalSetup deployed, with an await.
test.beforeAll(async () => {
  outputs = await readFile(new URL(import.meta.url), 'utf-8');
});

test('runs against the deployed stack; the retry reuses it', () => {
  record(`test retry=${test.info().retry}`);
  expect(outputs).not.toBe('');
  // Fail the first attempt so the retry (a fresh worker) runs too.
  expect(test.info().retry).toBe(1);
});
