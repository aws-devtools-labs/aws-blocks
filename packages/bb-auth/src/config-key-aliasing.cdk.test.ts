// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Two `Auth` blocks whose ids fold to one config key (`auth-a` and `auth_a` both
 * become `…_AUTH_A`) used to synthesize two user pools but register one
 * `USER_POOL_ID` config entry, the second silently replacing the first. At
 * runtime both blocks then read the same pool, and with `validateUser` the
 * second PreSignUp registration threw on every cold start. `registerConfig` now
 * refuses the conflicting registration, so synth fails naming the key.
 */
import assert from 'node:assert';
import { describe, test } from 'node:test';
import { synthBlocksApp } from './test-support/blocks-app-synth.js';
import { freshAppDir } from './test-support/guard-synth.js';

const VALIDATE = 'validateUser: async () => {}';

describe('Auth: block ids that fold to one config key fail synth', () => {
	test('auth-a + auth_a with validateUser: synth fails naming the shared USER_POOL_ID key', () => {
		const result = synthBlocksApp({
			build: `new Auth(stack, 'auth-a', { ${VALIDATE} }); new Auth(stack, 'auth_a', { ${VALIDATE} });`,
			appDir: freshAppDir(),
		});
		assert.strictEqual(result.ok, false, 'synth must fail');
		assert.match(
			result.stderr,
			/config key "BLOCKS_AUTH_COGNITO_TESTSTACK_AUTH_A_USER_POOL_ID" is already registered/,
		);
		assert.match(result.stderr, /'TestStack-auth-a'/);
		assert.match(result.stderr, /'TestStack-auth_a'/);
	});

	test('two Auth blocks with distinct ids still synthesize', () => {
		const result = synthBlocksApp({
			build: `new Auth(stack, 'customers', { ${VALIDATE} }); new Auth(stack, 'staff');`,
			appDir: freshAppDir(),
		});
		assert.ok(result.ok, result.stderr);
	});
});
