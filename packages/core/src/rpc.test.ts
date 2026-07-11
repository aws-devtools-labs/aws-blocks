// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parseRpcRequest, RpcErrorCode } from './rpc.js';

describe('-32600 Invalid Request error shape', () => {
  it('returns proper JSON-RPC 2.0 envelope with error code', () => {
    const result = parseRpcRequest(JSON.stringify({ method: 'ns.method', id: 1 }));
    assert.strictEqual(result.ok, false);
    if (!result.ok) {
      const parsed = JSON.parse(result.response);
      assert.strictEqual(parsed.jsonrpc, '2.0');
      assert.strictEqual(parsed.error.code, RpcErrorCode.InvalidRequest);
      assert.strictEqual(parsed.id, 1);
    }
  });

  it('includes descriptive message with expected JSON-RPC 2.0 shape', () => {
    const result = parseRpcRequest(JSON.stringify({ method: 'test', id: 1 }));
    assert.strictEqual(result.ok, false);
    if (!result.ok) {
      const parsed = JSON.parse(result.response);
      assert.ok(
        parsed.error.message.includes('expected JSON-RPC 2.0'),
        `message should describe the expected format, got: ${parsed.error.message}`,
      );
      assert.ok(
        parsed.error.message.includes('"jsonrpc":"2.0"'),
        `message should echo the expected envelope shape`,
      );
    }
  });

  it('includes data.name per D-003 convention', () => {
    const result = parseRpcRequest(JSON.stringify({ method: 'test', id: 1 }));
    assert.strictEqual(result.ok, false);
    if (!result.ok) {
      const parsed = JSON.parse(result.response);
      assert.strictEqual(parsed.error.data.name, 'InvalidRequest');
    }
  });

  it('preserves the caller id in the error response', () => {
    const result = parseRpcRequest(JSON.stringify({ id: 'abc-123' }));
    assert.strictEqual(result.ok, false);
    if (!result.ok) {
      const parsed = JSON.parse(result.response);
      assert.strictEqual(parsed.id, 'abc-123');
    }
  });

  it('uses null id when request omits id', () => {
    const result = parseRpcRequest(JSON.stringify({ jsonrpc: '1.0', method: 123 }));
    assert.strictEqual(result.ok, false);
    if (!result.ok) {
      const parsed = JSON.parse(result.response);
      assert.strictEqual(parsed.id, null);
    }
  });

  it('includes data.name when method lacks namespace dot separator', () => {
    const result = parseRpcRequest(JSON.stringify({ jsonrpc: '2.0', method: 'noNamespace', id: 7 }));
    assert.strictEqual(result.ok, false);
    if (!result.ok) {
      const parsed = JSON.parse(result.response);
      assert.strictEqual(parsed.error.code, RpcErrorCode.InvalidRequest);
      assert.strictEqual(parsed.error.data.name, 'InvalidRequest');
      assert.strictEqual(parsed.id, 7);
    }
  });
});

describe('-32602 Invalid Params validation', () => {
  it('accepts positional array params', () => {
    const result = parseRpcRequest(JSON.stringify({
      jsonrpc: '2.0',
      method: 'api.echo',
      params: ['hello', 42],
      id: 1,
    }));

    assert.strictEqual(result.ok, true);
    if (result.ok) {
      assert.deepStrictEqual(result.request.args, ['hello', 42]);
    }
  });

  it('accepts named object params', () => {
    const result = parseRpcRequest(JSON.stringify({
      jsonrpc: '2.0',
      method: 'api.echo',
      params: { message: 'hello', count: 42 },
      id: 2,
    }));

    assert.strictEqual(result.ok, true);
    if (result.ok) {
      assert.deepStrictEqual(result.request.args, ['hello', 42]);
    }
  });

  it('treats omitted params as no arguments', () => {
    const result = parseRpcRequest(JSON.stringify({
      jsonrpc: '2.0',
      method: 'api.ping',
      id: 3,
    }));

    assert.strictEqual(result.ok, true);
    if (result.ok) {
      assert.deepStrictEqual(result.request.args, []);
    }
  });

  for (const params of ['abc', 42, true, false, null]) {
    it(`rejects ${JSON.stringify(params)} params`, () => {
      const result = parseRpcRequest(JSON.stringify({
        jsonrpc: '2.0',
        method: 'api.echo',
        params,
        id: 'request-1',
      }));

      assert.strictEqual(result.ok, false);
      if (!result.ok) {
        const response = JSON.parse(result.response);
        assert.strictEqual(response.error.code, RpcErrorCode.InvalidParams);
        assert.strictEqual(response.error.data.name, 'InvalidParams');
        assert.ok(response.error.message.includes('expected an array or object'));
        assert.strictEqual(response.id, 'request-1');
      }
    });
  }
});
