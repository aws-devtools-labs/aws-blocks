// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, test } from 'node:test';
import assert from 'node:assert';
import { isBlocksError, ApiError } from '@aws-blocks/core';
import type { api as apiType } from 'aws-blocks';

// Error name constant — matches KVStoreErrors.ConditionalCheckFailed.
// Imported as a string here because the test runs under the `browser`
// condition where bb-kv-store only exports a stub.
const ConditionalCheckFailed = 'ConditionalCheckFailedException';

function assertConditionalCheckFailed(e: unknown) {
  assert.ok(isBlocksError(e, ConditionalCheckFailed),
    `Expected ${ConditionalCheckFailed}, got ${e}`);
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
    });

  });

}
