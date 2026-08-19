// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { test } from 'node:test';
import assert from 'node:assert';
import { ApiNamespace, API_NAMESPACE_MARKER } from './api.js';
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

// ApiNamespace records its name on the scope's resolved compute (CDK
// synth), while staying a silent no-op where no compute is resolvable.
test('ApiNamespace records its name on a resolvable compute', () => {
  const compute = { namespaces: [] as string[] };
  new ApiNamespace({ id: 'app', compute } as never, 'myapi', () => ({ ping: () => 'ok' }));
  assert.deepStrictEqual(compute.namespaces, ['myapi']);
});

test('ApiNamespace is a no-op recorder when the scope has no compute', () => {
  // The common Scope (mock/runtime) has no `compute`; recording must not throw
  // and the handler is still tagged and returned unchanged.
  const handler = new ApiNamespace(new Scope('no-compute'), 'plainapi', () => ({ x: () => 1 }));
  assert.strictEqual((handler as any)[API_NAMESPACE_MARKER], 'plainapi');
});
