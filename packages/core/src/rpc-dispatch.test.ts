// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for the shared RPC dispatch guards. The Lambda handler is exercised
 * end-to-end in lambda-handler.test.ts; these pin the helper the dev server uses
 * too, so both dispatchers enforce the same rules.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { secret, config, isManagedValue as hostingIsManagedValue } from '@aws-blocks/hosting';
import { ApiNamespace } from './api.js';
import { isApiNamespace, isDispatchableExport, isScopeLike, resolveApiNamespace, resolveApiMethod } from './rpc-dispatch.js';

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

  it('rejects secret()/config() managed values — parity with generate-client', () => {
    // generate-client skips these (isManagedValue) before emitting a proxy, so the
    // dispatcher must not treat them as namespaces either. Uses hosting's REAL
    // markers, so a change to hosting's brand breaks this test rather than silently
    // drifting from the brand re-derived in rpc-dispatch.ts.
    const apiKey = secret('API_KEY');
    const domain = config('DOMAIN');
    assert.ok(hostingIsManagedValue(apiKey) && hostingIsManagedValue(domain), 'fixtures are real managed values');
    assert.strictEqual(isDispatchableExport('apiKey', apiKey), false);
    assert.strictEqual(isDispatchableExport('domain', domain), false);
    assert.strictEqual(resolveApiNamespace({ apiKey }, 'apiKey'), undefined);
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

  it('rejects a non-enumerable own property (hidden with defineProperty)', () => {
    const methods = { async visible() { return 'ok'; } };
    Object.defineProperty(methods, 'hidden', { value: async () => 'hidden', enumerable: false });
    assert.strictEqual(resolveApiMethod(methods, 'hidden'), undefined);
    assert.ok(resolveApiMethod(methods, 'visible'));
  });

  it('exposes no method of a Building Block instance a handler returns', () => {
    class Block { readonly id = 'notes'; readonly fullId = 'app-notes'; async get() { return 'stored'; } }
    assert.strictEqual(resolveApiMethod(new Block(), 'get'), undefined);
  });
});

describe('isApiNamespace / isScopeLike (shared with generate-client)', () => {
  it('recognises an ApiNamespace by its marker, not by shape', () => {
    assert.strictEqual(isApiNamespace(new ApiNamespace(scope, 'api', () => ({}))), true);
    assert.strictEqual(isApiNamespace(() => ({})), false);
    assert.strictEqual(isApiNamespace(null), false);
  });

  it('treats an object with string id and fullId as a Building Block', () => {
    assert.strictEqual(isScopeLike({ id: 'todos', fullId: 'app-todos' }), true);
    assert.strictEqual(isScopeLike({ id: 'todos' }), false);
    assert.strictEqual(isScopeLike('todos'), false);
  });
});
