// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { ApiError, isBlocksError, hasAuthError } from './errors.js';

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
