// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// KVStore with a declared key (the document form): records that an app lists
// or queries as a collection. Every call is key-first, and `query`/`scan`
// yield `{ key, value, expiresAt? }` entries with a `cursor` for the next page.
//
// Error names are asserted as literal strings because the test runs under the
// `browser` condition, where bb-kv-store only exports a stub and the constants.

import { describe, test } from 'node:test';
import assert from 'node:assert';
import { isBlocksError, ApiError } from '@aws-blocks/core';
import type { api as apiType } from 'aws-blocks';

const ConditionalCheckFailed = 'ConditionalCheckFailedException';
const ValidationFailed = 'ValidationFailedException';
const InvalidQuery = 'InvalidQueryException';

function uid() { return `dt-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`; }

async function expectError(promise: Promise<unknown>, name: string): Promise<unknown> {
  try {
    await promise;
  } catch (e) {
    assert.ok(isBlocksError(e, name), `Expected ${name}, got ${e}`);
    return e;
  }
  assert.fail(`Expected ${name}`);
}

export function kvStoreDocumentsTests(getApi: () => typeof apiType) {

  describe('KVStore with a declared key', () => {

    describe('CRUD', () => {
      test('put writes the key fields from the key; get returns the whole record', async () => {
        const api = getApi();
        const pk = uid();
        await api.tablePut({ pk, sk: 'sk1' }, { data: 'hello', timestamp: 1000 });
        assert.deepStrictEqual(await api.tableGet({ pk, sk: 'sk1' }), { pk, sk: 'sk1', data: 'hello', timestamp: 1000 });
        await api.tableDelete({ pk, sk: 'sk1' });
      });

      test('the value may carry the key fields when they agree with the key', async () => {
        const api = getApi();
        const pk = uid();
        await api.tablePut({ pk, sk: 'sk1' }, { pk, sk: 'sk1', data: 'hello', timestamp: 1000 });
        assert.strictEqual((await api.tableGet({ pk, sk: 'sk1' }))?.data, 'hello');
        await api.tableDelete({ pk, sk: 'sk1' });
      });

      test('a value whose key field disagrees with the key is rejected', async () => {
        const api = getApi();
        const pk = uid();
        await expectError(
          api.tablePut({ pk, sk: 'sk1' }, { pk: `${pk}-other`, sk: 'sk1', data: 'x', timestamp: 1 }),
          ValidationFailed,
        );
        assert.strictEqual(await api.tableGet({ pk, sk: 'sk1' }), null);
      });

      test('an empty string in a key field is rejected', async () => {
        const api = getApi();
        await expectError(api.tablePut({ pk: uid(), sk: '' }, { data: 'x', timestamp: 1 }), ValidationFailed);
      });

      test('get non-existent item returns null', async () => {
        assert.strictEqual(await getApi().tableGet({ pk: 'nope', sk: 'nope' }), null);
      });

      test('put overwrites existing item', async () => {
        const api = getApi();
        const pk = uid();
        await api.tablePut({ pk, sk: 'sk1' }, { data: 'first', timestamp: 1000 });
        await api.tablePut({ pk, sk: 'sk1' }, { data: 'second', timestamp: 1000 });
        assert.strictEqual((await api.tableGet({ pk, sk: 'sk1' }))?.data, 'second');
        await api.tableDelete({ pk, sk: 'sk1' });
      });

      test('delete removes item; deleting a missing item is silent', async () => {
        const api = getApi();
        const pk = uid();
        await api.tablePut({ pk, sk: 'sk1' }, { data: 'bye', timestamp: 1000 });
        await api.tableDelete({ pk, sk: 'sk1' });
        assert.strictEqual(await api.tableGet({ pk, sk: 'sk1' }), null);
        await api.tableDelete({ pk: 'never-existed', sk: 'nope' });
      });
    });

    describe('conditional put', () => {
      test('ifNotExists succeeds on new item and fails on existing item', async () => {
        const api = getApi();
        const pk = uid();
        await api.tablePut({ pk, sk: 'sk1' }, { data: 'created', timestamp: 1000 }, { ifNotExists: true });
        await expectError(
          api.tablePut({ pk, sk: 'sk1' }, { data: 'dup', timestamp: 1000 }, { ifNotExists: true }),
          ConditionalCheckFailed,
        );
        assert.strictEqual((await api.tableGet({ pk, sk: 'sk1' }))?.data, 'created');
        await api.tableDelete({ pk, sk: 'sk1' });
      });

      // OCC conflicts must serialize to JSON-RPC code 409 (Conflict) over the
      // wire — reconstructed client-side as an ApiError with status 409 — not a
      // generic 500. The error name is preserved so isBlocksError still matches.
      test('ifNotExists conflict returns status 409 over the wire', async () => {
        const api = getApi();
        const pk = uid();
        await api.tablePut({ pk, sk: 'sk1' }, { data: 'original', timestamp: 1000 });
        try {
          await api.tablePut({ pk, sk: 'sk1' }, { data: 'dup', timestamp: 1000 }, { ifNotExists: true });
          assert.fail('Expected a conflict error');
        } catch (e) {
          assert.ok(e instanceof ApiError, `Expected ApiError, got ${e}`);
          assert.strictEqual(e.status, 409, 'OCC conflict must be 409, not 500');
          assert.ok(isBlocksError(e, ConditionalCheckFailed));
          assert.strictEqual(e.retriable, false, 'a pure existence assertion is not retriable');
        }
        await api.tableDelete({ pk, sk: 'sk1' });
      });

      test('ifFieldEquals succeeds on match and fails on mismatch (retriable)', async () => {
        const api = getApi();
        const pk = uid();
        await api.tablePut({ pk, sk: 'sk1' }, { data: 'v1', timestamp: 1000 });
        await api.tablePut({ pk, sk: 'sk1' }, { data: 'v2', timestamp: 1000 }, { ifFieldEquals: { data: 'v1' } });
        assert.strictEqual((await api.tableGet({ pk, sk: 'sk1' }))?.data, 'v2');
        const e = await expectError(
          api.tablePut({ pk, sk: 'sk1' }, { data: 'v3', timestamp: 1000 }, { ifFieldEquals: { data: 'wrong' } }),
          ConditionalCheckFailed,
        );
        assert.ok(e instanceof ApiError && e.retriable === true, 'a field check conflict is retriable');
        await api.tableDelete({ pk, sk: 'sk1' });
      });

      test('ifNotExists OR ifFieldEquals: creates, then updates only an unchanged record', async () => {
        const api = getApi();
        const pk = uid();
        await api.tablePut({ pk, sk: 'sk1' }, { data: 'v1', timestamp: 1 }, { ifNotExists: true, ifFieldEquals: { timestamp: 0 } });
        await api.tablePut({ pk, sk: 'sk1' }, { data: 'v2', timestamp: 2 }, { ifNotExists: true, ifFieldEquals: { timestamp: 1 } });
        await expectError(
          api.tablePut({ pk, sk: 'sk1' }, { data: 'v3', timestamp: 3 }, { ifNotExists: true, ifFieldEquals: { timestamp: 1 } }),
          ConditionalCheckFailed,
        );
        assert.strictEqual((await api.tableGet({ pk, sk: 'sk1' }))?.data, 'v2');
        await api.tableDelete({ pk, sk: 'sk1' });
      });
    });

    describe('conditional delete', () => {
      test('ifExists succeeds when item exists and fails when absent', async () => {
        const api = getApi();
        const pk = uid();
        await api.tablePut({ pk, sk: 'sk1' }, { data: 'bye', timestamp: 1000 });
        await api.tableDelete({ pk, sk: 'sk1' }, { ifExists: true });
        assert.strictEqual(await api.tableGet({ pk, sk: 'sk1' }), null);
        await expectError(api.tableDelete({ pk: `absent-${uid()}`, sk: 'nope' }, { ifExists: true }), ConditionalCheckFailed);
      });

      test('ifFieldEquals succeeds on match and fails on mismatch; ifExists AND ifFieldEquals need both', async () => {
        const api = getApi();
        const pk = uid();
        await api.tablePut({ pk, sk: 'sk1' }, { data: 'target', timestamp: 1000 });
        await expectError(api.tableDelete({ pk, sk: 'sk1' }, { ifFieldEquals: { data: 'wrong' } }), ConditionalCheckFailed);
        await expectError(api.tableDelete({ pk, sk: 'sk1' }, { ifExists: true, ifFieldEquals: { data: 'wrong' } }), ConditionalCheckFailed);
        await api.tableDelete({ pk, sk: 'sk1' }, { ifExists: true, ifFieldEquals: { data: 'target' } });
        assert.strictEqual(await api.tableGet({ pk, sk: 'sk1' }), null);
      });
    });

    // ── Query: numeric sort key (byTimestamp index) ──────────────────────
    // These tests construct `where` objects directly — the types flow from
    // KVStore through the thin API wrapper to the call site. pk requires
    // { equals }, timestamp accepts a SortCondition<number>.

    describe('query (numeric sort key)', () => {
      async function seed(api: typeof apiType, pk: string) {
        await api.tablePut({ pk, sk: 'a' }, { data: 'A', timestamp: 1000 });
        await api.tablePut({ pk, sk: 'b' }, { data: 'B', timestamp: 2000 });
        await api.tablePut({ pk, sk: 'c' }, { data: 'C', timestamp: 3000 });
        await api.tablePut({ pk, sk: 'd' }, { data: 'D', timestamp: 4000 });
        await api.tablePut({ pk, sk: 'e' }, { data: 'E', timestamp: 5000 });
      }
      async function clean(api: typeof apiType, pk: string) {
        await api.tableDeleteBatch([
          { pk, sk: 'a' }, { pk, sk: 'b' }, { pk, sk: 'c' }, { pk, sk: 'd' }, { pk, sk: 'e' },
        ]);
      }
      const timestamps = (items: { value: { timestamp: number } }[]) => items.map((i) => i.value.timestamp);

      test('no filter — returns all sorted, and every entry carries its key', async () => {
        const api = getApi(); const pk = uid();
        await seed(api, pk);
        const items = await api.tableQuery({ index: 'byTimestamp', where: { pk: { equals: pk } } });
        assert.strictEqual(items.length, 5);
        assert.deepStrictEqual(timestamps(items), [1000, 2000, 3000, 4000, 5000]);
        assert.deepStrictEqual(items[0].key, { pk, sk: 'a' });
        await clean(api, pk);
      });

      test('equals', async () => {
        const api = getApi(); const pk = uid();
        await seed(api, pk);
        const items = await api.tableQuery({ index: 'byTimestamp', where: { pk: { equals: pk }, timestamp: { equals: 3000 } } });
        assert.strictEqual(items.length, 1);
        assert.strictEqual(items[0].value.data, 'C');
        await clean(api, pk);
      });

      test('greaterThan / greaterThanOrEqual / lessThan / lessThanOrEqual', async () => {
        const api = getApi(); const pk = uid();
        await seed(api, pk);
        assert.deepStrictEqual(timestamps(await api.tableQuery({ index: 'byTimestamp', where: { pk: { equals: pk }, timestamp: { greaterThan: 3000 } } })), [4000, 5000]);
        assert.strictEqual((await api.tableQuery({ index: 'byTimestamp', where: { pk: { equals: pk }, timestamp: { greaterThanOrEqual: 3000 } } })).length, 3);
        assert.strictEqual((await api.tableQuery({ index: 'byTimestamp', where: { pk: { equals: pk }, timestamp: { lessThan: 3000 } } })).length, 2);
        assert.strictEqual((await api.tableQuery({ index: 'byTimestamp', where: { pk: { equals: pk }, timestamp: { lessThanOrEqual: 3000 } } })).length, 3);
        await clean(api, pk);
      });

      test('between (inclusive), and between with no match', async () => {
        const api = getApi(); const pk = uid();
        await seed(api, pk);
        assert.strictEqual((await api.tableQuery({ index: 'byTimestamp', where: { pk: { equals: pk }, timestamp: { between: [2000, 4000] } } })).length, 3);
        assert.strictEqual((await api.tableQuery({ index: 'byTimestamp', where: { pk: { equals: pk }, timestamp: { between: [5500, 6000] } } })).length, 0);
        await clean(api, pk);
      });

      test('limit, and filter + limit combined', async () => {
        const api = getApi(); const pk = uid();
        await seed(api, pk);
        assert.strictEqual((await api.tableQuery({ index: 'byTimestamp', where: { pk: { equals: pk } }, limit: 2 })).length, 2);
        const items = await api.tableQuery({ index: 'byTimestamp', where: { pk: { equals: pk }, timestamp: { greaterThan: 1000 } }, limit: 2 });
        assert.deepStrictEqual(timestamps(items), [2000, 3000]);
        await clean(api, pk);
      });

      test('partition isolation', async () => {
        const api = getApi(); const pk = uid();
        await seed(api, pk);
        const items = await api.tableQuery({ index: 'byTimestamp', where: { pk: { equals: `other-${uid()}` } } });
        assert.strictEqual(items.length, 0);
        await clean(api, pk);
      });
    });

    // ── Query: string sort key (bySk index) ─────────────────────────────

    describe('query (string sort key)', () => {
      async function seed(api: typeof apiType, pk: string) {
        await api.tablePut({ pk, sk: '/docs/a.txt' }, { data: 'a', timestamp: 1 });
        await api.tablePut({ pk, sk: '/docs/b.txt' }, { data: 'b', timestamp: 2 });
        await api.tablePut({ pk, sk: '/images/cat.jpg' }, { data: 'c', timestamp: 3 });
        await api.tablePut({ pk, sk: '/images/dog.jpg' }, { data: 'd', timestamp: 4 });
        await api.tablePut({ pk, sk: '/videos/clip.mp4' }, { data: 'e', timestamp: 5 });
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
        const items = await api.tableQuery({ index: 'bySk', where: { pk: { equals: pk } } });
        assert.deepStrictEqual(items.map((i) => i.value.sk), [
          '/docs/a.txt', '/docs/b.txt', '/images/cat.jpg', '/images/dog.jpg', '/videos/clip.mp4',
        ]);
        await clean(api, pk);
      });

      test('equals, beginsWith, greaterThan, lessThan, between', async () => {
        const api = getApi(); const pk = uid();
        await seed(api, pk);
        assert.strictEqual((await api.tableQuery({ index: 'bySk', where: { pk: { equals: pk }, sk: { equals: '/docs/a.txt' } } }))[0].value.data, 'a');
        assert.strictEqual((await api.tableQuery({ index: 'bySk', where: { pk: { equals: pk }, sk: { beginsWith: '/docs/' } } })).length, 2);
        assert.strictEqual((await api.tableQuery({ index: 'bySk', where: { pk: { equals: pk }, sk: { beginsWith: '/music/' } } })).length, 0);
        assert.strictEqual((await api.tableQuery({ index: 'bySk', where: { pk: { equals: pk }, sk: { greaterThan: '/images/' } } })).length, 3);
        assert.strictEqual((await api.tableQuery({ index: 'bySk', where: { pk: { equals: pk }, sk: { lessThan: '/images/' } } })).length, 2);
        assert.strictEqual((await api.tableQuery({ index: 'bySk', where: { pk: { equals: pk }, sk: { between: ['/docs/', '/images/d'] } } })).length, 3);
        await clean(api, pk);
      });

      test('beginsWith + limit', async () => {
        const api = getApi(); const pk = uid();
        await seed(api, pk);
        const items = await api.tableQuery({ index: 'bySk', where: { pk: { equals: pk }, sk: { beginsWith: '/images/' } }, limit: 1 });
        assert.strictEqual(items.length, 1);
        await clean(api, pk);
      });
    });

    // ── Pages ────────────────────────────────────────────────────────────

    describe('pages', () => {
      test('a cursor continues the query in a later request and is undefined at the end', async () => {
        const api = getApi(); const pk = uid();
        for (const sk of ['a', 'b', 'c', 'd', 'e']) await api.tablePut({ pk, sk }, { data: sk, timestamp: 1 });
        const first = await api.tableQueryPage({ where: { pk: { equals: pk } }, limit: 2 });
        assert.deepStrictEqual(first.entries.map((e) => e.value.sk), ['a', 'b']);
        assert.strictEqual(typeof first.cursor, 'string');
        const second = await api.tableQueryPage({ where: { pk: { equals: pk } }, limit: 2, cursor: first.cursor });
        assert.deepStrictEqual(second.entries.map((e) => e.value.sk), ['c', 'd']);
        const third = await api.tableQueryPage({ where: { pk: { equals: pk } }, limit: 2, cursor: second.cursor });
        assert.deepStrictEqual(third.entries.map((e) => e.value.sk), ['e']);
        if (third.cursor !== undefined) {
          // DynamoDB can hand back a position after the last item; the next page is then empty.
          const fourth = await api.tableQueryPage({ where: { pk: { equals: pk } }, limit: 2, cursor: third.cursor });
          assert.deepStrictEqual(fourth.entries, []);
          assert.strictEqual(fourth.cursor, undefined);
        }
        await api.tableDeleteBatch(['a', 'b', 'c', 'd', 'e'].map((sk) => ({ pk, sk })));
      });

      test('a cursor is checked against the call: another partition, another index, or a garbled cursor is InvalidQuery', async () => {
        const api = getApi(); const pk = uid();
        await api.tablePut({ pk, sk: 'a' }, { data: 'a', timestamp: 1 });
        await api.tablePut({ pk, sk: 'b' }, { data: 'b', timestamp: 2 });
        const first = await api.tableQueryPage({ where: { pk: { equals: pk } }, limit: 1 });
        assert.strictEqual(typeof first.cursor, 'string');
        await expectError(api.tableQueryPage({ where: { pk: { equals: `${pk}-other` } }, cursor: first.cursor }), InvalidQuery);
        await expectError(api.tableQueryPage({ index: 'byTimestamp', where: { pk: { equals: pk } }, cursor: first.cursor }), InvalidQuery);
        await expectError(api.tableQueryPage({ where: { pk: { equals: pk } }, cursor: 'not-a-cursor' }), InvalidQuery);
        await api.tableDeleteBatch([{ pk, sk: 'a' }, { pk, sk: 'b' }]);
      });
    });

    describe('scan', () => {
      test('returns entries', async () => {
        const api = getApi(); const pk = uid();
        await api.tablePut({ pk, sk: 'sk1' }, { data: 'a', timestamp: 1000 });
        await api.tablePut({ pk, sk: 'sk2' }, { data: 'b', timestamp: 2000 });
        const results = await api.tableScan();
        assert.ok(results.filter((e) => e.value.pk === pk).length >= 2);
        await api.tableDeleteBatch([{ pk, sk: 'sk1' }, { pk, sk: 'sk2' }]);
      });
    });

    describe('batch operations', () => {
      test('putBatch and getBatch', async () => {
        const api = getApi(); const pk = uid();
        await api.tablePutBatch([
          { key: { pk, sk: 'b1' }, value: { data: 'one', timestamp: 1000 } },
          { key: { pk, sk: 'b2' }, value: { data: 'two', timestamp: 2000 } },
          { key: { pk, sk: 'b3' }, value: { data: 'three', timestamp: 3000 } },
        ]);
        const results = await api.tableGetBatch([{ pk, sk: 'b1' }, { pk, sk: 'b2' }, { pk, sk: 'missing' }]);
        assert.deepStrictEqual(results, [
          { pk, sk: 'b1', data: 'one', timestamp: 1000 },
          { pk, sk: 'b2', data: 'two', timestamp: 2000 },
          null,
        ]);
        await api.tableDeleteBatch([{ pk, sk: 'b1' }, { pk, sk: 'b2' }, { pk, sk: 'b3' }]);
      });

      test('deleteBatch removes items', async () => {
        const api = getApi(); const pk = uid();
        await api.tablePutBatch([
          { key: { pk, sk: 'd1' }, value: { data: 'a', timestamp: 1000 } },
          { key: { pk, sk: 'd2' }, value: { data: 'b', timestamp: 2000 } },
        ]);
        await api.tableDeleteBatch([{ pk, sk: 'd1' }, { pk, sk: 'd2' }]);
        assert.strictEqual(await api.tableGet({ pk, sk: 'd1' }), null);
        assert.strictEqual(await api.tableGet({ pk, sk: 'd2' }), null);
      });
    });

    // ── Query by the declared key ─────────────────────────────────────────

    describe('query by the declared key', () => {
      test('returns items by partition key', async () => {
        const api = getApi(); const pk = uid();
        await api.tablePut({ pk, sk: 'a' }, { data: 'one', timestamp: 100 });
        await api.tablePut({ pk, sk: 'b' }, { data: 'two', timestamp: 200 });
        await api.tablePut({ pk: uid(), sk: 'c' }, { data: 'other', timestamp: 300 });
        const results = await api.tableQuery({ where: { pk: { equals: pk } } });
        assert.strictEqual(results.length, 2);
        for (const item of results) assert.strictEqual(item.value.pk, pk);
      });

      test('supports sort key conditions', async () => {
        const api = getApi(); const pk = uid();
        await api.tablePut({ pk, sk: 'alpha' }, { data: 'a', timestamp: 1 });
        await api.tablePut({ pk, sk: 'beta' }, { data: 'b', timestamp: 2 });
        await api.tablePut({ pk, sk: 'gamma' }, { data: 'c', timestamp: 3 });
        const results = await api.tableQuery({ where: { pk: { equals: pk }, sk: { beginsWith: 'b' } } });
        assert.strictEqual(results.length, 1);
        assert.strictEqual(results[0].value.sk, 'beta');
      });

      test('order desc reverses results', async () => {
        const api = getApi(); const pk = uid();
        await api.tablePut({ pk, sk: 'a' }, { data: '1', timestamp: 100 });
        await api.tablePut({ pk, sk: 'b' }, { data: '2', timestamp: 200 });
        await api.tablePut({ pk, sk: 'c' }, { data: '3', timestamp: 300 });
        const asc = await api.tableQuery({ where: { pk: { equals: pk } } });
        const desc = await api.tableQuery({ where: { pk: { equals: pk } }, order: 'desc' });
        assert.strictEqual(asc[0].value.sk, 'a');
        assert.strictEqual(desc[0].value.sk, 'c');
      });
    });

    // ── A ttl field ───────────────────────────────────────────────────────

    describe('ttl field', () => {
      test('the expiry lives in the named field: a read keeps it in the value and reports it as expiresAt', async () => {
        const api = getApi(); const pk = uid();
        const futureExpiry = Math.floor(Date.now() / 1000) + 3600;
        await api.ttlTablePut({ pk, sk: 'ttl-test' }, { data: 'hello', expiresAt: futureExpiry });
        const item = await api.ttlTableGet({ pk, sk: 'ttl-test' });
        assert.ok(item);
        assert.strictEqual(item.data, 'hello');
        assert.strictEqual(item.expiresAt, futureExpiry);
        const entries = await api.ttlTableQuery({ where: { pk: { equals: pk } } });
        assert.strictEqual(entries.length, 1);
        assert.strictEqual(entries[0].expiresAt, futureExpiry);
        assert.strictEqual(entries[0].value.expiresAt, futureExpiry);
      });

      test('an item whose ttl field has passed is hidden from every read', async () => {
        const api = getApi(); const pk = uid();
        await api.ttlTablePut({ pk, sk: 'dead' }, { data: 'gone', expiresAt: 1 });
        assert.strictEqual(await api.ttlTableGet({ pk, sk: 'dead' }), null);
        assert.deepStrictEqual(await api.ttlTableQuery({ where: { pk: { equals: pk } } }), []);
      });
    });

  });
}
