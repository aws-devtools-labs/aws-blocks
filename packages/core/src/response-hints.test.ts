// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addResponseHint, runWithResponseHints } from './response-hints.js';
import { MAX_RESPONSE_HINTS_BYTES, decodeResponseHints } from './response-hints-codec.js';

test('hints added during an API call come back in the header, by name', async () => {
  const { result, header } = await runWithResponseHints(async () => {
    addResponseHint('data/sync', { path: '/a', keys: ['x'] });
    await new Promise((resolve) => setTimeout(resolve, 1)); // survives awaits
    addResponseHint('data/sync', { path: '/b' });
    addResponseHint('other', 1);
    return 42;
  });
  assert.equal(result, 42);
  assert.deepEqual(decodeResponseHints(header), {
    values: { 'data/sync': [{ path: '/a', keys: ['x'] }, { path: '/b' }], other: [1] },
    overflow: [],
  });
});

test('no hints: no header; outside an API call: addResponseHint is a no-op', async () => {
  assert.equal(addResponseHint('x', 1), false);
  const { header } = await runWithResponseHints(async () => 'ok');
  assert.equal(header, null);
});

test('concurrent calls keep their hints apart', async () => {
  const [a, b] = await Promise.all(
    ['a', 'b'].map((name) =>
      runWithResponseHints(async () => {
        await new Promise((resolve) => setTimeout(resolve, name === 'a' ? 5 : 1));
        addResponseHint('n', name);
      }),
    ),
  );
  assert.deepEqual(decodeResponseHints(a.header).values, { n: ['a'] });
  assert.deepEqual(decodeResponseHints(b.header).values, { n: ['b'] });
});

test('oversized hints become an overflow marker; malformed headers decode to nothing', async () => {
  const { header } = await runWithResponseHints(async () => {
    addResponseHint('big', 'x'.repeat(MAX_RESPONSE_HINTS_BYTES));
  });
  assert.ok(header && header.length <= MAX_RESPONSE_HINTS_BYTES);
  assert.deepEqual(decodeResponseHints(header), { values: {}, overflow: ['big'] });
  assert.deepEqual(decodeResponseHints('%%%'), { values: {}, overflow: [] });
  assert.deepEqual(decodeResponseHints(null), { values: {}, overflow: [] });
});
