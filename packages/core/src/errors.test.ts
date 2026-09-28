// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { ApiError, DEFAULT_API_ERROR_NAME, isBlocksError, hasAuthError } from './errors.js';

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
