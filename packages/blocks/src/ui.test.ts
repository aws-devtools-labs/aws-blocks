// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert';
import { test } from 'node:test';
import * as shared from '@aws-blocks/auth-common/ui';
import * as authUi from '@aws-blocks/bb-auth/ui';
import * as ui from './ui.js';

// Requirements R1 / S1 (docs/design/auth-unification/D7-reactivity-requirements.md):
// the notifier and the store ship from `@aws-blocks/blocks/ui` next to the
// components, as the very same functions — one per-`api` store, whichever path
// an app imports from.
test('@aws-blocks/blocks/ui re-exports the auth UI, notifier and store from auth-common', () => {
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
		assert.strictEqual(ui[name], shared[name], `${name} is the auth-common function`);
	}
});

test("@aws-blocks/blocks/ui re-exports Auth's UI helpers from @aws-blocks/bb-auth/ui", () => {
	assert.strictEqual(typeof ui.authOverrides, 'function');
	assert.strictEqual(ui.authOverrides, authUi.authOverrides);
	assert.deepStrictEqual(Object.keys(ui).sort(), Object.keys(authUi).sort());
});
