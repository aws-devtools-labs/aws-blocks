// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { test } from 'node:test';
import assert from 'node:assert';
import { resolveExtensions } from './pglite-extensions.js';

test('resolveExtensions returns empty object for undefined', async () => {
  assert.deepStrictEqual(await resolveExtensions(undefined), {});
});

test('resolveExtensions returns empty object for empty list', async () => {
  assert.deepStrictEqual(await resolveExtensions([]), {});
});

test('resolveExtensions resolves pgvector under the vector namespace', async () => {
  const resolved = await resolveExtensions(['pgvector']);
  assert.ok('vector' in resolved, 'expected a `vector` namespace');
  assert.ok(resolved.vector, 'expected the vector extension to be defined');
});

test('resolveExtensions accepts the `vector` alias', async () => {
  const resolved = await resolveExtensions(['vector']);
  assert.ok('vector' in resolved);
});

test('resolveExtensions resolves postgis under the postgis namespace', async () => {
  const resolved = await resolveExtensions(['postgis']);
  assert.ok('postgis' in resolved, 'expected a `postgis` namespace');
  assert.ok(resolved.postgis);
});

test('resolveExtensions resolves multiple extensions', async () => {
  const resolved = await resolveExtensions(['postgis', 'pgvector']);
  assert.ok('postgis' in resolved);
  assert.ok('vector' in resolved);
});

test('resolveExtensions is case-insensitive and trims', async () => {
  const resolved = await resolveExtensions(['  PostGIS  ']);
  assert.ok('postgis' in resolved);
});

test('resolveExtensions throws an actionable error for an unknown name', async () => {
  await assert.rejects(
    () => resolveExtensions(['nosuchext']),
    (err: Error) => {
      assert.match(err.message, /Unknown Database extension 'nosuchext'/);
      assert.match(err.message, /Supported extensions:/);
      // lists the supported names so the developer can self-correct
      assert.match(err.message, /postgis/);
      return true;
    },
  );
});
