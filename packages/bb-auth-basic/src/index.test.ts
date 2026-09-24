// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * setAuthState error-name propagation tests for AuthBasic (issue #81). The
 * recommended client path catches the thrown ApiError and must surface its
 * structured `name` as `AuthState.errorName` so clients can branch with
 * `hasAuthError` instead of string-matching the human-facing message.
 */

import { describe, test, beforeEach } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BlocksContext } from '@aws-blocks/core';
import { Scope, hasAuthError } from '@aws-blocks/core';
import type { AuthStateApi } from '@aws-blocks/auth-common';
import { AuthBasic, AuthBasicErrors, type AuthBasicOptions } from './index.js';
import { BB_NAME, BB_VERSION } from './version.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

function ctx(origin?: string): BlocksContext {
	const headers = new Headers();
	if (origin) headers.set('origin', origin);
	return {
		request: { headers },
		response: { headers: new Headers() },
	} as unknown as BlocksContext;
}

let counter = 0;
function makeAuth(options?: AuthBasicOptions): AuthBasic {
	const scope = new Scope(`basic-errname-${++counter}-${Math.random().toString(36).slice(2, 6)}`);
	return new AuthBasic(scope, 'auth', options);
}

// `createApi()` returns a context-bound `ApiNamespace` callable; narrow it to
// the public `AuthStateApi` surface the test exercises instead of `as any`.
function apiFor(auth: AuthBasic, context: BlocksContext): AuthStateApi {
	return (auth.createApi() as unknown as (c: BlocksContext) => AuthStateApi)(context);
}

describe('AuthBasic setAuthState errorName', () => {
	test('signIn for an unknown user surfaces errorName = InvalidCredentials', async () => {
		const auth = makeAuth();
		const api = apiFor(auth, ctx());

		const next = await api.setAuthState({ action: 'signIn', username: 'nobody', password: 'whatever1' });

		assert.strictEqual(next.state, 'signedOut');
		assert.strictEqual(next.errorName, AuthBasicErrors.InvalidCredentials);
		// The documented client idiom now reaches this path.
		assert.ok(hasAuthError(next, AuthBasicErrors.InvalidCredentials));
	});

	test('signIn with a wrong password surfaces errorName = InvalidCredentials', async () => {
		const auth = makeAuth();
		await auth.signUp('alice', 'password123');
		const api = apiFor(auth, ctx());

		const next = await api.setAuthState({ action: 'signIn', username: 'alice', password: 'wrong-password' });

		assert.strictEqual(next.state, 'signedOut');
		assert.strictEqual(next.errorName, AuthBasicErrors.InvalidCredentials);
	});

	test('a generic ApiError (no structured name) yields no errorName', async () => {
		// resetPassword throws a plain ApiError('Password reset not configured')
		// with no `name` when codeDelivery is unset — `.name` defaults to
		// DEFAULT_API_ERROR_NAME, which must not leak as a meaningful errorName.
		const auth = makeAuth();
		const api = apiFor(auth, ctx());

		const next = await api.setAuthState({ action: 'resetPassword', username: 'alice' });

		assert.strictEqual(next.state, 'signedOut');
		assert.ok(next.error);
		assert.strictEqual(next.errorName, undefined);
	});
});

/**
 * Telemetry-registration tests for AuthBasic.
 *
 * `Scope.getRegisteredBlocks()` only names a block whose `bbName` is in
 * OFFICIAL_BB_NAMES, and that set is generated from the umbrella's
 * `aws-blocks.vendorize` map. These tests pin the three coupled artifacts to
 * each other: the block's generated BB_NAME, its vendorize entry, and the
 * generated name set. A block that omits `bbMeta` still constructs fine and
 * every other test still passes, so that gap is only visible here.
 */
describe('AuthBasic telemetry registration', () => {
	beforeEach(() => {
		Scope._resetRegistry();
	});

	test('BB_NAME is the name the vendorize map and OFFICIAL_BB_NAMES carry', () => {
		assert.strictEqual(BB_NAME, 'AuthBasic');
	});

	test('BB_VERSION tracks the package version', () => {
		const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf-8'));
		assert.strictEqual(BB_VERSION, pkg.version);
	});

	test('an instance carries bbName and bbVersion', () => {
		const auth = makeAuth();
		assert.strictEqual(auth.bbName, BB_NAME);
		assert.strictEqual(auth.bbVersion, BB_VERSION);
	});

	test('registers as an official block, so telemetry is allowed to name it', () => {
		makeAuth();
		const { blocks, customBlocksCount } = Scope.getRegisteredBlocks();
		assert.deepStrictEqual(
			blocks.filter(b => b.name === BB_NAME),
			[{ name: BB_NAME, version: BB_VERSION }],
		);
		assert.strictEqual(customBlocksCount, 0, 'must not be filtered out as an unnamed custom block');
	});
});
