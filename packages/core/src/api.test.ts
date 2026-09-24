// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { test } from 'node:test';
import assert from 'node:assert';
import { ApiNamespace, API_NAMESPACE_MARKER } from './api.js';
import { Scope } from './common/index.js';
import { BLOCKS_RPC_PREFIX } from './constants.js';
import { clearRouteRegistry, getRegisteredRoutes } from './raw-route.js';

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

// ApiNamespace registers a routing-only entry (endpoint-carrying, handler-less)
// so the front door can fan `/aws-blocks/api/{name}` out to the compute that
// serves it — but only where the scope resolves a compute (CDK synth). It stays
// a silent no-op where no compute is resolvable (mock/runtime).
test('ApiNamespace registers a routing entry carrying the compute endpoint', () => {
  clearRouteRegistry();
  const compute = { endpoint: 'https://api.example.com/prod' };
  new ApiNamespace({ id: 'app', compute } as never, 'myapi', () => ({ ping: () => 'ok' }));
  const entry = getRegisteredRoutes().find((r) => r.path === `${BLOCKS_RPC_PREFIX}/myapi`);
  assert.ok(entry, 'a routing entry is registered for the namespace');
  // Routing-only: no handler (matchRoute skips it, so it never dispatches).
  assert.strictEqual(entry.handler, undefined);
  assert.strictEqual(entry.endpoint, 'https://api.example.com/prod');
  assert.strictEqual(entry.subtree, true);
});

test('ApiNamespace registers no routing entry when the scope has no compute', () => {
  clearRouteRegistry();
  // The common Scope (mock/runtime) has no `compute`; registration must not throw
  // and the handler is still tagged and returned unchanged.
  const handler = new ApiNamespace(new Scope('no-compute'), 'plainapi', () => ({ x: () => 1 }));
  assert.strictEqual((handler as any)[API_NAMESPACE_MARKER], 'plainapi');
  assert.strictEqual(getRegisteredRoutes().length, 0);
});

test('ApiNamespace registers a namespace routing entry at most once', () => {
  clearRouteRegistry();
  // Recording the same namespace twice (e.g. a re-imported module during synth)
  // must not append a duplicate routing entry.
  const compute = { endpoint: 'https://api.example.com/prod' };
  const scopeLike = { id: 'app', compute } as never;
  new ApiNamespace(scopeLike, 'dup', () => ({ ping: () => 'ok' }));
  new ApiNamespace(scopeLike, 'dup', () => ({ ping: () => 'ok' }));
  const dupEntries = getRegisteredRoutes().filter((r) => r.path === `${BLOCKS_RPC_PREFIX}/dup`);
  assert.strictEqual(dupEntries.length, 1);
});

test('ApiNamespace rejects a name that is not URL-path-safe', () => {
  clearRouteRegistry();
  // The name becomes the `/aws-blocks/api/<name>` path segment (client URL AND the
  // CloudFront behavior pattern), so a path-unsafe character must fail at definition
  // time rather than silently diverge the two. Validation runs before the
  // scope/compute check, so it fires in every bundle, not just at synth.
  assert.throws(() => new ApiNamespace(scope, 'my.api', () => ({ x: () => 1 })), /is not URL-path-safe/);
  assert.throws(() => new ApiNamespace(scope, 'a/b', () => ({ x: () => 1 })), /is not URL-path-safe/);
  assert.strictEqual(getRegisteredRoutes().length, 0, 'a rejected name registers nothing');
});

test('ApiNamespace accepts names with hyphens and underscores', () => {
  // `-` and `_` are the only non-alphanumeric characters the guard allows; both are
  // valid URL path-segment characters.
  assert.doesNotThrow(() => new ApiNamespace(new Scope('safe'), 'my-api_v2', () => ({ x: () => 1 })));
});
