// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { before, describe, test } from 'node:test';
import assert from 'node:assert';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isBlocksError } from '@aws-cdk-blocks/core';
import type { api as apiType } from 'cdk-blocks';

// Error name constants — match KVStoreErrors.*. Written as strings here
// because the test runs under the `browser` condition where bb-kv-store only
// exports a stub and the constants.
const ValidationFailed = 'ValidationFailedException';
const InvalidQuery = 'InvalidQueryException';
const ConditionalCheckFailed = 'ConditionalCheckFailedException';

const LOCAL = (process.env.BLOCKS_TEST_ENV || 'local') === 'local';
const FAR = 4102444800;
const PAST = 1000000000;
const ADA = { name: 'Ada', age: 36, tags: ['first'] };
const GRACE = { name: 'Grace', age: 45, tags: [] };
const GONE = { name: 'Gone', age: 1, tags: [] };

/**
 * Write the mock data file of the app's `legacy-store`, in the format of a
 * KVStore release up to 0.4.0: key to JSON text, or key to `{ value, ttl }`.
 * Call it before the dev server starts. It replaces the file of an earlier run.
 */
export function seedLegacyStore(): void {
  const dir = join(process.cwd(), '.cdk-blocks/local/data', 'test-app-legacy-store');
  mkdirSync(dir, { recursive: true });
  const file = {
    ada: JSON.stringify(ADA),
    grace: { value: JSON.stringify(GRACE), ttl: FAR },
    gone: { value: JSON.stringify(GONE), ttl: PAST },
  };
  writeFileSync(join(dir, 'store.json'), JSON.stringify(file, null, 2));
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

/**
 * `LegacyKVStore`: the store of a KVStore release up to 0.4.0.
 *
 * The store holds three items of such a release: one with no expiry, one that
 * expires in 2100, and one that expired in 2001. Locally they are in the data
 * file that `seedLegacyStore` writes before the dev server starts. On AWS the
 * suite writes them with `put`.
 */
export function legacyKvStoreTests(getApi: () => typeof apiType) {

  describe('LegacyKVStore', () => {

    before(async () => {
      if (LOCAL) return;
      await getApi().legacySeed([
        { key: 'ada', value: ADA },
        { key: 'grace', value: GRACE, ttl: FAR },
        { key: 'gone', value: GONE, ttl: PAST },
      ]);
    });

    test('reads the values that the release wrote, and hides an expired one', async () => {
      const api = getApi();
      assert.deepStrictEqual(await api.legacyGet('ada'), ADA);
      assert.deepStrictEqual(await api.legacyGet('grace'), GRACE);
      assert.strictEqual(await api.legacyGet('gone'), null);
    });

    test('a key that the old store does not hold reads as null', async () => {
      const api = getApi();
      assert.strictEqual(await api.legacyGet(`legacy-${Date.now().toString(36)}`), null);
    });

    test('scans a page at a time, with the expiry of each entry', async () => {
      const api = getApi();
      const entries: Awaited<ReturnType<typeof api.legacyScanPage>>['entries'] = [];
      let cursor: string | undefined;
      let pages = 0;
      do {
        const page = await api.legacyScanPage(1, cursor);
        entries.push(...page.entries);
        cursor = page.cursor;
        pages++;
      } while (cursor && pages < 10);
      // DynamoDB returns the items in its own order. Compare them in key order.
      entries.sort((a, b) => (a.key < b.key ? -1 : 1));
      assert.deepStrictEqual(entries, [
        { key: 'ada', value: ADA },
        { key: 'grace', value: GRACE, expiresAt: FAR },
      ]);
      assert.ok(pages >= 2, `one entry for each page: ${pages} pages`);
    });

    test('an empty key is rejected, as on a KVStore', async () => {
      const api = getApi();
      await expectError(api.legacyGet(''), ValidationFailed);
      await expectError(api.legacyDelete(''), ValidationFailed);
    });

    test('a limit that is not a positive integer is rejected', async () => {
      const api = getApi();
      await expectError(api.legacyScanPage(0), InvalidQuery);
    });

    test('a delete removes the key from the old store; a key that it does not hold is not an error', async () => {
      const api = getApi();
      await api.legacyDelete('grace');
      assert.strictEqual(await api.legacyGet('grace'), null);
      assert.deepStrictEqual(await api.legacyGet('ada'), ADA);
      assert.deepStrictEqual(await api.legacyDelete(`legacy-${Date.now().toString(36)}`), { success: true });
    });

    test('a put writes a value that a get reads back; ifNotExists does not replace it; a delete with ifExists needs the key', async () => {
      const api = getApi();
      const key = `legacy-put-${Date.now().toString(36)}`;
      await api.legacyPut(key, ADA, { ifNotExists: true, ttlSeconds: 3600 });
      assert.deepStrictEqual(await api.legacyGet(key), ADA);
      await expectError(api.legacyPut(key, GRACE, { ifNotExists: true }), ConditionalCheckFailed);
      assert.deepStrictEqual(await api.legacyGet(key), ADA);
      await api.legacyPut(key, GRACE);
      assert.deepStrictEqual(await api.legacyGet(key), GRACE);
      await api.legacyDelete(key, { ifExists: true });
      assert.strictEqual(await api.legacyGet(key), null);
      await expectError(api.legacyDelete(key, { ifExists: true }), ConditionalCheckFailed);
    });
  });
}
