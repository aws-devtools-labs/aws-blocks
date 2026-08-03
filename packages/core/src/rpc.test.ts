// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { decodeRpcResponse, errorResponseFromCatch, parseRpcRequest, RpcErrorCode } from './rpc.js';
import { ApiError, isBlocksError } from './errors.js';

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

describe('params decoding', () => {
  it('uses an array of params as positional args', () => {
    const result = parseRpcRequest(JSON.stringify({ jsonrpc: '2.0', method: 'api.greet', params: ['World', 42], id: 1 }));
    assert.strictEqual(result.ok, true);
    if (result.ok) {
      assert.deepStrictEqual(result.request.args, ['World', 42]);
      assert.strictEqual(result.request.apiNamespace, 'api');
      assert.strictEqual(result.request.method, 'greet');
    }
  });

  it('flattens an object of named params in key order', () => {
    const result = parseRpcRequest(JSON.stringify({ jsonrpc: '2.0', method: 'api.greet', params: { name: 'World', times: 42 }, id: 1 }));
    assert.strictEqual(result.ok, true);
    if (result.ok) assert.deepStrictEqual(result.request.args, ['World', 42]);
  });

  it('yields no args when params is omitted', () => {
    const result = parseRpcRequest(JSON.stringify({ jsonrpc: '2.0', method: 'api.ping', id: 7 }));
    assert.strictEqual(result.ok, true);
    if (result.ok) assert.deepStrictEqual(result.request.args, []);
  });
});

describe('batch requests (top-level JSON array body)', () => {
  it('rejects an array body as Invalid Request with a null id', () => {
    const result = parseRpcRequest(JSON.stringify([
      { jsonrpc: '2.0', method: 'api.greet', params: ['a'], id: 1 },
      { jsonrpc: '2.0', method: 'api.greet', params: ['b'], id: 2 },
    ]));
    assert.strictEqual(result.ok, false);
    if (!result.ok) {
      const parsed = JSON.parse(result.response);
      assert.strictEqual(parsed.error.code, RpcErrorCode.InvalidRequest);
      assert.strictEqual(parsed.error.data.name, 'InvalidRequest');
      assert.strictEqual(parsed.id, null);
    }
  });

  it('reports a parse error for a body that is not JSON at all', () => {
    const result = parseRpcRequest('{oops');
    assert.strictEqual(result.ok, false);
    if (!result.ok) {
      const parsed = JSON.parse(result.response);
      assert.strictEqual(parsed.error.code, RpcErrorCode.ParseError);
      assert.strictEqual(parsed.id, null);
    }
  });
});

describe('ApiError status ↔ JSON-RPC error code', () => {
  it('encodes the HTTP status as the error code, with name and retriable in data', () => {
    const encoded = errorResponseFromCatch(
      new ApiError('Username already taken', 409, { name: 'ConditionalCheckFailedException', retriable: true }),
      1,
    );
    const parsed = JSON.parse(encoded);
    assert.strictEqual(parsed.error.code, 409);
    assert.strictEqual(parsed.error.message, 'Username already taken');
    assert.strictEqual(parsed.error.data.name, 'ConditionalCheckFailedException');
    assert.strictEqual(parsed.error.data.retriable, true);
  });

  it('encodes a non-ApiError throw as code 500 with no data.name', () => {
    const parsed = JSON.parse(errorResponseFromCatch(new Error('plain'), 2));
    assert.strictEqual(parsed.error.code, 500);
    assert.strictEqual(parsed.error.data, undefined);
  });

  it('round-trips status, name and retriable back into an ApiError on the client', () => {
    const wire = JSON.parse(errorResponseFromCatch(
      new ApiError('Username already taken', 409, { name: 'ConditionalCheckFailedException', retriable: true }),
      1,
    ));
    assert.throws(
      () => decodeRpcResponse(wire),
      (e: unknown) => {
        assert.ok(e instanceof ApiError);
        assert.strictEqual(e.status, 409);
        assert.strictEqual(e.retriable, true);
        assert.ok(isBlocksError(e, 'ConditionalCheckFailedException'));
        return true;
      },
    );
  });

  it('decodes reserved -32xxx codes as status 500', () => {
    assert.throws(
      () => decodeRpcResponse({ jsonrpc: '2.0', error: { code: RpcErrorCode.InvalidRequest, message: 'Invalid Request' }, id: null }),
      (e: unknown) => e instanceof ApiError && e.status === 500,
    );
  });
});
