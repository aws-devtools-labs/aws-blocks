// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, test } from 'node:test';
import assert from 'node:assert';
import type { BlocksContext } from '@aws-blocks/core';
import { Scope, ApiError } from '@aws-blocks/core';
import { SignJWT } from 'jose';
import { AuthSupabase, AuthSupabaseErrors } from './index.js';

const SECRET = 'unit-test-supabase-jwt-secret';
const SUPABASE_URL = 'https://proj.supabase.co';

function ctx(authHeader?: string): BlocksContext {
	const headers = new Headers();
	if (authHeader) headers.set('authorization', authHeader);
	return {
		request: { headers },
		response: { headers: new Headers() },
	} as unknown as BlocksContext;
}

let counter = 0;
function makeAuth(): AuthSupabase {
	const scope = new Scope(`supabase-${++counter}-${Math.random().toString(36).slice(2, 6)}`);
	// Inline HS256 secret keeps the test fully offline (no SSM/AppSetting).
	return new AuthSupabase(scope, 'auth', { supabaseUrl: SUPABASE_URL, jwtSecret: SECRET });
}

async function bearer(o: { sub?: string; email?: string; role?: string } = {}): Promise<string> {
	const token = await new SignJWT({
		email: o.email ?? 'alice@example.com',
		role: o.role ?? 'authenticated',
	})
		.setProtectedHeader({ alg: 'HS256' })
		.setIssuer(`${SUPABASE_URL}/auth/v1`)
		.setAudience('authenticated')
		.setSubject(o.sub ?? 'user-123')
		.setIssuedAt()
		.setExpirationTime('2h')
		.sign(new TextEncoder().encode(SECRET));
	return `Bearer ${token}`;
}

describe('AuthSupabase — BlocksAuth contract', () => {
	test('requireAuth returns the mapped user for a valid token', async () => {
		const auth = makeAuth();
		const user = await auth.requireAuth(ctx(await bearer({ sub: 'u1', email: 'a@b.com' })));
		assert.strictEqual(user.userId, 'u1');
		assert.strictEqual(user.username, 'a@b.com');
		assert.strictEqual(user.email, 'a@b.com');
		assert.strictEqual(user.role, 'authenticated');
	});

	test('checkAuth is true with a valid token and false without', async () => {
		const auth = makeAuth();
		assert.strictEqual(await auth.checkAuth(ctx(await bearer())), true);
		assert.strictEqual(await auth.checkAuth(ctx()), false);
	});

	test('getCurrentUser returns null when there is no Authorization header', async () => {
		const auth = makeAuth();
		assert.strictEqual(await auth.getCurrentUser(ctx()), null);
	});

	test('requireAuth throws ApiError 401 (SessionExpired) when unauthenticated', async () => {
		const auth = makeAuth();
		await assert.rejects(
			() => auth.requireAuth(ctx()),
			(e: unknown) => {
				assert.ok(e instanceof ApiError);
				assert.strictEqual(e.status, 401);
				assert.strictEqual(e.name, AuthSupabaseErrors.SessionExpired);
				return true;
			},
		);
	});

	test('requireAuth rejects a malformed bearer token', async () => {
		const auth = makeAuth();
		await assert.rejects(() => auth.requireAuth(ctx('Bearer not-a-jwt')));
	});

	test('a non-Bearer Authorization scheme is treated as unauthenticated', async () => {
		const auth = makeAuth();
		assert.strictEqual(await auth.checkAuth(ctx('Basic dXNlcjpwYXNz')), false);
	});

	test('requireRole enforces the role claim (403 on mismatch)', async () => {
		const auth = makeAuth();
		const ok = await auth.requireRole(ctx(await bearer({ role: 'admin' })), 'admin');
		assert.strictEqual(ok.role, 'admin');
		await assert.rejects(
			async () => auth.requireRole(ctx(await bearer({ role: 'authenticated' })), 'admin'),
			(e: unknown) => e instanceof ApiError && e.status === 403,
		);
	});
});
