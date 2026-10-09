// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, test } from 'node:test';
import assert from 'node:assert';
import { extractUserAttributes, memoizePerContext, toCognitoApiError, AuthCognitoErrors } from './index.aws.js';
import { ApiError } from '@aws-blocks/core';

describe('extractUserAttributes (JWT allow-shape)', () => {
	test('passes through standard OIDC attributes', () => {
		const out = extractUserAttributes({
			email: 'alice@example.com',
			email_verified: 'true',
			phone_number: '+15555550100',
			name: 'Alice',
		});
		assert.deepStrictEqual(out, {
			email: 'alice@example.com',
			email_verified: 'true',
			phone_number: '+15555550100',
			name: 'Alice',
		});
	});

	test('passes through custom: attributes', () => {
		const out = extractUserAttributes({
			'custom:department': 'eng',
			'custom:employeeId': '12345',
		});
		assert.deepStrictEqual(out, {
			'custom:department': 'eng',
			'custom:employeeId': '12345',
		});
	});

	test('drops cognito:-prefixed claims', () => {
		const out = extractUserAttributes({
			'cognito:username': 'alice',
			'cognito:groups': 'admins',
			email: 'alice@example.com',
		});
		assert.deepStrictEqual(out, { email: 'alice@example.com' });
	});

	test('drops reserved JWT + Cognito lifecycle claims', () => {
		const out = extractUserAttributes({
			sub: 'abc-123',
			iss: 'https://cognito-idp.us-east-1.amazonaws.com/us-east-1_XXX',
			aud: 'client-id',
			iat: 1234567890,
			exp: 1234567890,
			nbf: 1234567890,
			jti: 'jti-abc',
			token_use: 'id',
			auth_time: 1234567890,
			origin_jti: 'origin-abc',
			event_id: 'event-abc',
			email: 'alice@example.com',
		});
		assert.deepStrictEqual(out, { email: 'alice@example.com' });
	});

	test('drops non-string values (e.g. claim arrays, numbers)', () => {
		const out = extractUserAttributes({
			email: 'alice@example.com',
			'cognito:groups': ['admins', 'readers'],
			some_number_claim: 42,
			some_bool_claim: true,
			some_object_claim: { nested: 'value' },
		});
		// Only the string `email` should pass.
		assert.deepStrictEqual(out, { email: 'alice@example.com' });
	});

	test('allows a hypothetical new standard OIDC attribute automatically', () => {
		// Forward-compat: when AWS adds a new non-cognito:, non-reserved standard
		// claim (e.g. a new OIDC spec attribute), it flows through without a
		// library update. The helper drops only known-reserved names + the
		// cognito: prefix; everything else is customer-visible.
		const out = extractUserAttributes({
			hypothetical_future_standard_claim: 'value',
			email: 'alice@example.com',
		});
		assert.deepStrictEqual(out, {
			hypothetical_future_standard_claim: 'value',
			email: 'alice@example.com',
		});
	});
});

describe('memoizePerContext (requireRole per-request dedupe)', () => {
	// Locks the "one AdminListGroupsForUser per request" invariant that requireRole
	// relies on — a refactor handing liveGroupsForUser a per-call object instead of
	// the request context would silently restore N calls per request, and only this
	// asserts against it.
	test('same context + key → factory runs once; concurrent lookups share one call', async () => {
		const memo = new WeakMap<object, Map<string, Promise<number>>>();
		const ctx = {};
		let calls = 0;
		const factory = () => Promise.resolve(++calls);
		const [a, b] = await Promise.all([
			memoizePerContext(memo, ctx, 'alice', factory),
			memoizePerContext(memo, ctx, 'alice', factory),
		]);
		assert.strictEqual(calls, 1, 'two lookups on the same context+key run the factory once');
		assert.strictEqual(a, 1);
		assert.strictEqual(b, 1);
		assert.strictEqual(await memoizePerContext(memo, ctx, 'alice', factory), 1, 'cache hit after settle');
		assert.strictEqual(calls, 1);
	});

	test('different contexts each run the factory (per-request scope)', async () => {
		const memo = new WeakMap<object, Map<string, Promise<number>>>();
		let calls = 0;
		const factory = () => Promise.resolve(++calls);
		await memoizePerContext(memo, {}, 'alice', factory);
		await memoizePerContext(memo, {}, 'alice', factory);
		assert.strictEqual(calls, 2);
	});

	test('different keys on one context each run the factory', async () => {
		const memo = new WeakMap<object, Map<string, Promise<number>>>();
		const ctx = {};
		let calls = 0;
		const factory = () => Promise.resolve(++calls);
		await memoizePerContext(memo, ctx, 'alice', factory);
		await memoizePerContext(memo, ctx, 'bob', factory);
		assert.strictEqual(calls, 2);
	});

	test('a rejected call is evicted → a later call in the same context retries (not replayed)', async () => {
		const memo = new WeakMap<object, Map<string, Promise<number>>>();
		const ctx = {};
		let calls = 0;
		const factory = () => {
			calls++;
			return calls === 1 ? Promise.reject(new Error('throttle')) : Promise.resolve(calls);
		};
		await assert.rejects(() => memoizePerContext(memo, ctx, 'alice', factory), /throttle/);
		const second = await memoizePerContext(memo, ctx, 'alice', factory);
		assert.strictEqual(second, 2, 'the retry re-runs the factory rather than replaying the cached rejection');
		assert.strictEqual(calls, 2);
	});
});

describe('toCognitoApiError (wire-safe SDK error translation)', () => {
	const rawText =
		'User: arn:aws:sts::123456789012:assumed-role/app-role/session is not authorized at https://cognito-idp.us-east-1.amazonaws.com';

	function cognitoError(name: string, message: string): Error {
		const e = new Error(message);
		e.name = name;
		return e;
	}

	test('non-Error input → generic 500 ApiError', () => {
		const err = toCognitoApiError('boom');
		assert.ok(err instanceof ApiError);
		assert.strictEqual(err.message, 'Unknown error');
		assert.strictEqual(err.status, 500);
		assert.strictEqual(err.cause, undefined);
	});

	test('raw Cognito message never reaches ApiError.message or its JSON form', () => {
		const raw = cognitoError(AuthCognitoErrors.NotAuthorized, rawText);
		const err = toCognitoApiError(raw);
		assert.strictEqual(err.message, 'Not authorized');
		assert.ok(!err.message.includes('123456789012'));
		assert.ok(!JSON.stringify(err).includes('123456789012'));
		assert.ok(!JSON.stringify({ ...err }).includes('123456789012'));
	});

	test('raw SDK error is kept on a non-enumerable cause', () => {
		const raw = cognitoError(AuthCognitoErrors.NotAuthorized, rawText);
		const err = toCognitoApiError(raw);
		assert.strictEqual(err.cause, raw);
		assert.strictEqual(Object.getOwnPropertyDescriptor(err, 'cause')?.enumerable, false);
		assert.ok(!Object.keys(err).includes('cause'));
	});

	test('name, status, and retriable flag are preserved', () => {
		const notAuthorized = toCognitoApiError(cognitoError(AuthCognitoErrors.NotAuthorized, rawText));
		assert.strictEqual(notAuthorized.name, AuthCognitoErrors.NotAuthorized);
		assert.strictEqual(notAuthorized.status, 401);
		assert.strictEqual(notAuthorized.retriable, false);

		const codeMismatch = toCognitoApiError(cognitoError(AuthCognitoErrors.CodeMismatch, rawText));
		assert.strictEqual(codeMismatch.name, AuthCognitoErrors.CodeMismatch);
		assert.strictEqual(codeMismatch.status, 400);
		assert.strictEqual(codeMismatch.retriable, true);
		assert.strictEqual(codeMismatch.message, 'Invalid code');

		const throttled = toCognitoApiError(cognitoError(AuthCognitoErrors.TooManyRequests, rawText));
		assert.strictEqual(throttled.status, 429);
	});

	test('unknown exception name → BB default message, raw text still withheld', () => {
		const err = toCognitoApiError(cognitoError('AccessDeniedException', rawText));
		assert.strictEqual(err.name, 'AccessDeniedException');
		assert.strictEqual(err.message, 'Authentication request failed');
		assert.ok(!JSON.stringify(err).includes('123456789012'));
	});

	test('every AuthCognitoErrors name maps to a BB-authored message, never the raw text', () => {
		for (const name of Object.values(AuthCognitoErrors)) {
			const err = toCognitoApiError(cognitoError(name, rawText));
			assert.strictEqual(err.name, name);
			assert.ok(!err.message.includes(rawText), `${name} leaked raw Cognito text`);
			assert.notStrictEqual(err.message, 'Authentication request failed', `${name} has no dedicated message`);
		}
	});

	test('no own-enumerable field of the raw SDK error is copied onto the ApiError', () => {
		// A real Cognito SDK exception carries extra own-enumerable fields
		// ($metadata, $fault, Code, ...) that can embed identifying text. The
		// contract is that the raw error lives ONLY on the non-enumerable cause,
		// so none of those raw-specific keys should appear on the ApiError even
		// if the construction later changes to a field-spreading shape. `name` is
		// excluded: it is the deliberately-preserved BB-level field (D-003 allows
		// the name over the wire), not raw SDK text.
		const raw = Object.assign(cognitoError(AuthCognitoErrors.NotAuthorized, rawText), {
			$metadata: { httpStatusCode: 401, requestId: 'req-123456789012' },
			$fault: 'client',
			Code: 'NotAuthorizedException',
		});
		const err = toCognitoApiError(raw);
		const rawOnlyKeys = Object.keys(raw).filter((k) => k !== 'name');
		for (const key of rawOnlyKeys) {
			assert.ok(!Object.keys(err).includes(key), `raw SDK field '${key}' was copied onto the ApiError`);
		}
		assert.ok(!JSON.stringify(err).includes('req-123456789012'));
	});
});
