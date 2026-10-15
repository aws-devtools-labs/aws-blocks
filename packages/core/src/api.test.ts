// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { test } from 'node:test';
import assert from 'node:assert';
import { ApiNamespace, API_NAMESPACE_MARKER, API_NAMESPACE_SCOPE } from './api.js';
import { Scope } from './common/index.js';

const scope = new Scope('test');

test('ApiNamespace stores name via marker symbol', () => {
  const api1 = new ApiNamespace(scope, 'myapi', (ctx) => ({
    test: () => 'hello'
  }));
  
  assert.strictEqual((api1 as any)[API_NAMESPACE_MARKER], 'myapi');
});

test('Different ApiNamespace names should not collide', () => {
  const api1 = new ApiNamespace(scope, 'api1', (ctx) => ({ test: () => 'a' }));
  const api2 = new ApiNamespace(scope, 'api2', (ctx) => ({ test: () => 'b' }));
  
  assert.strictEqual((api1 as any)[API_NAMESPACE_MARKER], 'api1');
  assert.strictEqual((api2 as any)[API_NAMESPACE_MARKER], 'api2');
});

// ApiNamespace keeps the scope it was built in, so the shared gateway can
// resolve the namespace's compute at synth — after the backend module is
// imported — rather than at construction.
test('ApiNamespace keeps its scope for synth-time routing', () => {
  const scopeLike = { id: 'app' };
  const handler = new ApiNamespace(scopeLike as never, 'myapi', () => ({ ping: () => 'ok' }));
  assert.strictEqual((handler as any)[API_NAMESPACE_SCOPE], scopeLike);
});

test('ApiNamespace does not resolve the compute at construction', () => {
  // Reading `scope.compute` here would freeze routing at construction time and
  // throw before create() has built the default compute.
  const scopeLike = {
    id: 'app',
    get compute(): never {
      throw new Error('compute read at construction');
    },
  };
  assert.doesNotThrow(() => new ApiNamespace(scopeLike as never, 'late', () => ({ ping: () => 'ok' })));
});

test('ApiNamespace is still tagged and returned unchanged in the mock/runtime Scope', () => {
  const handler = new ApiNamespace(new Scope('no-compute'), 'plainapi', () => ({ x: () => 1 }));
  assert.strictEqual((handler as any)[API_NAMESPACE_MARKER], 'plainapi');
  // Symbol keys stay invisible to export scanning and serialization.
  assert.deepStrictEqual(Object.keys(handler), []);
});
