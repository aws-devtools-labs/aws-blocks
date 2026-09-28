// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, test } from 'node:test';
import assert from 'node:assert';
import { isBlocksError, ApiError } from '@aws-blocks/core';
import { DistributedTableErrors } from '@aws-blocks/bb-distributed-table';
import type { api as apiType } from 'aws-blocks';

const { ConditionalCheckFailed } = DistributedTableErrors;

function uid() { return `dt-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`; }

export function distributedTableTests(getApi: () => typeof apiType) {

  describe('DistributedTable', () => {

    describe('CRUD', () => {
      test('put and get', async () => {
        const api = getApi();
        const pk = uid();
        const item = { pk, sk: 'sk1', data: 'hello', timestamp: 1000 };
        await api.tablePut(item);
        assert.deepStrictEqual(await api.tableGet({ pk, sk: 'sk1' }), item);
        await api.tableDelete({ pk, sk: 'sk1' });
      });

      test('get non-existent item returns null', async () => {
        assert.strictEqual(await getApi().tableGet({ pk: 'nope', sk: 'nope' }), null);
      });

      test('put overwrites existing item', async () => {
        const api = getApi();
        const pk = uid();
        await api.tablePut({ pk, sk: 'sk1', data: 'first', timestamp: 1000 });
        await api.tablePut({ pk, sk: 'sk1', data: 'second', timestamp: 1000 });
        assert.strictEqual((await api.tableGet({ pk, sk: 'sk1' }))?.data, 'second');
        await api.tableDelete({ pk, sk: 'sk1' });
      });

      test('delete removes item', async () => {
        const api = getApi();
        const pk = uid();
        await api.tablePut({ pk, sk: 'sk1', data: 'bye', timestamp: 1000 });
        await api.tableDelete({ pk, sk: 'sk1' });
        assert.strictEqual(await api.tableGet({ pk, sk: 'sk1' }), null);
      });

      test('delete non-existent item is silent', async () => {
        await getApi().tableDelete({ pk: 'never-existed', sk: 'nope' });
      });
    });

    describe('conditional put', () => {
      test('ifNotExists succeeds on new item', async () => {
        const api = getApi();
        const pk = uid();
        const item = { pk, sk: 'sk1', data: 'created', timestamp: 1000 };
        await api.tablePut(item, { ifNotExists: true });
        assert.deepStrictEqual(await api.tableGet({ pk, sk: 'sk1' }), item);
        await api.tableDelete({ pk, sk: 'sk1' });
      });

      test('ifNotExists fails on existing item', async () => {
        const api = getApi();
        const pk = uid();
        await api.tablePut({ pk, sk: 'sk1', data: 'original', timestamp: 1000 });
        try {
          await api.tablePut({ pk, sk: 'sk1', data: 'dup', timestamp: 1000 }, { ifNotExists: true });
          assert.fail('Expected error');
        } catch (e) {
          assert.ok(isBlocksError(e, ConditionalCheckFailed));
        }
        assert.strictEqual((await api.tableGet({ pk, sk: 'sk1' }))?.data, 'original');
        await api.tableDelete({ pk, sk: 'sk1' });
      });

      // OCC conflicts must serialize to JSON-RPC code 409 (Conflict) over the
      // wire — reconstructed client-side as an ApiError with status 409 — not a
      // generic 500. The error name is preserved so isBlocksError still matches.
      test('ifNotExists conflict returns status 409 over the wire', async () => {
        const api = getApi();
        const pk = uid();
        await api.tablePut({ pk, sk: 'sk1', data: 'original', timestamp: 1000 });
        try {
          await api.tablePut({ pk, sk: 'sk1', data: 'dup', timestamp: 1000 }, { ifNotExists: true });
          assert.fail('Expected a conflict error');
        } catch (e) {
          assert.ok(e instanceof ApiError, `Expected ApiError, got ${e}`);
          assert.strictEqual(e.status, 409, 'OCC conflict must be 409, not 500');
          assert.ok(isBlocksError(e, ConditionalCheckFailed));
        }
        await api.tableDelete({ pk, sk: 'sk1' });
      });

      test('ifFieldEquals succeeds on match', async () => {
        const api = getApi();
        const pk = uid();
        await api.tablePut({ pk, sk: 'sk1', data: 'v1', timestamp: 1000 });
        await api.tablePut({ pk, sk: 'sk1', data: 'v2', timestamp: 1000 }, { ifFieldEquals: { data: 'v1' } });
        assert.strictEqual((await api.tableGet({ pk, sk: 'sk1' }))?.data, 'v2');
        await api.tableDelete({ pk, sk: 'sk1' });
      });

      test('ifFieldEquals fails on mismatch', async () => {
        const api = getApi();
        const pk = uid();
        await api.tablePut({ pk, sk: 'sk1', data: 'v1', timestamp: 1000 });
        try {
          await api.tablePut({ pk, sk: 'sk1', data: 'v2', timestamp: 1000 }, { ifFieldEquals: { data: 'wrong' } });
          assert.fail('Expected error');
        } catch (e) {
          assert.ok(isBlocksError(e, ConditionalCheckFailed));
        }
        await api.tableDelete({ pk, sk: 'sk1' });
      });
    });

    describe('conditional delete', () => {
      test('ifExists succeeds when item exists', async () => {
        const api = getApi();
        const pk = uid();
        await api.tablePut({ pk, sk: 'sk1', data: 'bye', timestamp: 1000 });
        await api.tableDelete({ pk, sk: 'sk1' }, { ifExists: true });
        assert.strictEqual(await api.tableGet({ pk, sk: 'sk1' }), null);
      });

      test('ifExists fails when item absent', async () => {
        try {
          await getApi().tableDelete({ pk: `absent-${uid()}`, sk: 'nope' }, { ifExists: true });
          assert.fail('Expected error');
        } catch (e) {
          assert.ok(isBlocksError(e, ConditionalCheckFailed));
        }
      });

      test('ifFieldEquals succeeds on match', async () => {
        const api = getApi();
        const pk = uid();
        await api.tablePut({ pk, sk: 'sk1', data: 'target', timestamp: 1000 });
        await api.tableDelete({ pk, sk: 'sk1' }, { ifFieldEquals: { data: 'target' } });
        assert.strictEqual(await api.tableGet({ pk, sk: 'sk1' }), null);
      });

      test('ifFieldEquals fails on mismatch', async () => {
        const api = getApi();
        const pk = uid();
        await api.tablePut({ pk, sk: 'sk1', data: 'actual', timestamp: 1000 });
        try {
          await getApi().tableDelete({ pk, sk: 'sk1' }, { ifFieldEquals: { data: 'wrong' } });
          assert.fail('Expected error');
        } catch (e) {
          assert.ok(isBlocksError(e, ConditionalCheckFailed));
        }
        await api.tableDelete({ pk, sk: 'sk1' });
      });
    });

    // ── Query: numeric sort key (byTimestamp index) ──────────────────────
    // These tests construct KeyCondition objects directly — the types flow
    // from DistributedTable through the thin API wrapper to the call site.
    // pk requires { equals }, timestamp accepts SortKeyCondition<number>.

    describe('query (numeric sort key)', () => {
      async function seed(api: typeof apiType, pk: string) {
        await api.tablePut({ pk, sk: 'a', data: 'A', timestamp: 1000 });
        await api.tablePut({ pk, sk: 'b', data: 'B', timestamp: 2000 });
        await api.tablePut({ pk, sk: 'c', data: 'C', timestamp: 3000 });
        await api.tablePut({ pk, sk: 'd', data: 'D', timestamp: 4000 });
        await api.tablePut({ pk, sk: 'e', data: 'E', timestamp: 5000 });
      }
      async function clean(api: typeof apiType, pk: string) {
        await api.tableDeleteBatch([
          { pk, sk: 'a' }, { pk, sk: 'b' }, { pk, sk: 'c' }, { pk, sk: 'd' }, { pk, sk: 'e' },
        ]);
      }

      test('no filter — returns all sorted', async () => {
        const api = getApi(); const pk = uid();
        await seed(api, pk);
        const items = await api.tableQuery({ index: "byTimestamp", where: { pk: { equals: pk } } });
        assert.strictEqual(items.length, 5);
        assert.deepStrictEqual(items.map((i) => i.timestamp), [1000, 2000, 3000, 4000, 5000]);
        await clean(api, pk);
      });

      test('equals', async () => {
        const api = getApi(); const pk = uid();
        await seed(api, pk);
        const items = await api.tableQuery({ index: "byTimestamp", where: { pk: { equals: pk }, timestamp: { equals: 3000 } } });
        assert.strictEqual(items.length, 1);
        assert.strictEqual(items[0].data, 'C');
        await clean(api, pk);
      });

      test('greaterThan', async () => {
        const api = getApi(); const pk = uid();
        await seed(api, pk);
        const items = await api.tableQuery({ index: "byTimestamp", where: { pk: { equals: pk }, timestamp: { greaterThan: 3000 } } });
        assert.strictEqual(items.length, 2);
        assert.deepStrictEqual(items.map((i) => i.timestamp), [4000, 5000]);
        await clean(api, pk);
      });

      test('greaterThanOrEqual', async () => {
        const api = getApi(); const pk = uid();
        await seed(api, pk);
        const items = await api.tableQuery({ index: "byTimestamp", where: { pk: { equals: pk }, timestamp: { greaterThanOrEqual: 3000 } } });
        assert.strictEqual(items.length, 3);
        await clean(api, pk);
      });

      test('lessThan', async () => {
        const api = getApi(); const pk = uid();
        await seed(api, pk);
        const items = await api.tableQuery({ index: "byTimestamp", where: { pk: { equals: pk }, timestamp: { lessThan: 3000 } } });
        assert.strictEqual(items.length, 2);
        await clean(api, pk);
      });

      test('lessThanOrEqual', async () => {
        const api = getApi(); const pk = uid();
        await seed(api, pk);
        const items = await api.tableQuery({ index: "byTimestamp", where: { pk: { equals: pk }, timestamp: { lessThanOrEqual: 3000 } } });
        assert.strictEqual(items.length, 3);
        await clean(api, pk);
      });

      test('between (inclusive)', async () => {
        const api = getApi(); const pk = uid();
        await seed(api, pk);
        const items = await api.tableQuery({ index: "byTimestamp", where: { pk: { equals: pk }, timestamp: { between: [2000, 4000] } } });
        assert.strictEqual(items.length, 3);
        await clean(api, pk);
      });

      test('between — no match', async () => {
        const api = getApi(); const pk = uid();
        await seed(api, pk);
        const items = await api.tableQuery({ index: "byTimestamp", where: { pk: { equals: pk }, timestamp: { between: [5500, 6000] } } });
        assert.strictEqual(items.length, 0);
        await clean(api, pk);
      });

      test('limit', async () => {
        const api = getApi(); const pk = uid();
        await seed(api, pk);
        const items = await api.tableQuery({ index: "byTimestamp", where: { pk: { equals: pk } }, limit: 2 });
        assert.strictEqual(items.length, 2);
        await clean(api, pk);
      });

      test('filter + limit combined', async () => {
        const api = getApi(); const pk = uid();
        await seed(api, pk);
        const items = await api.tableQuery({ index: "byTimestamp", where: { pk: { equals: pk }, timestamp: { greaterThan: 1000 } }, limit: 2 });
        assert.strictEqual(items.length, 2);
        assert.deepStrictEqual(items.map((i) => i.timestamp), [2000, 3000]);
        await clean(api, pk);
      });

      test('partition isolation', async () => {
        const api = getApi(); const pk = uid();
        await seed(api, pk);
        const items = await api.tableQuery({ index: "byTimestamp", where: { pk: { equals: `other-${uid()}` } } });
        assert.strictEqual(items.length, 0);
        await clean(api, pk);
      });
    });

    // ── Query: string sort key (bySk index) ─────────────────────────────
    // pk requires { equals }, sk accepts SortKeyCondition<string> including beginsWith.

    describe('query (string sort key)', () => {
      async function seed(api: typeof apiType, pk: string) {
        await api.tablePut({ pk, sk: '/docs/a.txt', data: 'a', timestamp: 1 });
        await api.tablePut({ pk, sk: '/docs/b.txt', data: 'b', timestamp: 2 });
        await api.tablePut({ pk, sk: '/images/cat.jpg', data: 'c', timestamp: 3 });
        await api.tablePut({ pk, sk: '/images/dog.jpg', data: 'd', timestamp: 4 });
        await api.tablePut({ pk, sk: '/videos/clip.mp4', data: 'e', timestamp: 5 });
      }
      async function clean(api: typeof apiType, pk: string) {
        await api.tableDeleteBatch([
          { pk, sk: '/docs/a.txt' }, { pk, sk: '/docs/b.txt' },
          { pk, sk: '/images/cat.jpg' }, { pk, sk: '/images/dog.jpg' },
          { pk, sk: '/videos/clip.mp4' },
        ]);
      }

      test('no filter — sorted lexicographically', async () => {
        const api = getApi(); const pk = uid();
        await seed(api, pk);
        const items = await api.tableQuery({ index: "bySk", where: { pk: { equals: pk } } });
        assert.strictEqual(items.length, 5);
        assert.deepStrictEqual(items.map((i) => i.sk), [
          '/docs/a.txt', '/docs/b.txt', '/images/cat.jpg', '/images/dog.jpg', '/videos/clip.mp4',
        ]);
        await clean(api, pk);
      });

      test('equals', async () => {
        const api = getApi(); const pk = uid();
        await seed(api, pk);
        const items = await api.tableQuery({ index: "bySk", where: { pk: { equals: pk }, sk: { equals: '/docs/a.txt' } } });
        assert.strictEqual(items.length, 1);
        assert.strictEqual(items[0].data, 'a');
        await clean(api, pk);
      });

      test('beginsWith', async () => {
        const api = getApi(); const pk = uid();
        await seed(api, pk);
        const items = await api.tableQuery({ index: "bySk", where: { pk: { equals: pk }, sk: { beginsWith: '/docs/' } } });
        assert.strictEqual(items.length, 2);
        await clean(api, pk);
      });

      test('beginsWith — no match', async () => {
        const api = getApi(); const pk = uid();
        await seed(api, pk);
        const items = await api.tableQuery({ index: "bySk", where: { pk: { equals: pk }, sk: { beginsWith: '/music/' } } });
        assert.strictEqual(items.length, 0);
        await clean(api, pk);
      });

      test('greaterThan (lexicographic)', async () => {
        const api = getApi(); const pk = uid();
        await seed(api, pk);
        const items = await api.tableQuery({ index: "bySk", where: { pk: { equals: pk }, sk: { greaterThan: '/images/' } } });
        assert.strictEqual(items.length, 3);
        await clean(api, pk);
      });

      test('lessThan (lexicographic)', async () => {
        const api = getApi(); const pk = uid();
        await seed(api, pk);
        const items = await api.tableQuery({ index: "bySk", where: { pk: { equals: pk }, sk: { lessThan: '/images/' } } });
        assert.strictEqual(items.length, 2);
        await clean(api, pk);
      });

      test('between (lexicographic, inclusive)', async () => {
        const api = getApi(); const pk = uid();
        await seed(api, pk);
        const items = await api.tableQuery({ index: "bySk", where: { pk: { equals: pk }, sk: { between: ['/docs/', '/images/d'] } } });
        assert.strictEqual(items.length, 3);
        await clean(api, pk);
      });

      test('beginsWith + limit', async () => {
        const api = getApi(); const pk = uid();
        await seed(api, pk);
        const items = await api.tableQuery({ index: "bySk", where: { pk: { equals: pk }, sk: { beginsWith: '/images/' } }, limit: 1 });
        assert.strictEqual(items.length, 1);
        await clean(api, pk);
      });
    });

    describe('scan', () => {
      test('returns items', async () => {
        const api = getApi(); const pk = uid();
        await api.tablePut({ pk, sk: 'sk1', data: 'a', timestamp: 1000 });
        await api.tablePut({ pk, sk: 'sk2', data: 'b', timestamp: 2000 });
        const results = await api.tableScan();
        assert.ok(results.filter((i) => i.pk === pk).length >= 2);
        await api.tableDeleteBatch([{ pk, sk: 'sk1' }, { pk, sk: 'sk2' }]);
      });
    });

    describe('batch operations', () => {
      test('putBatch and getBatch', async () => {
        const api = getApi(); const pk = uid();
        const items = [
          { pk, sk: 'b1', data: 'one', timestamp: 1000 },
          { pk, sk: 'b2', data: 'two', timestamp: 2000 },
          { pk, sk: 'b3', data: 'three', timestamp: 3000 },
        ];
        await api.tablePutBatch(items);
        const results = await api.tableGetBatch([{ pk, sk: 'b1' }, { pk, sk: 'b2' }, { pk, sk: 'missing' }]);
        assert.strictEqual(results.length, 3);
        assert.deepStrictEqual(results[0], items[0]);
        assert.deepStrictEqual(results[1], items[1]);
        assert.strictEqual(results[2], null);
        await api.tableDeleteBatch([{ pk, sk: 'b1' }, { pk, sk: 'b2' }, { pk, sk: 'b3' }]);
      });

      test('deleteBatch removes items', async () => {
        const api = getApi(); const pk = uid();
        await api.tablePutBatch([
          { pk, sk: 'd1', data: 'a', timestamp: 1000 },
          { pk, sk: 'd2', data: 'b', timestamp: 2000 },
        ]);
        await api.tableDeleteBatch([{ pk, sk: 'd1' }, { pk, sk: 'd2' }]);
        assert.strictEqual(await api.tableGet({ pk, sk: 'd1' }), null);
        assert.strictEqual(await api.tableGet({ pk, sk: 'd2' }), null);
      });
    });

    // ── Primary key query ─────────────────────────────────────────────────

    describe('primary key query', () => {
      test('returns items by partition key', async () => {
        const api = getApi(); const pk = uid();
        await api.tablePut({ pk, sk: 'a', data: 'one', timestamp: 100 });
        await api.tablePut({ pk, sk: 'b', data: 'two', timestamp: 200 });
        await api.tablePut({ pk: uid(), sk: 'c', data: 'other', timestamp: 300 });
        const results = await api.tableQuery({ where: { pk: { equals: pk } } });
        assert.strictEqual(results.length, 2);
        for (const item of results) assert.strictEqual(item.pk, pk);
      });

      test('supports sort key conditions on primary key', async () => {
        const api = getApi(); const pk = uid();
        await api.tablePut({ pk, sk: 'alpha', data: 'a', timestamp: 1 });
        await api.tablePut({ pk, sk: 'beta', data: 'b', timestamp: 2 });
        await api.tablePut({ pk, sk: 'gamma', data: 'c', timestamp: 3 });
        const results = await api.tableQuery({ where: { pk: { equals: pk }, sk: { beginsWith: 'b' } } });
        assert.strictEqual(results.length, 1);
        assert.strictEqual(results[0].sk, 'beta');
      });

      test('order desc reverses results', async () => {
        const api = getApi(); const pk = uid();
        await api.tablePut({ pk, sk: 'a', data: '1', timestamp: 100 });
        await api.tablePut({ pk, sk: 'b', data: '2', timestamp: 200 });
        await api.tablePut({ pk, sk: 'c', data: '3', timestamp: 300 });
        const asc = await api.tableQuery({ where: { pk: { equals: pk } } });
        const desc = await api.tableQuery({ where: { pk: { equals: pk } }, order: 'desc' });
        assert.strictEqual(asc.length, 3);
        assert.strictEqual(desc.length, 3);
        assert.strictEqual(asc[0].sk, 'a');
        assert.strictEqual(desc[0].sk, 'c');
      });
    });

    // ── TTL table ─────────────────────────────────────────────────────────

    describe('TTL table', () => {
      test('put and get with expiresAt field', async () => {
        const api = getApi(); const pk = uid();
        const futureExpiry = Math.floor(Date.now() / 1000) + 3600;
        await api.ttlTablePut({ pk, sk: 'ttl-test', data: 'hello', expiresAt: futureExpiry });
        const item = await api.ttlTableGet({ pk, sk: 'ttl-test' });
        assert.ok(item);
        assert.strictEqual(item.data, 'hello');
        assert.strictEqual(item.expiresAt, futureExpiry);
      });
    });

  });
}
