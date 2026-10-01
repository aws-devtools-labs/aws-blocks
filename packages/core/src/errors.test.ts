// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { ApiError, DEFAULT_API_ERROR_NAME, isBlocksError, hasAuthError, isApiErrorLike, BLOCKS_ERROR_BRAND } from './errors.js';

describe('ApiError constructor', () => {
  it('exposes message and status, and stays a real Error', () => {
    const e = new ApiError('Not found', 404);
    assert.ok(e instanceof Error);
    assert.strictEqual(e.message, 'Not found');
    assert.strictEqual(e.status, 404);
  });

  it('defaults name to ApiError and retriable to false', () => {
    const e = new ApiError('boom', 500);
    assert.strictEqual(e.name, DEFAULT_API_ERROR_NAME);
    assert.strictEqual(e.retriable, false);
  });

  it('takes name, cause and retriable from the options argument', () => {
    const cause = new Error('root');
    const e = new ApiError('Username already taken', 409, {
      name: 'ConditionalCheckFailedException',
      cause,
      retriable: true,
    });
    assert.strictEqual(e.name, 'ConditionalCheckFailedException');
    assert.strictEqual(e.status, 409);
    assert.strictEqual(e.retriable, true);
    assert.strictEqual(e.cause, cause);
  });

  it('stamps the non-enumerable cross-copy brand so a foreign-copy ApiError is wire-recognizable', () => {
    const e = new ApiError('boom', 500);
    // Branded, but the brand must never surface in JSON / log dumps.
    assert.strictEqual((e as { [BLOCKS_ERROR_BRAND]?: true })[BLOCKS_ERROR_BRAND], true);
    assert.ok(!Object.keys(e).some(k => k.toLowerCase().includes('brand')));
    assert.ok(!JSON.stringify({ ...e }).toLowerCase().includes('wiresafe'));
  });
});

describe('isApiErrorLike', () => {
  it('matches a real ApiError', () => {
    assert.ok(isApiErrorLike(new ApiError('x', 404)));
  });

  it('matches an ApiError-shaped error from a SEPARATELY bundled copy of core', () => {
    // A duplicated @aws-blocks/core defines its own ApiError class, so a real
    // instanceof check fails. The constructor-stamped brand + numeric status let
    // the serializer still recognize it. Simulate the foreign instance.
    const foreign = Object.assign(new Error('stale'), { name: 'ConditionalCheckFailedException', status: 409 });
    Object.defineProperty(foreign, Symbol.for('aws-blocks.wireSafeError'), { value: true, enumerable: false });
    assert.ok(!(foreign instanceof ApiError));
    assert.ok(isApiErrorLike(foreign));
  });

  it('does NOT match a branded plain Error without a numeric status (stays a 500-class error)', () => {
    // blocksError() stamps the brand but produces no HTTP status: it must not be
    // misread as an ApiError, so the serializer still gives it status 500.
    const branded = new Error('bb failure');
    branded.name = 'ValidationFailedException';
    Object.defineProperty(branded, BLOCKS_ERROR_BRAND, { value: true, enumerable: false });
    assert.ok(!isApiErrorLike(branded));
  });

  it('does NOT match an unbranded error even when it carries a numeric status', () => {
    // A raw SDK exception could coincidentally have a numeric `status`; without the
    // brand it must not be treated as a wire-safe ApiError.
    const raw = Object.assign(new Error('secret leak'), { name: 'DynamoDBServiceException', status: 400 });
    assert.ok(!isApiErrorLike(raw));
  });

  it('does NOT match a non-Error value', () => {
    assert.ok(!isApiErrorLike({ status: 409, name: 'x' }));
    assert.ok(!isApiErrorLike('nope'));
    assert.ok(!isApiErrorLike(null));
  });
});

describe('isBlocksError', () => {
  it('matches a thrown ApiError by name', () => {
    const e = new ApiError('nope', 401, { name: 'InvalidCredentialsException' });
    assert.ok(isBlocksError(e, 'InvalidCredentialsException'));
  });

  it('does not match a different name', () => {
    const e = new ApiError('nope', 401, { name: 'InvalidCredentialsException' });
    assert.ok(!isBlocksError(e, 'SomeOtherException'));
  });

  it('does not match a plain object (not an Error)', () => {
    assert.ok(!isBlocksError({ name: 'InvalidCredentialsException' }, 'InvalidCredentialsException'));
  });
});

describe('hasAuthError', () => {
  it('matches a state carrying the given errorName', () => {
    const state = { state: 'signedOut', errorName: 'InvalidCredentialsException' } as const;
    assert.ok(hasAuthError(state, 'InvalidCredentialsException'));
  });

  it('does not match a different errorName', () => {
    const state = { errorName: 'InvalidCredentialsException' };
    assert.ok(!hasAuthError(state, 'UserAlreadyExistsException'));
  });

  it('does not match a state with no errorName', () => {
    const state: { errorName?: string } = {};
    assert.ok(!hasAuthError(state, 'InvalidCredentialsException'));
  });

  it('is safe on null / undefined', () => {
    assert.ok(!hasAuthError(null, 'InvalidCredentialsException'));
    assert.ok(!hasAuthError(undefined, 'InvalidCredentialsException'));
  });

  it('narrows the errorName to the matched literal', () => {
    const state: { errorName?: string } = { errorName: 'InvalidCredentialsException' };
    if (hasAuthError(state, 'InvalidCredentialsException')) {
      // Type-level: state.errorName is narrowed to the literal.
      const name: 'InvalidCredentialsException' = state.errorName;
      assert.strictEqual(name, 'InvalidCredentialsException');
    } else {
      assert.fail('expected match');
    }
  });
});
