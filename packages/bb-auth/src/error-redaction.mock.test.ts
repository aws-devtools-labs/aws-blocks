// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * A hook's raw error text never reaches the client. `setAuthState()` answers
 * unauthenticated callers, and the sign-in callback answers the browser, so an
 * unexpected error (an SDK, store or hook failure, whose message can name
 * accounts and ARNs) is reported generically; an `ApiError` keeps its status,
 * name and message, so a hook can still tell the user why.
 */

import assert from 'node:assert';
import { rmSync } from 'node:fs';
import { afterEach, beforeEach, describe, test } from 'node:test';
import type { AuthStateApi } from '@aws-blocks/auth-common';
import { ApiError, type BlocksContext, type ScopeParent } from '@aws-blocks/core';
import { INTERNAL_ERROR_MESSAGE } from './error-mapping.js';
import { Auth, AuthErrors } from './index.mock.js';
import { Browser } from './test-support/aws-harness.js';

beforeEach(() => rmSync('.bb-data', { recursive: true, force: true }));
afterEach(() => rmSync('.bb-data', { recursive: true, force: true }));

/** What an SDK raises for a denied call: its message names an account and a role ARN. */
const RAW_BACKEND_ERROR = 'User: arn:aws:sts::111122223333:assumed-role/app-role/x is not authorized to perform: ses:SendEmail';

let n = 0;
const root = (): ScopeParent => ({ id: `redact${process.pid}x${++n}` });

describe('setAuthState: a failing codeDelivery hook', () => {
	function setup() {
		const auth = new Auth(root(), 'auth', {
			users: { signInWith: ['email'] },
			codeDelivery: async (username: string) => {
				if (username.startsWith('api-')) {
					throw new ApiError('That address cannot receive email', 400, { name: 'UndeliverableAddressException' });
				}
				throw new Error(RAW_BACKEND_ERROR);
			},
		});
		const b = new Browser();
		const signUp = (username: string) =>
			b.request((ctx) =>
				(auth.createApi() as unknown as (c: BlocksContext) => AuthStateApi)(ctx).setAuthState({
					action: 'signUp',
					username,
					password: 'Passw0rd!',
				}),
			);
		return { signUp };
	}

	test('an unbranded error reaches the client only as the generic internal error', async () => {
		const state = await setup().signUp('raw-user@example.com');
		assert.strictEqual(state.state, 'signedOut');
		assert.strictEqual(state.error, INTERNAL_ERROR_MESSAGE);
		assert.strictEqual(state.errorName, AuthErrors.InternalError);
		assert.ok(!JSON.stringify(state).includes('111122223333'), `no backend detail: ${JSON.stringify(state)}`);
	});

	test("an ApiError's message and name reach the client unchanged", async () => {
		const state = await setup().signUp('api-user@example.com');
		assert.strictEqual(state.state, 'signedOut');
		assert.strictEqual(state.error, 'That address cannot receive email');
		assert.strictEqual(state.errorName, 'UndeliverableAddressException');
	});
});
