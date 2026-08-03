// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for the local-JWKS mock (`createLocalJwt`).
 * Proves a backend can verify tokens fully offline.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert';
import type { BlocksContext } from '@aws-blocks/core';
import { ApiError } from '@aws-blocks/core';
import { createLocalJwt } from './index.mock.js';

function ctx(authHeader?: string): BlocksContext {
	const headers = new Headers();
	if (authHeader) headers.set('authorization', authHeader);
	return {
		request: { headers, body: null, json: async () => ({}), text: async () => '', url: new URL('http://localhost/'), params: {} },
		response: { headers: new Headers(), status: 200, send: () => {} },
	} as unknown as BlocksContext;
}

describe('createLocalJwt (local-JWKS mock)', () => {
	test('verifies a minted token offline and maps the user', async () => {
		const { auth, mint } = await createLocalJwt({ id: 'app' }, 'auth');
		const token = await mint({ sub: 'user-1', email: 'a@b.com' });
		const user = await auth.requireAuth(ctx(`Bearer ${token}`));
		assert.strictEqual(user.userId, 'user-1');
		assert.strictEqual(user.username, 'a@b.com');
	});

	test('checkAuth true with a minted token, false without', async () => {
		const { auth, mint } = await createLocalJwt({ id: 'app' }, 'auth');
		assert.strictEqual(await auth.checkAuth(ctx(`Bearer ${await mint()}`)), true);
		assert.strictEqual(await auth.checkAuth(ctx()), false);
	});

	test('rejects a token from a different (foreign) local instance', async () => {
		const a = await createLocalJwt({ id: 'app' }, 'auth');
		const b = await createLocalJwt({ id: 'app' }, 'auth'); // different keypair
		const foreign = await b.mint({ sub: 'attacker' });
		assert.strictEqual(await a.auth.checkAuth(ctx(`Bearer ${foreign}`)), false);
	});

	test('rejects an expired minted token', async () => {
		const { auth, mint } = await createLocalJwt({ id: 'app' }, 'auth');
		const expired = await mint({ sub: 'user-1', expiresIn: '-1h' });
		await assert.rejects(() => auth.requireAuth(ctx(`Bearer ${expired}`)));
	});

	test('enforces requiredClaims', async () => {
		const { auth, mint } = await createLocalJwt({ id: 'app' }, 'auth', { requiredClaims: ['org_id'] });
		const missing = await mint({ sub: 'user-1' });
		await assert.rejects(
			() => auth.requireAuth(ctx(`Bearer ${missing}`)),
			(e: unknown) => e instanceof ApiError && e.status === 401,
		);
		const withClaim = await mint({ sub: 'user-1', org_id: 'org-42' });
		const user = await auth.requireAuth(ctx(`Bearer ${withClaim}`));
		assert.strictEqual(user.claims.org_id, 'org-42');
	});

	test('enforces audience when configured', async () => {
		const { auth, mint } = await createLocalJwt({ id: 'app' }, 'auth', { audience: 'api://x' });
		const user = await auth.requireAuth(ctx(`Bearer ${await mint({ sub: 'u-1' })}`));
		assert.strictEqual(user.userId, 'u-1');
	});
});
