// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Wire shape of a successful JSON-RPC response from the shared dispatcher, which
 * the dev server, the Lambda handler and the container server all use.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { ApiNamespace } from './api.js';
import { createDispatcher, type DispatchRequest } from './dispatch.js';

const scope = { id: 'app' };

const backend = {
  api: new ApiNamespace(scope, 'api', () => ({
    async nothing(): Promise<void> {},
    async explicitUndefined(): Promise<undefined> {
      return undefined;
    },
    async nullValue(): Promise<null> {
      return null;
    },
    async maybe(): Promise<string | undefined> {
      return undefined;
    },
    async zero(): Promise<number> {
      return 0;
    },
    async no(): Promise<boolean> {
      return false;
    },
    async empty(): Promise<string> {
      return '';
    },
    async value(): Promise<string> {
      return 'hi';
    },
  })),
};

function rpcRequest(method: string): DispatchRequest {
  const text = JSON.stringify({ jsonrpc: '2.0', method, params: [], id: 1 });
  return {
    method: 'POST',
    path: '/cdk-blocks/api',
    origin: '',
    cookie: '',
    clientUserAgent: undefined,
    headers: () => new Headers({ 'content-type': 'application/json' }),
    url: () => new URL('http://localhost/cdk-blocks/api'),
    baseUrl: () => 'http://localhost',
    body: () => ({ text, stream: null }),
  };
}

describe('createDispatcher: result field', () => {
  const dispatch = createDispatcher(backend);

  for (const method of ['nothing', 'explicitUndefined', 'maybe']) {
    it(`sends "result": null for a method that returns undefined (${method})`, async () => {
      const response = await dispatch(rpcRequest(`api.${method}`));
      assert.strictEqual(response.kind, 'rpc-result');
      assert.deepStrictEqual(JSON.parse(response.body), { jsonrpc: '2.0', result: null, id: 1 });
    });
  }

  it('sends "result": null for a method that returns null', async () => {
    const response = await dispatch(rpcRequest('api.nullValue'));
    assert.deepStrictEqual(JSON.parse(response.body), { jsonrpc: '2.0', result: null, id: 1 });
  });

  it('sends the value a method returns', async () => {
    const response = await dispatch(rpcRequest('api.value'));
    assert.deepStrictEqual(JSON.parse(response.body), { jsonrpc: '2.0', result: 'hi', id: 1 });
  });

  for (const [method, value] of [['zero', 0], ['no', false], ['empty', '']] as const) {
    it(`keeps a falsy result: ${JSON.stringify(value)} (${method})`, async () => {
      const response = await dispatch(rpcRequest(`api.${method}`));
      assert.deepStrictEqual(JSON.parse(response.body), { jsonrpc: '2.0', result: value, id: 1 });
    });
  }
});
