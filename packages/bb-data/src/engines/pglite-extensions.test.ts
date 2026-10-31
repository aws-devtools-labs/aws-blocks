// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { installCommandFor, resolveExtensions } from './pglite-extensions.js';

// dist/engines/*.test.js -> package root
const pkgRoot = new URL('../../', import.meta.url);
const pkgJson = JSON.parse(readFileSync(new URL('package.json', pkgRoot), 'utf8')) as {
  peerDependencies: Record<string, string>;
};
const readme = readFileSync(new URL('README.md', pkgRoot), 'utf8');

test('install commands are pinned to the exact peerDependencies versions', () => {
  for (const [name, pkg] of [
    ['postgis', '@electric-sql/pglite-postgis'],
    ['pgvector', '@electric-sql/pglite-pgvector'],
    ['vector', '@electric-sql/pglite-pgvector'],
  ] as const) {
    const peer = pkgJson.peerDependencies[pkg];
    assert.ok(peer, `expected ${pkg} in peerDependencies`);
    const cmd = `npm install ${pkg}@${peer}`;
    assert.strictEqual(installCommandFor(name), cmd);
    // README advertises the same pinned command, so docs and error cannot drift.
    assert.ok(readme.includes(cmd), `README should contain \`${cmd}\``);
  }
  assert.strictEqual(installCommandFor('nosuchext'), null);
});

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
