// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { test } from 'node:test';
import assert from 'node:assert';
import { initializePgliteWithRetry, isPgliteUnreachableTrap, type PgliteLike } from './pglite-init.js';

/** A fake PGlite whose probe query throws for the first `failTimes` calls. */
class FakePglite implements PgliteLike {
  queryCount = 0;
  closed = false;
  constructor(
    private readonly failTimes: number,
    private readonly error: unknown = new Error('RuntimeError: unreachable'),
  ) {}
  async query(_sql: string): Promise<unknown> {
    this.queryCount++;
    if (this.queryCount <= this.failTimes) throw this.error;
    return { rows: [], affectedRows: 0 };
  }
  async close(): Promise<void> {
    this.closed = true;
  }
}

const NO_BACKOFF = { backoffMs: 0 } as const;

// --- isPgliteUnreachableTrap ---

test('isPgliteUnreachableTrap matches an unreachable message', () => {
  assert.strictEqual(isPgliteUnreachableTrap(new Error('RuntimeError: unreachable')), true);
});

test('isPgliteUnreachableTrap matches unreachable found only in the stack', () => {
  const err = new Error('Aborted()');
  err.stack = 'Error: Aborted()\n  at _pg_initdb (wasm://wasm/0001)\n  RuntimeError: unreachable';
  assert.strictEqual(isPgliteUnreachableTrap(err), true);
});

test('isPgliteUnreachableTrap walks the cause chain', () => {
  const root = new Error('unreachable');
  const wrapper = new Error('initdb failed', { cause: root });
  assert.strictEqual(isPgliteUnreachableTrap(wrapper), true);
});

test('isPgliteUnreachableTrap matches non-Error values', () => {
  assert.strictEqual(isPgliteUnreachableTrap('RuntimeError: unreachable'), true);
});

test('isPgliteUnreachableTrap returns false for unrelated errors', () => {
  assert.strictEqual(isPgliteUnreachableTrap(new Error('syntax error at or near "SELCT"')), false);
  assert.strictEqual(isPgliteUnreachableTrap(null), false);
  assert.strictEqual(isPgliteUnreachableTrap(undefined), false);
});

test('isPgliteUnreachableTrap terminates on a cyclic cause chain', () => {
  const a = new Error('boom') as Error & { cause?: unknown };
  const b = new Error('bang', { cause: a }) as Error & { cause?: unknown };
  a.cause = b;
  assert.strictEqual(isPgliteUnreachableTrap(a), false);
});

// --- initializePgliteWithRetry ---

test('returns the initial instance when the probe succeeds first try', async () => {
  const initial = new FakePglite(0);
  let recreated = 0;
  const result = await initializePgliteWithRetry(
    initial,
    () => {
      recreated++;
      return new FakePglite(0);
    },
    NO_BACKOFF,
  );
  assert.strictEqual(result, initial);
  assert.strictEqual(recreated, 0);
  assert.strictEqual(initial.queryCount, 1);
  assert.strictEqual(initial.closed, false);
});

test('recreates once and recovers after a single unreachable trap', async () => {
  const initial = new FakePglite(1);
  const replacement = new FakePglite(0);
  let recreated = 0;
  const result = await initializePgliteWithRetry(
    initial,
    () => {
      recreated++;
      return replacement;
    },
    NO_BACKOFF,
  );
  assert.strictEqual(result, replacement);
  assert.strictEqual(recreated, 1);
  assert.strictEqual(initial.closed, true, 'the dead instance must be closed before recreate');
  assert.strictEqual(replacement.queryCount, 1);
});

test('recreates twice before recovering within the attempt budget', async () => {
  const instances = [new FakePglite(1), new FakePglite(1), new FakePglite(0)];
  let idx = 1;
  const result = await initializePgliteWithRetry(instances[0], () => instances[idx++], NO_BACKOFF);
  assert.strictEqual(result, instances[2]);
  assert.strictEqual(instances[0].closed, true);
  assert.strictEqual(instances[1].closed, true);
  assert.strictEqual(instances[2].closed, false);
});

test('throws after exhausting the default attempt budget on a persistent trap', async () => {
  let created = 1; // the initial instance is the first
  await assert.rejects(
    () =>
      initializePgliteWithRetry(
        new FakePglite(99),
        () => {
          created++;
          return new FakePglite(99);
        },
        NO_BACKOFF,
      ),
    /unreachable/,
  );
  assert.strictEqual(created, 3, 'default maxAttempts=3 → initial + 2 recreates');
});

test('respects a custom maxAttempts', async () => {
  let created = 1;
  await assert.rejects(
    () =>
      initializePgliteWithRetry(
        new FakePglite(99),
        () => {
          created++;
          return new FakePglite(99);
        },
        { backoffMs: 0, maxAttempts: 5 },
      ),
    /unreachable/,
  );
  assert.strictEqual(created, 5);
});

test('rethrows a non-retryable error immediately without recreating', async () => {
  const initial = new FakePglite(1, new Error('syntax error'));
  let recreated = 0;
  await assert.rejects(
    () =>
      initializePgliteWithRetry(
        initial,
        () => {
          recreated++;
          return new FakePglite(0);
        },
        NO_BACKOFF,
      ),
    /syntax error/,
  );
  assert.strictEqual(recreated, 0);
  assert.strictEqual(initial.closed, false);
});

test('invokes onRetry with the failed attempt number before each recreate', async () => {
  const attempts: number[] = [];
  // initial traps, first recreate also traps, second recreate succeeds — so
  // onRetry fires once per failed attempt: [1, 2].
  const replacements = [new FakePglite(1), new FakePglite(0)];
  let idx = 0;
  await initializePgliteWithRetry(new FakePglite(1), () => replacements[idx++], {
    backoffMs: 0,
    onRetry: (attempt) => attempts.push(attempt),
  });
  assert.deepStrictEqual(attempts, [1, 2]);
});

test('a custom isRetryable can broaden what is retried', async () => {
  const initial = new FakePglite(1, new Error('Aborted()'));
  const replacement = new FakePglite(0);
  const result = await initializePgliteWithRetry(initial, () => replacement, {
    backoffMs: 0,
    isRetryable: (e) => e instanceof Error && /aborted/i.test(e.message),
  });
  assert.strictEqual(result, replacement);
});
