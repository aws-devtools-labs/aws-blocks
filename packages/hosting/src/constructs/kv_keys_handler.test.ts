// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { batches, computeDiff, deleteDrainSet } from './kv_keys_handler.js';

// Regression for the Delete-path drain bug: CloudFormation does not send
// OldResourceProperties on Delete, so the keys to drain must come from
// ResourceProperties.Entries. A previous version read OldResourceProperties →
// always empty → nothing drained → orphaned KVS keys.
describe('kv_keys_handler — deleteDrainSet', () => {
  it('drains the keys from ResourceProperties.Entries (Delete has no OldResourceProperties)', () => {
    const entries = { meta: '{"b":"x"}', r0: '[]', d0: '[]' };
    const event = {
      RequestType: 'Delete' as const,
      ResourceProperties: { KvsArn: 'arn:kvs', Entries: JSON.stringify(entries) },
      // CloudFormation does NOT include this on Delete — present here as undefined
      OldResourceProperties: undefined,
    };
    assert.deepEqual(deleteDrainSet(event), entries);
  });

  it('returns {} when there are no entries', () => {
    const event = {
      RequestType: 'Delete' as const,
      ResourceProperties: { KvsArn: 'arn:kvs', Entries: '' },
    };
    assert.deepEqual(deleteDrainSet(event), {});
  });

  it('does NOT depend on OldResourceProperties (would be the bug)', () => {
    // Even if OldResourceProperties were somehow set, the drain set is driven
    // by ResourceProperties — the only field CFN populates on Delete.
    const real = { meta: '{}', h0: '[]' };
    const event = {
      RequestType: 'Delete' as const,
      ResourceProperties: { KvsArn: 'arn:kvs', Entries: JSON.stringify(real) },
      OldResourceProperties: { Entries: '{}' },
    };
    assert.deepEqual(deleteDrainSet(event), real);
  });
});

// The route-table flip is applied via batched UpdateKeys calls. An off-by-one
// at the 50-key boundary would partial-apply the table mid-cutover and surface
// as an opaque deploy-time failure — so the pure diff + batching are unit-tested
// at the boundaries here.
describe('kv_keys_handler — computeDiff', () => {
  it('puts new + changed keys, deletes removed keys, skips unchanged', () => {
    const desired = { a: '1', b: '2-new', c: '3' }; // a unchanged, b changed, c new
    const previous = { a: '1', b: '2-old', d: '4' }; // d removed
    const { puts, deletes } = computeDiff(desired, previous);
    assert.deepEqual(
      puts.sort((x, y) => x.Key.localeCompare(y.Key)),
      [
        { Key: 'b', Value: '2-new' },
        { Key: 'c', Value: '3' },
      ],
    );
    assert.deepEqual(deletes, [{ Key: 'd' }]);
  });

  it('is a no-op when desired equals previous', () => {
    const same = { a: '1', b: '2' };
    const { puts, deletes } = computeDiff(same, { ...same });
    assert.equal(puts.length, 0);
    assert.equal(deletes.length, 0);
  });
});

describe('kv_keys_handler — batches (50-key / 3 MB boundaries)', () => {
  const mkPuts = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ Key: `k${i}`, Value: 'v' }));
  const collect = (
    puts: { Key: string; Value: string }[],
    deletes: { Key: string }[] = [],
  ) => [...batches(puts, deletes)];

  it('packs exactly 50 puts into a single batch', () => {
    const out = collect(mkPuts(50));
    assert.equal(out.length, 1);
    assert.equal(out[0].puts.length, 50);
  });

  it('splits 51 puts into 50 + 1', () => {
    const out = collect(mkPuts(51));
    assert.equal(out.length, 2);
    assert.equal(out[0].puts.length, 50);
    assert.equal(out[1].puts.length, 1);
  });

  it('counts puts AND deletes against the same 50-key ceiling (mixed crossing)', () => {
    // 30 puts + 30 deletes = 60 keys → must split (50 then 10), not one batch.
    const deletes = Array.from({ length: 30 }, (_, i) => ({ Key: `d${i}` }));
    const out = collect(mkPuts(30), deletes);
    const totalKeys = out.reduce(
      (n, b) => n + b.puts.length + b.deletes.length,
      0,
    );
    assert.equal(totalKeys, 60); // nothing dropped
    assert.ok(
      out.every((b) => b.puts.length + b.deletes.length <= 50),
      'no batch exceeds the 50-key ceiling',
    );
    assert.equal(out.length, 2);
  });

  it('flushes on the 3 MB byte ceiling before the key ceiling', () => {
    // Two ~2 MB puts (4 MB total) must land in separate batches even though
    // they are only 2 keys — the byte ceiling trips first.
    const big = 'x'.repeat(2 * 1024 * 1024);
    const out = collect([
      { Key: 'a', Value: big },
      { Key: 'b', Value: big },
    ]);
    assert.equal(out.length, 2);
  });

  it('yields nothing for an empty diff (no-op path)', () => {
    assert.equal(collect([], []).length, 0);
  });
});
