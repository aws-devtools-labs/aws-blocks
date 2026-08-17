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

test('isPgliteUnreachableTrap matches the Emscripten Aborted() and wasm trap signatures', () => {
  assert.strictEqual(isPgliteUnreachableTrap(new Error('Aborted(). Build with -sASSERTIONS for more info.')), true);
  assert.strictEqual(isPgliteUnreachableTrap(new Error('wasm trap: unreachable')), true);
  // Emscripten aborts under memory pressure carry a reason — the case this
  // retry exists for — so the non-empty `Aborted(<reason>)` form must match too.
  assert.strictEqual(isPgliteUnreachableTrap(new Error('Aborted(Cannot enlarge memory arrays)')), true);
  assert.strictEqual(isPgliteUnreachableTrap(new Error('Aborted(OOM)')), true);
});

test('isPgliteUnreachableTrap matches a trap signature found only in the stack', () => {
  const err = new Error('initdb boot failed');
  err.stack = 'Error: initdb boot failed\n  at _pg_initdb (wasm://wasm/0001)\n  RuntimeError: unreachable';
  assert.strictEqual(isPgliteUnreachableTrap(err), true);
});

test('isPgliteUnreachableTrap walks the cause chain', () => {
  const root = new Error('RuntimeError: unreachable');
  const wrapper = new Error('initdb failed', { cause: root });
  assert.strictEqual(isPgliteUnreachableTrap(wrapper), true);
});

test('isPgliteUnreachableTrap ignores a bare "unreachable" without a trap signature', () => {
  // The classifier must fire on a real WASM trap signature, not the word alone —
  // otherwise an unrelated failure whose text/stack merely contains "unreachable"
  // (an assertUnreachable helper, an "unreachable host" message) would be retried.
  assert.strictEqual(isPgliteUnreachableTrap(new Error('assertUnreachable: unhandled case')), false);
  assert.strictEqual(isPgliteUnreachableTrap(new Error('connect ETIMEDOUT: host unreachable')), false);
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
  const initial = new FakePglite(99);
  const created: FakePglite[] = [initial];
  await assert.rejects(
    () =>
      initializePgliteWithRetry(
        initial,
        () => {
          const next = new FakePglite(99);
          created.push(next);
          return next;
        },
        NO_BACKOFF,
      ),
    /unreachable/,
  );
  assert.strictEqual(created.length, 3, 'default maxAttempts=3 → initial + 2 recreates');
  // Every instance — including the last trapped one — must be closed once retries
  // are exhausted, so no dead WASM instance leaks (regression for the exhausted path).
  for (const instance of created) {
    assert.strictEqual(instance.closed, true);
  }
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

test('maxAttempts=1 with a non-retryable error does not close the instance', async () => {
  // Regression for the reorder: retryability is classified BEFORE the attempt
  // budget, so a single-attempt run no longer closes an instance whose failure
  // was never diagnosed as a WASM trap.
  const initial = new FakePglite(1, new Error('syntax error'));
  await assert.rejects(
    () => initializePgliteWithRetry(initial, () => new FakePglite(0), { backoffMs: 0, maxAttempts: 1 }),
    /syntax error/,
  );
  assert.strictEqual(initial.closed, false);
});

test('maxAttempts=1 with a trap closes the instance and does not recreate', async () => {
  const initial = new FakePglite(99);
  let recreated = 0;
  await assert.rejects(
    () =>
      initializePgliteWithRetry(
        initial,
        () => {
          recreated++;
          return new FakePglite(0);
        },
        { backoffMs: 0, maxAttempts: 1 },
      ),
    /unreachable/,
  );
  assert.strictEqual(initial.closed, true, 'a trapped instance is still closed even with no retries left');
  assert.strictEqual(recreated, 0, 'no recreate once the attempt budget is exhausted');
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

test('does not invoke onRetry on the final, exhausting attempt', async () => {
  // Pins the reorder: onRetry must fire only for attempts that actually recreate,
  // not the terminal give-up attempt. With maxAttempts=2 the trap on attempt 2 is
  // the exhausting one, so onRetry should see [1] only. Guards against a future
  // regression that moves onRetry back above the attempt-budget check.
  const attempts: number[] = [];
  await assert.rejects(
    () =>
      initializePgliteWithRetry(new FakePglite(99), () => new FakePglite(99), {
        backoffMs: 0,
        maxAttempts: 2,
        onRetry: (a) => attempts.push(a),
      }),
    /unreachable/,
  );
  assert.deepStrictEqual(attempts, [1]);
});

test('wraps a recreate() failure while preserving the original trap as the cause', async () => {
  const initial = new FakePglite(1);
  const recreateError = new Error('ENOSPC: no space left on device');
  await assert.rejects(
    () =>
      initializePgliteWithRetry(
        initial,
        () => {
          throw recreateError;
        },
        NO_BACKOFF,
      ),
    (err: Error) => {
      assert.match(err.message, /Failed to recreate PGlite after an init trap/);
      assert.match(err.message, /ENOSPC/);
      assert.ok(err.cause instanceof Error && /unreachable/.test(err.cause.message), 'original trap kept as cause');
      return true;
    },
  );
  assert.strictEqual(initial.closed, true, 'the trapped instance is still closed before recreate is attempted');
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
