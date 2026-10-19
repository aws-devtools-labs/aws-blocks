// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert';
import { afterEach, describe, it } from 'node:test';
import { TOKEN_ENV_VAR, isAuthorized, isAuthorizedToMutate, isValidToken, parseBearerToken } from './auth.js';

describe('parseBearerToken', () => {
	it('extracts the token from a Bearer header', () => {
		assert.strictEqual(parseBearerToken('Bearer abc123'), 'abc123');
	});

	it('is case-insensitive on the scheme', () => {
		assert.strictEqual(parseBearerToken('bearer abc123'), 'abc123');
	});

	it('returns undefined for missing or malformed headers', () => {
		assert.strictEqual(parseBearerToken(undefined), undefined);
		assert.strictEqual(parseBearerToken(null), undefined);
		assert.strictEqual(parseBearerToken(''), undefined);
		assert.strictEqual(parseBearerToken('Basic abc123'), undefined);
		assert.strictEqual(parseBearerToken('Bearer'), undefined);
	});
});

describe('isValidToken', () => {
	it('accepts an exact match', () => {
		assert.strictEqual(isValidToken('secret', 'secret'), true);
	});

	it('rejects mismatches, empty and missing values', () => {
		assert.strictEqual(isValidToken('secret', 'other'), false);
		assert.strictEqual(isValidToken('secre', 'secret'), false);
		assert.strictEqual(isValidToken(undefined, 'secret'), false);
		assert.strictEqual(isValidToken('secret', undefined), false);
		assert.strictEqual(isValidToken('', ''), false);
	});
});

describe('isAuthorized', () => {
	// Next's types mark NODE_ENV readonly; tests legitimately mutate it.
	const env = process.env as Record<string, string | undefined>;
	const originalToken = env[TOKEN_ENV_VAR];
	const originalNodeEnv = env.NODE_ENV;

	afterEach(() => {
		if (originalToken === undefined) delete env[TOKEN_ENV_VAR];
		else env[TOKEN_ENV_VAR] = originalToken;
		if (originalNodeEnv === undefined) delete env.NODE_ENV;
		else env.NODE_ENV = originalNodeEnv;
	});

	it('accepts the configured token via Authorization header', () => {
		env[TOKEN_ENV_VAR] = 'tok';
		assert.strictEqual(isAuthorized('Bearer tok'), true);
	});

	it('rejects wrong or missing tokens when one is configured', () => {
		env[TOKEN_ENV_VAR] = 'tok';
		assert.strictEqual(isAuthorized('Bearer nope'), false);
		assert.strictEqual(isAuthorized(undefined), false);
	});

	it('denies by default when no token is configured outside development', () => {
		delete env[TOKEN_ENV_VAR];
		env.NODE_ENV = 'production';
		assert.strictEqual(isAuthorized('Bearer anything'), false);
	});

	it('allows unauthenticated access only under NODE_ENV=development', () => {
		delete env[TOKEN_ENV_VAR];
		env.NODE_ENV = 'development';
		assert.strictEqual(isAuthorized(undefined), true);
	});
});

describe('isAuthorizedToMutate — the development fallback never covers a write', () => {
	/**
	 * Flagged independently by two audits. `isAuthorized` allows unauthenticated
	 * access when nothing is configured and NODE_ENV is development, so that a
	 * plain `next dev` renders pages with nothing to present. Under that same
	 * condition every write route was reachable with no credential at all —
	 * including unlocking cloud writes and then deleting from a deployed stack,
	 * with the developer's real AWS credentials sitting in the environment.
	 *
	 * Reading local state that way is a convenience with a small blast radius.
	 * Writing to a deployed stack is not the same thing, so the write path takes
	 * no fallback.
	 */
	const env = process.env as Record<string, string | undefined>;
	const originalToken = env[TOKEN_ENV_VAR];
	const originalNodeEnv = env.NODE_ENV;

	afterEach(() => {
		if (originalToken === undefined) delete env[TOKEN_ENV_VAR];
		else env[TOKEN_ENV_VAR] = originalToken;
		if (originalNodeEnv === undefined) delete env.NODE_ENV;
		else env.NODE_ENV = originalNodeEnv;
	});

	it('refuses when nothing is configured, even in development', () => {
		delete env[TOKEN_ENV_VAR];
		env.NODE_ENV = 'development';
		// The read path deliberately still allows this — that is the convenience.
		assert.strictEqual(isAuthorized(undefined), true);
		// The write path must not.
		assert.strictEqual(isAuthorizedToMutate(undefined), false);
		assert.strictEqual(isAuthorizedToMutate('Bearer anything'), false);
	});

	it('refuses when nothing is configured outside development', () => {
		delete env[TOKEN_ENV_VAR];
		env.NODE_ENV = 'production';
		assert.strictEqual(isAuthorizedToMutate(undefined), false);
	});

	it('accepts the configured value, in development as anywhere else', () => {
		env[TOKEN_ENV_VAR] = 'tok';
		env.NODE_ENV = 'development';
		assert.strictEqual(isAuthorizedToMutate('Bearer tok'), true);
		assert.strictEqual(isAuthorizedToMutate('Bearer nope'), false);
		assert.strictEqual(isAuthorizedToMutate(undefined), false);
	});
});
