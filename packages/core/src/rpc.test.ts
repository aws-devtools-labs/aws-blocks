// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { decodeRpcResponse, errorResponseFromCatch, parseRpcRequest, RpcErrorCode, MAX_RPC_BODY_BYTES } from './rpc.js';
import { ApiError, isBlocksError, blocksError, brandBlocksError } from './errors.js';

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

  it('forwards the BB name AND message of a blocksError() throw (D-003)', () => {
    // A Building Block error (thrown via blocksError) is a plain named Error, not
    // an ApiError. Both its BB name AND its BB-authored message cross the wire so
    // isBlocksError() keeps matching on the client and the caller sees the real,
    // actionable message. The invariant this relies on: a branded message never
    // embeds raw driver/SDK text (see brandBlocksError).
    const raw = blocksError('BatchSubmitFailedException', 'Batch contains 150 payloads, exceeds the 100 limit');
    const parsed = JSON.parse(errorResponseFromCatch(raw, 7));
    assert.strictEqual(parsed.error.code, 500);
    assert.strictEqual(parsed.error.message, 'BatchSubmitFailedException: Batch contains 150 payloads, exceeds the 100 limit');
    assert.strictEqual(parsed.error.data.name, 'BatchSubmitFailedException');
    // Round-trips: the client reconstructs an error isBlocksError() matches, with the message intact.
    assert.throws(
      () => decodeRpcResponse(parsed),
      (e: unknown) => isBlocksError(e, 'BatchSubmitFailedException') && (e as Error).message.includes('exceeds the 100 limit'),
    );
  });

  it('forwards the BB name AND message when a Building Block brands its OWN error via brandBlocksError() (D-003)', () => {
    // Most Building Blocks define a local blocksError() with a package-specific
    // message format, then stamp the wire-safe brand through core's
    // brandBlocksError(). This simulates that path: a fresh named Error built by a
    // BB (here with an UNPREFIXED message, like bb-app-setting / bb-auth-oidc) and
    // branded. Its BB name AND message must cross the wire.
    const bbErr = new Error('Invalid email address');
    bbErr.name = 'InvalidInputException';
    const parsed = JSON.parse(errorResponseFromCatch(brandBlocksError(bbErr), 9));
    assert.strictEqual(parsed.error.code, 500);
    assert.strictEqual(parsed.error.message, 'Invalid email address');
    assert.strictEqual(parsed.error.data.name, 'InvalidInputException');
    // Round-trips: the client reconstructs an error isBlocksError() matches.
    assert.throws(
      () => decodeRpcResponse(parsed),
      (e: unknown) => isBlocksError(e, 'InvalidInputException'),
    );
  });

  it('does not forward the class name of a raw (unbranded) named Error', () => {
    // A driver/SDK exception is a plain Error with a non-generic .name but no
    // blocksError brand — its class name must NOT leak just because it is non-generic.
    class DynamoDBServiceException extends Error {
      constructor(message: string) {
        super(message);
        this.name = 'DynamoDBServiceException';
      }
    }
    const parsed = JSON.parse(errorResponseFromCatch(new DynamoDBServiceException('secret table arn'), 8));
    assert.strictEqual(parsed.error.code, 500);
    assert.strictEqual(parsed.error.message, 'Internal error');
    assert.strictEqual(parsed.error.data, undefined);
    assert.ok(!JSON.stringify(parsed).includes('DynamoDBServiceException'));
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

  it('brand is non-enumerable — it never appears in JSON.stringify or the wire body', () => {
    const err = blocksError('ValidationFailedException', 'bad input');
    const BRAND = Symbol.for('aws-blocks.wireSafeError');
    // Pin the property descriptor directly: Object.keys / JSON.stringify never
    // expose symbol keys regardless of enumerability, so they alone cannot catch
    // a regression that flips the brand to enumerable. The descriptor can.
    assert.strictEqual(Object.getOwnPropertyDescriptor(err, BRAND)?.enumerable, false);
    // A spread copies enumerable symbol keys, so an enumerable brand would leak here.
    assert.strictEqual(Object.getOwnPropertySymbols({ ...err }).length, 0);
    // And the real wire body must never carry the brand symbol or its description.
    const wire = errorResponseFromCatch(err, 1);
    assert.ok(!wire.toLowerCase().includes('wiresafe'));
    assert.ok(!wire.includes('Symbol('));
  });

  it('a branded error still at the default name Error collapses to a nameless 500', () => {
    // Branding alone is not enough: the name must be a real BB constant. A branded
    // error whose name is still the JS default must not put data.name on the wire.
    const err = brandBlocksError(new Error('some branded but unnamed failure'));
    const parsed = JSON.parse(errorResponseFromCatch(err, 1));
    assert.strictEqual(parsed.error.code, 500);
    assert.strictEqual(parsed.error.message, 'Internal error');
    assert.strictEqual(parsed.error.data, undefined);
  });

  it('recognizes a brand stamped through a SEPARATELY bundled copy of core (Symbol.for)', () => {
    // brandBlocksError uses Symbol.for('aws-blocks.wireSafeError') so a brand
    // stamped by another bundled copy of core (a BB compiled with its own core
    // instance) is still recognized by this serializer. Simulate that copy by
    // stamping the same well-known symbol without going through this module's fn.
    const err = new Error('cross-copy branded BB error');
    err.name = 'ConnectionFailedException';
    Object.defineProperty(err, Symbol.for('aws-blocks.wireSafeError'), { value: true, enumerable: false });
    const parsed = JSON.parse(errorResponseFromCatch(err, 1));
    assert.strictEqual(parsed.error.data.name, 'ConnectionFailedException');
    assert.strictEqual(parsed.error.message, 'cross-copy branded BB error');
  });

  it('a re-tagged (already-branded) BB error forwards its name and stable message', () => {
    // The re-tag paths (wrapError / translateDsqlError / translatePgError) brand a
    // fresh Error with a BB name and a stable BB message; the serializer forwards
    // both, and no driver text is present to leak (the raw error is kept as cause,
    // which stays server-side).
    const retagged = brandBlocksError(
      Object.assign(new Error('QueryFailedException: The database query failed'), {
        name: 'QueryFailedException',
        cause: new Error('ERROR: relation "todos" does not exist'),
      }),
    );
    const parsed = JSON.parse(errorResponseFromCatch(retagged, 1));
    assert.strictEqual(parsed.error.data.name, 'QueryFailedException');
    assert.strictEqual(parsed.error.message, 'QueryFailedException: The database query failed');
    // cause is server-side only — never serialized.
    assert.ok(!JSON.stringify(parsed).includes('relation'));
    assert.ok(!JSON.stringify(parsed).includes('cause'));
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

describe('-32602 Invalid Params validation', () => {
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

  it('encodes an ApiError built by a SEPARATELY bundled copy of core with its status, name and retriable intact', () => {
    // Reproduces the real failure: a duplicated `@aws-blocks/core` nests a private
    // copy under a dependency (e.g. bb-distributed-table), so the ApiError thrown
    // there is NOT `instanceof` the ApiError class this serializer imports. A plain
    // `instanceof` check misses it and collapses the deliberate 409 into a nameless
    // 500 (the api-only OCC e2e symptom). Simulate the foreign-copy ApiError with a
    // plain Error that carries the same cross-copy brand + numeric status the
    // ApiError constructor stamps, without being an instance of THIS copy's class.
    const foreign = Object.assign(new Error('Stale write rejected'), {
      name: 'ConditionalCheckFailedException',
      status: 409,
      retriable: true,
    });
    Object.defineProperty(foreign, Symbol.for('aws-blocks.wireSafeError'), { value: true, enumerable: false });
    assert.ok(!(foreign instanceof ApiError)); // precondition: not our class
    const parsed = JSON.parse(errorResponseFromCatch(foreign, 1));
    assert.strictEqual(parsed.error.code, 409);
    assert.strictEqual(parsed.error.message, 'Stale write rejected');
    assert.strictEqual(parsed.error.data.name, 'ConditionalCheckFailedException');
    assert.strictEqual(parsed.error.data.retriable, true);
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

describe('request body size limit', () => {
  it('accepts a normal-sized body', () => {
    const result = parseRpcRequest(JSON.stringify({ jsonrpc: '2.0', method: 'ns.method', params: [], id: 1 }));
    assert.strictEqual(result.ok, true);
  });

  it('rejects a body larger than MAX_RPC_BODY_BYTES with a PayloadTooLarge error', () => {
    // A JSON string just over the limit (a single huge param value).
    const huge = 'x'.repeat(MAX_RPC_BODY_BYTES + 1);
    const body = JSON.stringify({ jsonrpc: '2.0', method: 'ns.method', params: [huge], id: 1 });
    assert.ok(Buffer.byteLength(body, 'utf8') > MAX_RPC_BODY_BYTES);

    const result = parseRpcRequest(body);
    assert.strictEqual(result.ok, false);
    if (result.ok) return; // narrow
    const parsed = JSON.parse(result.response);
    // Positive HTTP status (413), not a reserved -32xxx — so decodeRpcResponse
    // surfaces it to the client as ApiError.status === 413.
    assert.strictEqual(parsed.error.code, 413);
    assert.strictEqual(parsed.error.data?.name, 'PayloadTooLarge');
    assert.match(parsed.error.message, /exceeds/);
    assert.match(parsed.error.message, /10 MiB/); // human-readable size crosses the wire

    // Client round-trip: decodeRpcResponse surfaces it as ApiError.status 413
    // (not 500), so consumer `e.status === 413` handling works.
    assert.throws(
      () => decodeRpcResponse(parsed),
      (e: unknown) => e instanceof ApiError && e.status === 413 && isBlocksError(e, 'PayloadTooLarge'),
    );
  });

  it('rejects an oversized body before attempting to parse it (invalid JSON still 413s, not a ParseError)', () => {
    // Oversized AND not valid JSON — the size guard must win, proving the body
    // is rejected before the (expensive) parse + before any handler/DB touch.
    const oversizedGarbage = 'x'.repeat(MAX_RPC_BODY_BYTES + 1);
    const result = parseRpcRequest(oversizedGarbage);
    assert.strictEqual(result.ok, false);
    if (result.ok) return;
    const parsed = JSON.parse(result.response);
    assert.strictEqual(parsed.error.data?.name, 'PayloadTooLarge');
  });
});
