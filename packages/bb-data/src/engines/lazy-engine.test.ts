// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { test } from 'node:test';
import assert from 'node:assert';
import type { DatabaseEngine } from '@aws-blocks/data-common';
import { LazyEngine } from './lazy-engine.js';

test('LazyEngine.destroy is a no-op when the engine was never resolved', async () => {
  let calls = 0;
  const lazy = new LazyEngine(async () => {
    calls++;
    throw new Error('should not be invoked');
  });
  await lazy.destroy();
  assert.strictEqual(calls, 0);
});

test('LazyEngine.destroy tears down cleanly after the factory rejected', async () => {
  const lazy = new LazyEngine(async () => {
    throw new Error('missing extension package');
  });
  // The first interaction surfaces the factory error...
  await assert.rejects(() => lazy.query('select 1'), /missing extension package/);
  // ...but teardown must not re-throw it.
  await lazy.destroy();
});

test('LazyEngine.destroy closes the resolved engine', async () => {
  let destroyed = 0;
  const inner = {
    query: async () => [],
    destroy: async () => {
      destroyed++;
    },
  } as unknown as DatabaseEngine;
  const lazy = new LazyEngine(async () => inner);
  await lazy.query('select 1');
  await lazy.destroy();
  assert.strictEqual(destroyed, 1);
});
