// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parseRpcRequest, errorResponseFromCatch, RpcErrorCode } from './rpc.js';
import { ApiError } from './errors.js';

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

describe('errorResponseFromCatch does not leak backend internals', () => {
  it('collapses a non-ApiError (driver exception) to a generic 500', () => {
    // Simulate a Postgres/DynamoDB driver throw: custom class name + raw message.
    class PostgresError extends Error {
      constructor(message: string) {
        super(message);
        this.name = 'PostgresError';
      }
    }
    const raw = new PostgresError('duplicate key value violates unique constraint "users_email_key"');

    const parsed = JSON.parse(errorResponseFromCatch(raw, 1));
    assert.strictEqual(parsed.error.code, 500);
    assert.strictEqual(parsed.error.message, 'Internal error');
    // The raw class name and message must never reach the client.
    assert.strictEqual(parsed.error.data, undefined);
    assert.ok(!JSON.stringify(parsed).includes('PostgresError'));
    assert.ok(!JSON.stringify(parsed).includes('users_email_key'));
    assert.strictEqual(parsed.id, 1);
  });

  it('collapses a plain Error to a generic 500 with no name', () => {
    const parsed = JSON.parse(errorResponseFromCatch(new Error('boom: /var/task internal path'), 2));
    assert.strictEqual(parsed.error.code, 500);
    assert.strictEqual(parsed.error.message, 'Internal error');
    assert.strictEqual(parsed.error.data, undefined);
  });

  it('collapses a non-Error throw (string) to a generic 500', () => {
    const parsed = JSON.parse(errorResponseFromCatch('raw string failure', 3));
    assert.strictEqual(parsed.error.code, 500);
    assert.strictEqual(parsed.error.message, 'Internal error');
    assert.strictEqual(parsed.error.data, undefined);
  });

  it('passes an ApiError through verbatim with its status, message, and BB name', () => {
    const err = new ApiError('Username already taken', 409, { name: 'ConditionalCheckFailedException' });
    const parsed = JSON.parse(errorResponseFromCatch(err, 4));
    assert.strictEqual(parsed.error.code, 409);
    assert.strictEqual(parsed.error.message, 'Username already taken');
    assert.strictEqual(parsed.error.data.name, 'ConditionalCheckFailedException');
    assert.strictEqual(parsed.id, 4);
  });

  it('propagates the retriable flag on an ApiError', () => {
    const err = new ApiError('Wrong MFA code', 401, { name: 'InvalidMfaCode', retriable: true });
    const parsed = JSON.parse(errorResponseFromCatch(err, 5));
    assert.strictEqual(parsed.error.code, 401);
    assert.strictEqual(parsed.error.data.name, 'InvalidMfaCode');
    assert.strictEqual(parsed.error.data.retriable, true);
  });

  it('omits data.name for an ApiError left at the default name', () => {
    const err = new ApiError('Something went wrong', 500);
    const parsed = JSON.parse(errorResponseFromCatch(err, 6));
    assert.strictEqual(parsed.error.code, 500);
    assert.strictEqual(parsed.error.message, 'Something went wrong');
    assert.strictEqual(parsed.error.data, undefined);
  });
});
