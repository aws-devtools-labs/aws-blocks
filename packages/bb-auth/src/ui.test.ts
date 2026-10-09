// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert';
import { describe, test } from 'node:test';
import * as shared from '@aws-blocks/auth-common/ui';
import * as ui from './ui.js';

describe('@aws-blocks/bb-auth/ui', () => {
	test('R1/S1: re-exports the shared renderer, notifier and store — the same functions, so one store per api', () => {
		for (const name of [
			'Authenticator',
			'AuthenticatedContent',
			'AccountMenuBar',
			'onAuthChange',
			'broadcastAuthChange',
			'submitAuthAction',
			'subscribeAuthState',
			'getAuthStateSnapshot',
		] as const) {
			assert.strictEqual(typeof ui[name], 'function', name);
			assert.strictEqual(ui[name], shared[name], `${name} is the auth-common function, not a copy`);
		}
	});

	test('re-exports every runtime export of @aws-blocks/auth-common/ui', () => {
		const missing = Object.keys(shared).filter((name) => !(name in ui));
		assert.deepStrictEqual(missing, []);
	});

	test('authOverrides is a zero-cost pass-through', () => {
		const options = {
			hideActions: ['signUp', 'signIn:google'],
			actions: { signIn: { fields: { username: { label: 'Email' } } } },
		} satisfies ui.AuthTypedAuthenticatorOptions;
		assert.strictEqual(ui.authOverrides(options), options);
	});
});
