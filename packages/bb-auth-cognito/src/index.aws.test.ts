// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { after, before, describe, mock, test } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AuthCognito, extractUserAttributes, memoizePerContext, toCognitoApiError, AuthCognitoErrors, type CognitoUser } from './index.aws.js';
import { ApiError, Scope, type BlocksContext } from '@aws-blocks/core';
import { signSessionId } from './cookies.js';
import type { SessionRecord, SessionStore } from './sessions.js';

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

// ── Session refresh: concurrency + expiry boundary ──────────────────────────
//
// Drives the aws-runtime class with only the Cognito network call stubbed
// (`client.send`). Sessions live in the real `SessionStore`, which under the
// default export condition sits on the mock KVStore — the same conditional
// write semantics as DynamoDB.

const SECRET = 'session-refresh-test-secret';

interface AwsInternals {
	client: { send: (command: unknown) => Promise<unknown> };
	sessionSecret?: string;
	sessions: SessionStore;
}

function internals(auth: AuthCognito): AwsInternals {
	return auth as unknown as AwsInternals;
}

/** `SessionStore` keeps its KVStore private; the race tests pause one of its writes. */
interface SessionStoreInternals {
	kv: { put: (...args: unknown[]) => Promise<void> };
}

function jwt(claims: Record<string, unknown>): string {
	return ['e30', Buffer.from(JSON.stringify(claims)).toString('base64url'), 'sig'].join('.');
}

function tokensExpiringAt(expSeconds: number): SessionRecord {
	return {
		idToken: jwt({ 'cognito:username': 'alice', sub: 'sub-alice', token_use: 'id', exp: expSeconds }),
		accessToken: jwt({ sub: 'sub-alice', username: 'alice', token_use: 'access', exp: expSeconds }),
		refreshToken: 'refresh-token-alice',
	};
}

function freshAuthenticationResult(): { AuthenticationResult: { IdToken: string; AccessToken: string } } {
	const record = tokensExpiringAt(Math.floor(Date.now() / 1000) + 3600);
	return { AuthenticationResult: { IdToken: record.idToken, AccessToken: record.accessToken } };
}

function cognitoFailure(name: string): Error {
	const e = new Error(name);
	e.name = name;
	return e;
}

function requestWith(cookie: string): BlocksContext {
	return {
		request: {
			headers: new Headers({ cookie }),
			body: null,
			json: async () => ({}),
			text: async () => '',
			url: new URL('http://localhost:3000/'),
			params: {},
		},
		response: { headers: new Headers(), status: 200, send: () => {} },
	} as unknown as BlocksContext;
}

function sessionCookieHeader(ctx: BlocksContext, auth: AuthCognito): string | null {
	const header = ctx.response.headers.get('set-cookie');
	return header?.startsWith(`auth_${auth.fullId}=`) ? header : null;
}

function clearsSessionCookie(ctx: BlocksContext, auth: AuthCognito): boolean {
	return sessionCookieHeader(ctx, auth)?.includes('Max-Age=0') ?? false;
}

function issuesLiveSessionCookie(ctx: BlocksContext, auth: AuthCognito): boolean {
	const header = sessionCookieHeader(ctx, auth);
	return header !== null && !header.includes('Max-Age=0');
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve!: () => void;
	const promise = new Promise<void>((r) => { resolve = r; });
	return { promise, resolve };
}

let scopeSeq = 0;

async function signedInSession(expSeconds: number): Promise<{ auth: AuthCognito; id: string; cookie: string }> {
	const auth = new AuthCognito(new Scope(`session-refresh-${process.pid}-${++scopeSeq}`), 'auth');
	internals(auth).sessionSecret = SECRET;
	const id = await internals(auth).sessions.createSession(tokensExpiringAt(expSeconds));
	return { auth, id, cookie: `auth_${auth.fullId}=${signSessionId(id, SECRET)}` };
}

/** A session whose access token has expired but whose refresh token is still on file. */
function expiredSession(): Promise<{ auth: AuthCognito; id: string; cookie: string }> {
	return signedInSession(Math.floor(Date.now() / 1000) - 10);
}

/**
 * Two requests carrying the same cookie both find the access token expired and
 * both call `REFRESH_TOKEN_AUTH`. The first request's refresh succeeds and is
 * persisted; only then does the second request's Cognito call settle with
 * `second` (fresh tokens, or a thrown error).
 */
async function concurrentRefresh(
	auth: AuthCognito,
	cookie: string,
	second: () => Promise<unknown>,
): Promise<{ first: CognitoUser | null; secondCtx: BlocksContext; secondResult: Promise<CognitoUser | null> }> {
	const firstInCognito = deferred();
	const releaseFirst = deferred();
	const secondInCognito = deferred();
	const releaseSecond = deferred();
	let calls = 0;
	internals(auth).client.send = async () => {
		calls++;
		if (calls === 1) {
			firstInCognito.resolve();
			await releaseFirst.promise;
			return freshAuthenticationResult();
		}
		secondInCognito.resolve();
		await releaseSecond.promise;
		return second();
	};
	const firstResult = auth.getCurrentUser(requestWith(cookie));
	await firstInCognito.promise;
	const secondCtx = requestWith(cookie);
	const secondResult = auth.getCurrentUser(secondCtx);
	await secondInCognito.promise;
	releaseFirst.resolve();
	const first = await firstResult;
	releaseSecond.resolve();
	return { first, secondCtx, secondResult };
}

describe('AuthCognito (aws runtime) — session refresh', () => {
	const originalCwd = process.cwd();
	const dataRoot = mkdtempSync(join(tmpdir(), 'bb-auth-cognito-refresh-'));
	before(() => process.chdir(dataRoot));
	after(() => {
		process.chdir(originalCwd);
		rmSync(dataRoot, { recursive: true, force: true });
	});

	test('signOut while a refresh is in flight stays signed out', async () => {
		const { auth, id, cookie } = await expiredSession();
		internals(auth).client.send = async () => freshAuthenticationResult();

		// Pause the refresh after Cognito answered, just before it persists the
		// new tokens, and sign out in that window.
		// Test seam: reach the private KVStore to hold the refresh's write open.
		const store = internals(auth).sessions as unknown as SessionStoreInternals;
		const kv = store.kv;
		const realPut = kv.put.bind(kv);
		const atWrite = deferred();
		const releaseWrite = deferred();
		kv.put = async (...args: unknown[]) => {
			kv.put = realPut;
			atWrite.resolve();
			await releaseWrite.promise;
			return realPut(...args);
		};
		const inFlight = requestWith(cookie);
		const pending = auth.getCurrentUser(inFlight);
		await atWrite.promise;
		await auth.signOut(requestWith(cookie));
		releaseWrite.resolve();
		await pending;

		assert.strictEqual(await internals(auth).sessions.lookupSession(id), null, 'the signed-out session must not be recreated');
		assert.ok(!issuesLiveSessionCookie(inFlight, auth), 'the in-flight response must not re-issue the session cookie');
		internals(auth).client.send = async () => { throw new Error('Cognito must not be called for a signed-out session'); };
		assert.strictEqual(await auth.getCurrentUser(requestWith(cookie)), null, 'the old cookie must stay signed out');
	});

	test('a transient refresh failure keeps the session for the next request', async () => {
		const { auth, id, cookie } = await expiredSession();
		internals(auth).client.send = async () => { throw cognitoFailure(AuthCognitoErrors.TooManyRequests); };
		const throttled = requestWith(cookie);
		assert.strictEqual(await auth.getCurrentUser(throttled), null);
		assert.ok(await internals(auth).sessions.lookupSession(id), 'a throttled refresh must not delete the session');
		assert.ok(!clearsSessionCookie(throttled, auth), 'a throttled refresh must not clear the session cookie');

		internals(auth).client.send = async () => freshAuthenticationResult();
		assert.strictEqual((await auth.getCurrentUser(requestWith(cookie)))?.username, 'alice');
	});

	test('a refresh token the user pool rejects ends the session', async () => {
		const { auth, id, cookie } = await expiredSession();
		internals(auth).client.send = async () => { throw cognitoFailure(AuthCognitoErrors.NotAuthorized); };
		const rejected = requestWith(cookie);
		assert.strictEqual(await auth.getCurrentUser(rejected), null);
		assert.strictEqual(await internals(auth).sessions.lookupSession(id), null);
		assert.ok(clearsSessionCookie(rejected, auth));
	});

	test('a rejected refresh on a stale request does not delete the session another request just refreshed', async () => {
		const { auth, id, cookie } = await expiredSession();
		const { first, secondCtx, secondResult } = await concurrentRefresh(auth, cookie, async () => {
			throw cognitoFailure(AuthCognitoErrors.NotAuthorized);
		});
		assert.strictEqual(first?.username, 'alice');
		assert.strictEqual((await secondResult)?.username, 'alice', 'the stale request is served from the refreshed session');
		assert.ok(await internals(auth).sessions.lookupSession(id), 'the refreshed session must survive');
		assert.ok(!clearsSessionCookie(secondCtx, auth));

		internals(auth).client.send = async () => { throw new Error('the refreshed access token is still valid'); };
		assert.strictEqual((await auth.getCurrentUser(requestWith(cookie)))?.username, 'alice');
	});

	test('two concurrent successful refreshes both stay signed in', async () => {
		const { auth, id, cookie } = await expiredSession();
		const { first, secondCtx, secondResult } = await concurrentRefresh(auth, cookie, async () => freshAuthenticationResult());
		assert.strictEqual(first?.username, 'alice');
		assert.strictEqual((await secondResult)?.username, 'alice');
		assert.ok(await internals(auth).sessions.lookupSession(id));
		assert.ok(!clearsSessionCookie(secondCtx, auth));
	});

	test('an access token is expired from the instant now reaches its exp', async () => {
		const exp = Math.floor(Date.now() / 1000) + 600;
		let refreshes = 0;
		const at = async <T>(nowMs: number, run: (auth: AuthCognito, cookie: string) => Promise<T>): Promise<T> => {
			const { auth, cookie } = await signedInSession(exp);
			internals(auth).client.send = async () => {
				refreshes++;
				return freshAuthenticationResult();
			};
			const clock = mock.method(Date, 'now', () => nowMs);
			try {
				return await run(auth, cookie);
			} finally {
				clock.mock.restore();
			}
		};

		await at(exp * 1000 - 1, (auth, cookie) => auth.getCurrentUser(requestWith(cookie)));
		await at(exp * 1000 - 1, (auth, cookie) => auth.fetchAuthSession(requestWith(cookie)));
		assert.strictEqual(refreshes, 0, 'still valid one millisecond before exp');

		await at(exp * 1000, (auth, cookie) => auth.getCurrentUser(requestWith(cookie)));
		assert.strictEqual(refreshes, 1, 'getCurrentUser must refresh at exp');
		await at(exp * 1000, (auth, cookie) => auth.fetchAuthSession(requestWith(cookie)));
		assert.strictEqual(refreshes, 2, 'fetchAuthSession must refresh at exp');
	});
});
