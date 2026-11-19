// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Pattern 3 (custom BB) — mock-mode behavior test.
 *
 * In mock mode, the bb-queue Queue.send() pushes to an in-memory array. We
 * confirm the resolution + behavior here without hitting AWS.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert';
import { Scope } from '@aws-cdk-blocks/core';
import { Queue } from '@guide/bb-queue';

describe('bb-queue (mock)', () => {
  test('Queue.send pushes to in-memory queue', async () => {
    const scope = new Scope('test-app');
    const q = new Queue(scope, 'work');
    await q.send({ hello: 'world' });
    await q.send({ second: true });
    assert.strictEqual(q.sent.length, 2);
    assert.deepStrictEqual(q.sent[0], { hello: 'world' });
    assert.deepStrictEqual(q.sent[1], { second: true });
  });
});
