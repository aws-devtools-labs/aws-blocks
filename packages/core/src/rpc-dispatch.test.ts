// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for the shared RPC dispatch guards. The Lambda handler is exercised
 * end-to-end in lambda-handler.test.ts; these pin the helper the dev server uses
 * too, so both dispatchers enforce the same rules.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { ApiNamespace } from './api.js';
import { isDispatchableExport, resolveApiNamespace, resolveApiMethod } from './rpc-dispatch.js';

const scope = { id: 'app' };

describe('isDispatchableExport', () => {
  it('allows an ApiNamespace and a plain exported function/object (backward compatible)', () => {
    const api = new ApiNamespace(scope, 'api', () => ({ async ping() { return 'pong'; } }));
    assert.strictEqual(isDispatchableExport('api', api), true);
    assert.strictEqual(isDispatchableExport('legacy', () => ({})), true);
    assert.strictEqual(isDispatchableExport('obj', { async m() { return 1; } }), true);
  });

  it('rejects a Building Block (Scope) instance', () => {
    assert.strictEqual(isDispatchableExport('todos', { id: 'todos', fullId: 'app-todos', put() {} }), false);
  });

  it('rejects `_`-private exports and primitives', () => {
    assert.strictEqual(isDispatchableExport('_cleanup', () => {}), false);
    assert.strictEqual(isDispatchableExport('version', '1.0.0'), false);
    assert.strictEqual(isDispatchableExport('nothing', null), false);
  });
});

describe('resolveApiNamespace', () => {
  it('uses an own-property lookup only', () => {
    const backend = Object.create({ inherited: () => ({}) });
    assert.strictEqual(resolveApiNamespace(backend, 'inherited'), undefined);
    assert.strictEqual(resolveApiNamespace({}, 'toString'), undefined);
  });

  it('works on a null-prototype module namespace object', () => {
    const mod = Object.assign(Object.create(null), { api: () => ({}) });
    assert.strictEqual(typeof resolveApiNamespace(mod, 'api'), 'function');
  });
});

describe('resolveApiMethod', () => {
  it('returns an own callable method, bound to its method map', async () => {
    const methods = { greeting: 'hi', async hello() { return this.greeting; } };
    const fn = resolveApiMethod(methods, 'hello');
    assert.ok(fn);
    assert.strictEqual(await fn(), 'hi');
  });

  it('keeps a class-prototype method reachable (existing class-shaped APIs)', async () => {
    class Methods { async ping() { return 'pong'; } }
    const fn = resolveApiMethod(new Methods(), 'ping');
    assert.ok(fn);
    assert.strictEqual(await fn(), 'pong');
  });

  for (const name of ['toString', 'hasOwnProperty', 'valueOf', 'isPrototypeOf', 'constructor', '__proto__']) {
    it(`never resolves the Object.prototype member "${name}"`, () => {
      assert.strictEqual(resolveApiMethod({ async real() { return 1; } }, name), undefined);
    });
  }

  it('rejects a non-function property', () => {
    assert.strictEqual(resolveApiMethod({ config: { key: 'x' } }, 'config'), undefined);
  });
});
