// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, test } from 'node:test';
import assert from 'node:assert';
import { isBlocksError, ApiError } from '@aws-blocks/core';
import type { api as apiType } from 'aws-blocks';

// Error name constants — match KVStoreErrors.*. Written as strings here
// because the test runs under the `browser` condition where bb-kv-store only
// exports a stub and the constants.
const ConditionalCheckFailed = 'ConditionalCheckFailedException';
const ValidationFailed = 'ValidationFailedException';

function assertConditionalCheckFailed(e: unknown) {
  assert.ok(isBlocksError(e, ConditionalCheckFailed),
    `Expected ${ConditionalCheckFailed}, got ${e}`);
}

async function expectError(promise: Promise<unknown>, name: string): Promise<void> {
  try {
    await promise;
  } catch (e) {
    assert.ok(isBlocksError(e, name), `Expected ${name}, got ${e}`);
    return;
  }
  assert.fail(`Expected ${name}`);
}

export function kvStoreTests(getApi: () => typeof apiType) {

  describe('KVStore', () => {

    describe('CRUD', () => {
      test('put and get', async () => {
        const api = getApi();
        const key = `kv-${Date.now().toString(36)}`;
        await api.kvPut(key, 'hello');
        assert.strictEqual(await api.kvGet(key), 'hello');
        await api.kvDelete(key);
      });

      test('get non-existent key returns null', async () => {
        const api = getApi();
        assert.strictEqual(await api.kvGet('does-not-exist'), null);
      });

      test('put overwrites existing value', async () => {
        const api = getApi();
        const key = `kv-${Date.now().toString(36)}`;
        await api.kvPut(key, 'first');
        await api.kvPut(key, 'second');
        assert.strictEqual(await api.kvGet(key), 'second');
        await api.kvDelete(key);
      });

      test('delete removes key', async () => {
        const api = getApi();
        const key = `kv-${Date.now().toString(36)}`;
        await api.kvPut(key, 'value');
        await api.kvDelete(key);
        assert.strictEqual(await api.kvGet(key), null);
      });

      test('delete non-existent key is silent', async () => {
        const api = getApi();
        await api.kvDelete('never-existed');
      });

      test('scan returns all entries', async () => {
        const api = getApi();
        const prefix = `kv-scan-${Date.now().toString(36)}`;
        await api.kvPut(`${prefix}-a`, 'one');
        await api.kvPut(`${prefix}-b`, 'two');
        const entries = await api.kvScan();
        const ours = entries.filter((e) => e.key.startsWith(prefix));
        assert.strictEqual(ours.length, 2);
        await api.kvDelete(`${prefix}-a`);
        await api.kvDelete(`${prefix}-b`);
      });
    });

    describe('conditional put', () => {
      test('ifNotExists succeeds when key absent', async () => {
        const api = getApi();
        const key = `kv-${Date.now().toString(36)}`;
        await api.kvPut(key, 'created', { ifNotExists: true });
        assert.strictEqual(await api.kvGet(key), 'created');
        await api.kvDelete(key);
      });

      test('ifNotExists fails when key exists', async () => {
        const api = getApi();
        const key = `kv-${Date.now().toString(36)}`;
        await api.kvPut(key, 'original');
        try {
          await api.kvPut(key, 'duplicate', { ifNotExists: true });
          assert.fail('Expected error');
        } catch (e) { assertConditionalCheckFailed(e); }
        assert.strictEqual(await api.kvGet(key), 'original');
        await api.kvDelete(key);
      });

      test('ifValueEquals succeeds on match', async () => {
        const api = getApi();
        const key = `kv-${Date.now().toString(36)}`;
        await api.kvPut(key, 'v1');
        await api.kvPut(key, 'v2', { ifValueEquals: 'v1' });
        assert.strictEqual(await api.kvGet(key), 'v2');
        await api.kvDelete(key);
      });

      test('ifValueEquals fails on mismatch', async () => {
        const api = getApi();
        const key = `kv-${Date.now().toString(36)}`;
        await api.kvPut(key, 'v1');
        try {
          await api.kvPut(key, 'v2', { ifValueEquals: 'wrong' });
          assert.fail('Expected error');
        } catch (e) { assertConditionalCheckFailed(e); }
        assert.strictEqual(await api.kvGet(key), 'v1');
        await api.kvDelete(key);
      });

      test('ifValueEquals fails when key absent', async () => {
        const api = getApi();
        const key = `kv-absent-${Date.now().toString(36)}`;
        try {
          await api.kvPut(key, 'v1', { ifValueEquals: 'anything' });
          assert.fail('Expected error');
        } catch (e) { assertConditionalCheckFailed(e); }
        assert.strictEqual(await api.kvGet(key), null);
      });

      // `ifNotExists` and a value check compose with OR: the write succeeds when
      // the key is absent OR its current value matches, and fails only when the
      // key exists AND the value differs — "create it, or update it only if unchanged".
      test('ifNotExists OR ifValueEquals: creates a new key, updates a matching key, fails otherwise', async () => {
        const api = getApi();
        const key = `kv-or-${Date.now().toString(36)}`;
        await api.kvPut(key, 'v1', { ifNotExists: true, ifValueEquals: 'nope' });
        assert.strictEqual(await api.kvGet(key), 'v1');
        await api.kvPut(key, 'v2', { ifNotExists: true, ifValueEquals: 'v1' });
        assert.strictEqual(await api.kvGet(key), 'v2');
        try {
          await api.kvPut(key, 'v3', { ifNotExists: true, ifValueEquals: 'stale' });
          assert.fail('Expected error');
        } catch (e) {
          assertConditionalCheckFailed(e);
          assert.ok(e instanceof ApiError && e.retriable === true, 'the combined failure is the stale-value case');
        }
        assert.strictEqual(await api.kvGet(key), 'v2');
        await api.kvDelete(key);
      });
    });

    describe('conditional delete', () => {
      test('ifExists succeeds when key exists', async () => {
        const api = getApi();
        const key = `kv-${Date.now().toString(36)}`;
        await api.kvPut(key, 'value');
        await api.kvDelete(key, { ifExists: true });
        assert.strictEqual(await api.kvGet(key), null);
      });

      test('ifExists fails when key absent', async () => {
        const api = getApi();
        try {
          await api.kvDelete(`kv-absent-${Date.now().toString(36)}`, { ifExists: true });
          assert.fail('Expected error');
        } catch (e) { assertConditionalCheckFailed(e); }
      });

      test('ifValueEquals succeeds on match', async () => {
        const api = getApi();
        const key = `kv-${Date.now().toString(36)}`;
        await api.kvPut(key, 'target');
        await api.kvDelete(key, { ifValueEquals: 'target' });
        assert.strictEqual(await api.kvGet(key), null);
      });

      test('ifValueEquals fails on mismatch', async () => {
        const api = getApi();
        const key = `kv-${Date.now().toString(36)}`;
        await api.kvPut(key, 'actual');
        try {
          await api.kvDelete(key, { ifValueEquals: 'wrong' });
          assert.fail('Expected error');
        } catch (e) { assertConditionalCheckFailed(e); }
        assert.strictEqual(await api.kvGet(key), 'actual');
        await api.kvDelete(key);
      });

      test('ifValueEquals fails when key absent', async () => {
        const api = getApi();
        try {
          await api.kvDelete(`kv-absent-${Date.now().toString(36)}`, { ifValueEquals: 'anything' });
          assert.fail('Expected error');
        } catch (e) { assertConditionalCheckFailed(e); }
      });

      // `ifExists` and a value check compose with AND: both must hold.
      test('ifExists AND ifValueEquals: both must hold', async () => {
        const api = getApi();
        const key = `kv-and-${Date.now().toString(36)}`;
        await api.kvPut(key, 'v1');
        try {
          await api.kvDelete(key, { ifExists: true, ifValueEquals: 'wrong' });
          assert.fail('Expected error');
        } catch (e) {
          assertConditionalCheckFailed(e);
          assert.ok(e instanceof ApiError && e.retriable === false, 'the existence assertion wins');
        }
        assert.strictEqual(await api.kvGet(key), 'v1');
        await api.kvDelete(key, { ifExists: true, ifValueEquals: 'v1' });
        assert.strictEqual(await api.kvGet(key), null);
      });
    });

    describe('reads', () => {
      test('get is strongly consistent: a value written in the same request reads back', async () => {
        const api = getApi();
        const key = `kv-rw-${Date.now().toString(36)}`;
        for (let i = 0; i < 5; i++) {
          assert.strictEqual(await api.kvPutThenGet(key, `v${i}`), `v${i}`);
        }
        await api.kvDelete(key);
      });

      test('scan pages across requests with a cursor', async () => {
        const api = getApi();
        const prefix = `kv-page-${Date.now().toString(36)}`;
        const ours = [`${prefix}-a`, `${prefix}-b`, `${prefix}-c`];
        for (const key of ours) await api.kvPut(key, 'x');
        const seen: string[] = [];
        let cursor: string | undefined;
        let pages = 0;
        do {
          const page = await api.kvScanPage(2, cursor);
          assert.ok(page.entries.length <= 2, 'a page respects the limit');
          seen.push(...page.entries.map((e) => e.key).filter((k) => k.startsWith(prefix)));
          cursor = page.cursor;
          pages++;
          assert.ok(pages < 500, 'paging must terminate');
        } while (cursor !== undefined);
        assert.deepStrictEqual(seen.sort(), ours, 'every key is seen exactly once across the pages');
        for (const key of ours) await api.kvDelete(key);
      });

      test('a string store keeps the expiry outside the value and reports it as expiresAt', async () => {
        const api = getApi();
        const key = `kv-exp-${Date.now().toString(36)}`;
        const future = Math.floor(Date.now() / 1000) + 3600;
        await api.kvPutWithExpiry(key, 'v', future);
        assert.strictEqual(await api.kvGet(key), 'v');
        const entry = (await api.kvScan()).find((e) => e.key === key);
        assert.deepStrictEqual(entry, { key, value: 'v', expiresAt: future });
        const dead = `${key}-dead`;
        await api.kvPutWithExpiry(dead, 'v', 1);
        assert.strictEqual(await api.kvGet(dead), null, 'an expired item is hidden on read');
        await api.kvDelete(key);
        await api.kvDelete(dead);
      });
    });

    // OCC conflicts must serialize to JSON-RPC code 409 (Conflict) over the
    // wire — reconstructed client-side as an ApiError with status 409 — not a
    // generic 500. The error name is preserved so isBlocksError still matches.
    describe('OCC conflicts map to HTTP 409', () => {
      test('put ifNotExists conflict returns status 409 over the wire', async () => {
        const api = getApi();
        const key = `kv-409-${Date.now().toString(36)}`;
        await api.kvPut(key, 'original');
        try {
          await api.kvPut(key, 'dup', { ifNotExists: true });
          assert.fail('Expected a conflict error');
        } catch (e) {
          assert.ok(e instanceof ApiError, `Expected ApiError, got ${e}`);
          assert.strictEqual(e.status, 409, 'OCC conflict must be 409, not 500');
          assertConditionalCheckFailed(e);
        }
        await api.kvDelete(key);
      });

      test('delete ifExists conflict returns status 409 over the wire', async () => {
        const api = getApi();
        try {
          await api.kvDelete(`kv-absent-409-${Date.now().toString(36)}`, { ifExists: true });
          assert.fail('Expected a conflict error');
        } catch (e) {
          assert.ok(e instanceof ApiError, `Expected ApiError, got ${e}`);
          assert.strictEqual(e.status, 409, 'OCC conflict must be 409, not 500');
          assertConditionalCheckFailed(e);
        }
      });

      // The value-equals (optimistic-lock) path is the one that carries
      // `retriable: true` — distinct from the existence assertions above, which
      // are non-retriable. `retriable` rides the wire (serialized by rpc.ts,
      // reconstructed by decodeRpcResponse), so assert it here to lock the field
      // against a silent client-side regression.
      test('put ifValueEquals conflict returns status 409 with retriable:true over the wire', async () => {
        const api = getApi();
        const key = `kv-409-cas-${Date.now().toString(36)}`;
        await api.kvPut(key, 'seed');
        try {
          await api.kvPut(key, 'next', { ifValueEquals: 'wrong-expected' });
          assert.fail('Expected a conflict error');
        } catch (e) {
          assert.ok(e instanceof ApiError, `Expected ApiError, got ${e}`);
          assert.strictEqual(e.status, 409, 'OCC conflict must be 409, not 500');
          assertConditionalCheckFailed(e);
          assert.strictEqual(e.retriable, true, 'ifValueEquals optimistic-lock conflict must be retriable');
        }
        await api.kvDelete(key);
      });
    });

    describe('typed values', () => {
      test('number - preserves type', async () => {
        const api = getApi();
        const key = `kvn-${Date.now().toString(36)}`;
        await api.kvNumPut(key, 42);
        const val = await api.kvNumGet(key);
        assert.strictEqual(val, 42);
        assert.strictEqual(typeof val, 'number');
        await api.kvNumDelete(key);
      });

      test('number - ifNotExists fails when key exists', async () => {
        const api = getApi();
        const key = `kvn-${Date.now().toString(36)}`;
        await api.kvNumPut(key, 1);
        try {
          await api.kvNumPut(key, 2, { ifNotExists: true });
          assert.fail('Expected error');
        } catch (e) { assertConditionalCheckFailed(e); }
        assert.strictEqual(await api.kvNumGet(key), 1);
        await api.kvNumDelete(key);
      });

      test('number - ifValueEquals succeeds on match', async () => {
        const api = getApi();
        const key = `kvn-${Date.now().toString(36)}`;
        await api.kvNumPut(key, 10);
        await api.kvNumPut(key, 20, { ifValueEquals: 10 });
        assert.strictEqual(await api.kvNumGet(key), 20);
        await api.kvNumDelete(key);
      });

      test('number - ifValueEquals fails on mismatch', async () => {
        const api = getApi();
        const key = `kvn-${Date.now().toString(36)}`;
        await api.kvNumPut(key, 10);
        try {
          await api.kvNumPut(key, 20, { ifValueEquals: 99 });
          assert.fail('Expected error');
        } catch (e) { assertConditionalCheckFailed(e); }
        assert.strictEqual(await api.kvNumGet(key), 10);
        await api.kvNumDelete(key);
      });

      test('object - preserves structure', async () => {
        const api = getApi();
        const key = `kvo-${Date.now().toString(36)}`;
        const profile = { name: 'Alice', age: 30, tags: ['admin', 'user'] };
        await api.kvObjPut(key, profile);
        assert.deepStrictEqual(await api.kvObjGet(key), profile);
        await api.kvObjDelete(key);
      });

      test('object - overwrite replaces entire object', async () => {
        const api = getApi();
        const key = `kvo-${Date.now().toString(36)}`;
        await api.kvObjPut(key, { name: 'Alice', age: 30, tags: ['admin'] });
        await api.kvObjPut(key, { name: 'Bob', age: 25, tags: [] });
        assert.deepStrictEqual(await api.kvObjGet(key), { name: 'Bob', age: 25, tags: [] });
        await api.kvObjDelete(key);
      });

      test('object - ifNotExists fails when key exists', async () => {
        const api = getApi();
        const key = `kvo-${Date.now().toString(36)}`;
        const original = { name: 'Alice', age: 30, tags: [] as string[] };
        await api.kvObjPut(key, original);
        try {
          await api.kvObjPut(key, { name: 'Bob', age: 25, tags: [] }, { ifNotExists: true });
          assert.fail('Expected error');
        } catch (e) { assertConditionalCheckFailed(e); }
        assert.deepStrictEqual(await api.kvObjGet(key), original);
        await api.kvObjDelete(key);
      });

      test('object - ifFieldEquals compares fields of the stored value', async () => {
        const api = getApi();
        const key = `kvo-${Date.now().toString(36)}`;
        await api.kvObjPut(key, { name: 'Alice', age: 30, tags: ['a'] });
        await api.kvObjPut(key, { name: 'Alice', age: 31, tags: ['a'] }, { ifFieldEquals: { age: 30, tags: ['a'] } });
        assert.strictEqual((await api.kvObjGet(key))?.age, 31);
        try {
          await api.kvObjPut(key, { name: 'Alice', age: 32, tags: [] }, { ifFieldEquals: { age: 30 } });
          assert.fail('Expected error');
        } catch (e) { assertConditionalCheckFailed(e); }
        await api.kvObjDelete(key);
      });
    });

    describe('schema validation', () => {
      test('accepts valid data', async () => {
        const api = getApi();
        const key = `kvv-${Date.now().toString(36)}`;
        await api.kvValidatedPut(key, { name: 'Alice', age: 30, tags: ['admin'] });
        assert.deepStrictEqual(await api.kvValidatedGet(key), { name: 'Alice', age: 30, tags: ['admin'] });
        await api.kvValidatedDelete(key);
      });

      test('rejects invalid data', async () => {
        const api = getApi();
        const key = `kvv-${Date.now().toString(36)}`;
        try {
          await api.kvValidatedPut(key, { name: 123, age: 'not a number', tags: 'not an array' });
          assert.fail('Expected validation error');
        } catch (e) {
          assert.ok(isBlocksError(e, 'ValidationFailedException'), `Expected ValidationFailedException, got ${e}`);
        }
        assert.strictEqual(await api.kvValidatedGet(key), null);
      });

      test('rejects a value field with the reserved _bkv_ prefix', async () => {
        const api = getApi();
        const key = `kvv-${Date.now().toString(36)}`;
        await expectError(api.kvValidatedPut(key, { name: 'Alice', age: 30, tags: [], _bkv_pk: 'other' }), ValidationFailed);
        await expectError(api.kvValidatedPut(key, { name: 'Alice', age: 30, tags: [], _bkv_ttl: 1 }), ValidationFailed);
        assert.strictEqual(await api.kvValidatedGet(key), null);
      });

      test('rejects an empty string in an indexed field', async () => {
        const api = getApi();
        const key = `kvv-${Date.now().toString(36)}`;
        await expectError(api.kvValidatedPut(key, { name: '', age: 30, tags: [] }), ValidationFailed);
        assert.strictEqual(await api.kvValidatedGet(key), null);
      });

      test('an index reads a string-key store by another field, and the entry carries the string key', async () => {
        const api = getApi();
        const stamp = Date.now().toString(36);
        const name = `Indexed ${stamp}`;
        await api.kvValidatedPut(`kvv-${stamp}-1`, { name, age: 1, tags: [] });
        await api.kvValidatedPut(`kvv-${stamp}-2`, { name, age: 2, tags: [] });
        // Index reads are eventually consistent on AWS, so poll briefly.
        let hits = await api.kvValidatedQueryByName(name);
        for (let attempt = 0; hits.length < 2 && attempt < 20; attempt++) {
          await new Promise((resolve) => setTimeout(resolve, 500));
          hits = await api.kvValidatedQueryByName(name);
        }
        assert.deepStrictEqual(hits.map((h) => h.key).sort(), [`kvv-${stamp}-1`, `kvv-${stamp}-2`]);
        assert.deepStrictEqual(hits.map((h) => h.value.age).sort(), [1, 2]);
        await api.kvValidatedDelete(`kvv-${stamp}-1`);
        await api.kvValidatedDelete(`kvv-${stamp}-2`);
      });
    });

  });

}
