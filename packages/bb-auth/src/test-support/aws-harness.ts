// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Offline harness for the AWS runtime entry (`index.aws.ts`) — `Auth` over the
 * real Cognito engine (`engines/native-cognito.ts`).
 *
 * Ported from B5's `bb-auth-cognito/src/test-support/aws-harness.ts`, so the
 * same scenarios that pin `AuthCognito`'s AWS layer pin `Auth`'s: it is the
 * safety net proving `Auth` behaves like `AuthCognito` against Cognito. Drives
 * the real classes in a plain `npm test` run — no network, no AWS account, no
 * `BLOCKS_INTEGRATION`. Three fakes are wired in:
 *
 *   1. **Cognito SDK** — an `initialize`-step middleware on the engine's real
 *      (lazily created) `CognitoIdentityProviderClient` records every command
 *      (name + exact input) and answers from a per-test responder table. Any
 *      command a test did not expect throws, so an extra Cognito call fails
 *      loudly. Same technique as `bb-kv-store/src/parity.test.ts`.
 *   2. **ID-token verification** — the real `aws-jwt-verify` verifier is kept;
 *      a locally generated RS256 JWKS is pre-loaded with `cacheJwks()`, so
 *      tokens minted by {@link FakeIdp} verify for real (issuer, audience,
 *      `token_use`, signature, expiry) without a JWKS fetch.
 *   3. **Session store + secret** — the nested `KVStore` / `AppSetting` resolve
 *      to their mock entries under default conditions (they persist to
 *      `.bb-data/`). The session `KVStore.put` is wrapped so tests can assert
 *      exactly what was written, including the TTL option.
 *
 * The config keys are set in `process.env` under the names
 * `cognitoConfigKeys(fullId)` derives — exactly how the CDK layer's
 * `registerConfig()` values reach the Lambda — before `Auth` is constructed.
 *
 * Seams used — none added to the runtime: `AuthBase`'s private `native` and
 * `sessions` members, and the engine's private lazy `client` and `verifier`
 * getters. They are reached **only here**, so a refactor that moves them
 * updates this file and nothing else; the `index.aws.*.test.ts` suites assert
 * behaviour, not structure.
 *
 * Not part of the package API — never imported from a runtime entry.
 */

import crypto from 'node:crypto';
import type { ChildLogger } from '@aws-blocks/bb-logger';
import type { BlocksContext, ScopeParent } from '@aws-blocks/core';
import { EventSourceMapping } from '@aws-blocks/core/bb-utils';
import { cognitoConfigKeys, ownsPreSignUpTrigger, preSignUpTriggerConfigKey } from '../cdk/contract.js';
import type { NativeEngine } from '../engines/types.js';
import { Auth } from '../index.aws.js';
import type { AuthOptions } from '../types.js';

export const TEST_REGION = 'us-east-1';
export const TEST_POOL_ID = 'us-east-1_D5cTestPool';
export const TEST_CLIENT_ID = 'd5ctestclientid000000000';
export const ROOT_ID = 'd5c-app';
const ROOT: ScopeParent = { id: ROOT_ID };

// ─────────────────────────────────────────────────────────────────────────────
// Fake Cognito errors
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build an error shaped like an SDK v3 service exception: `name` mirrors the
 * Cognito exception, `$metadata` carries request metadata, `$fault` the side.
 * These are exactly the fields that must never reach a client.
 */
export function cognitoError(name: string, message: string, httpStatusCode = 400): Error {
	const err = new Error(message);
	err.name = name;
	Object.assign(err, {
		$fault: httpStatusCode >= 500 ? 'server' : 'client',
		$metadata: {
			httpStatusCode,
			requestId: 'b5-req-0000-1111-2222',
			extendedRequestId: 'b5-ext-req',
			attempts: 1,
			totalRetryDelay: 0,
		},
		__type: name,
	});
	return err;
}

export interface LogEntry {
	level: 'debug' | 'info' | 'warn' | 'error';
	message: string;
	context?: Record<string, unknown>;
}

/** A `ChildLogger` that records every entry (pass as `options.logger`). */
export function captureLogger(): { logger: ChildLogger; entries: LogEntry[] } {
	const entries: LogEntry[] = [];
	const make = (base: Record<string, unknown>): ChildLogger => {
		const at =
			(level: LogEntry['level']) =>
			(message: string, context?: Record<string, unknown>): void => {
				entries.push({ level, message, context: { ...base, ...context } });
			};
		return {
			debug: at('debug'),
			info: at('info'),
			warn: at('warn'),
			error: at('error'),
			child: (context) => make({ ...base, ...context }),
		};
	};
	return { logger: make({}), entries };
}

// ─────────────────────────────────────────────────────────────────────────────
// Fake IdP: RS256 keypair + JWT minting that the real verifier accepts
// ─────────────────────────────────────────────────────────────────────────────

const KID = 'd5c-test-kid';

function b64url(v: object): string {
	return Buffer.from(JSON.stringify(v)).toString('base64url');
}

export class FakeIdp {
	private readonly privateKey: crypto.KeyObject;
	readonly jwks: { keys: Array<Record<string, unknown>> };
	readonly issuer = `https://cognito-idp.${TEST_REGION}.amazonaws.com/${TEST_POOL_ID}`;

	constructor() {
		const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
		this.privateKey = privateKey;
		this.jwks = { keys: [{ ...publicKey.export({ format: 'jwk' }), kid: KID, alg: 'RS256', use: 'sig' }] };
	}

	/** Sign an arbitrary payload as an RS256 JWT with this IdP's key. */
	sign(payload: Record<string, unknown>, key: crypto.KeyObject = this.privateKey): string {
		const head = b64url({ alg: 'RS256', kid: KID, typ: 'JWT' });
		const body = b64url(payload);
		const sig = crypto.createSign('RSA-SHA256').update(`${head}.${body}`).sign(key).toString('base64url');
		return `${head}.${body}.${sig}`;
	}

	/**
	 * Mint a Cognito-shaped ID token. `claims` override/extend the defaults;
	 * `expInSeconds` is relative to now.
	 */
	idToken(username: string, claims: Record<string, unknown> = {}, expInSeconds = 3600): string {
		const now = Math.floor(Date.now() / 1000);
		return this.sign({
			sub: `sub-${username}`,
			'cognito:username': username,
			iss: this.issuer,
			aud: TEST_CLIENT_ID,
			token_use: 'id',
			auth_time: now,
			iat: now,
			exp: now + expInSeconds,
			jti: crypto.randomUUID(),
			origin_jti: crypto.randomUUID(),
			event_id: crypto.randomUUID(),
			...claims,
		});
	}

	/** Mint a Cognito-shaped access token. Only `exp` is read by the runtime. */
	accessToken(username: string, expInSeconds = 3600): string {
		const now = Math.floor(Date.now() / 1000);
		return this.sign({
			sub: `sub-${username}`,
			username,
			client_id: TEST_CLIENT_ID,
			token_use: 'access',
			iss: this.issuer,
			iat: now,
			exp: now + expInSeconds,
			jti: crypto.randomUUID(),
		});
	}

	/** A full `AuthenticationResult` as `InitiateAuth` would return it. */
	authResult(
		username: string,
		opts: { claims?: Record<string, unknown>; accessExpIn?: number; refreshToken?: string | null } = {},
	): { IdToken: string; AccessToken: string; RefreshToken?: string; ExpiresIn: number; TokenType: string } {
		return {
			IdToken: this.idToken(username, opts.claims),
			AccessToken: this.accessToken(username, opts.accessExpIn ?? 3600),
			...(opts.refreshToken === null ? {} : { RefreshToken: opts.refreshToken ?? `refresh-${username}` }),
			ExpiresIn: 3600,
			TokenType: 'Bearer',
		};
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Browser: per-request BlocksContext with a real cookie jar
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A cookie-holding client. Each {@link Browser.request} builds a **fresh**
 * `BlocksContext` (one object per HTTP request, as the Lambda handler does —
 * the per-request memo depends on that) carrying the jar's cookies, then
 * applies the response's `Set-Cookie` headers exactly as the Lambda handler
 * emits them (`Headers.getSetCookie()`): `Max-Age=0` deletes, anything else
 * stores. Applied even when the call throws.
 */
export class Browser {
	readonly jar = new Map<string, string>();
	/** `Set-Cookie` lines from the most recent request. */
	lastSetCookies: string[] = [];

	cookieHeader(): string {
		return [...this.jar].map(([k, v]) => `${k}=${v}`).join('; ');
	}

	/** Build a context without running anything (for hand-rolled cookies). */
	context(cookieHeader = this.cookieHeader()): BlocksContext {
		const headers = new Headers();
		if (cookieHeader) headers.set('cookie', cookieHeader);
		let status = 200;
		return {
			request: {
				headers,
				body: null,
				json: async () => ({}),
				text: async () => '',
				url: new URL('https://app.example.com/aws-blocks/api'),
				params: {},
			},
			response: {
				headers: new Headers(),
				get status() {
					return status;
				},
				set status(v: number) {
					status = v;
				},
				send: () => {},
			},
		};
	}

	absorb(ctx: BlocksContext): void {
		this.lastSetCookies = ctx.response.headers.getSetCookie();
		for (const line of this.lastSetCookies) {
			const [pair, ...attrs] = line.split(';').map((s) => s.trim());
			const eq = pair.indexOf('=');
			const name = pair.slice(0, eq);
			const value = pair.slice(eq + 1);
			const cleared = attrs.some((a) => a.toLowerCase() === 'max-age=0');
			if (cleared || value === '') this.jar.delete(name);
			else this.jar.set(name, value);
		}
	}

	/** Run one "HTTP request" against the backend. */
	async request<T>(fn: (ctx: BlocksContext) => Promise<T>, ctx: BlocksContext = this.context()): Promise<T> {
		try {
			return await fn(ctx);
		} finally {
			this.absorb(ctx);
		}
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// The AWS auth instance + spies
// ─────────────────────────────────────────────────────────────────────────────

export interface SentCommand {
	name: string;
	input: Record<string, unknown>;
}

type Responder = (input: Record<string, unknown>) => unknown;

export interface SessionWrite {
	key: string;
	value: Record<string, unknown>;
	options: { ttlSeconds?: number } | undefined;
}

export interface AwsAuthHarness<O extends AuthOptions> {
	auth: Auth<O>;
	/** The Cognito engine `Auth` built (for engine-level assertions). */
	engine: NativeEngine;
	fullId: string;
	/** Session cookie name (`auth_<fullId>`). */
	cookieName: string;
	idp: FakeIdp;
	/** Every Cognito command sent, in order. */
	sent: SentCommand[];
	/** Names of commands sent, in order. */
	sentNames(): string[];
	/** Answer `command` (e.g. `'InitiateAuthCommand'`) with `fn(input)` — return output or throw. */
	on(command: string, fn: Responder): void;
	/** Every write to the session `KVStore`, in order. */
	sessionWrites: SessionWrite[];
	/** Read a session record straight from the session store (no cookie). */
	lookupSession(id: string): Promise<Record<string, unknown> | null>;
	/** Delete a session record out-of-band (e.g. reaped by TTL, removed elsewhere). */
	deleteSession(id: string): Promise<void>;
}

let counter = 0;

/**
 * Free the slot core's Lambda event-handler registry keeps for `poolId`'s
 * Cognito trigger, as a fresh Lambda container would have it. Core refuses a
 * second registration for one key (R2-1), and the suites build one `Auth` per
 * test against the same fake pool.
 */
export function freeTriggerSlot(poolId: string): void {
	const handlers: unknown = Reflect.get(globalThis, '__BLOCKS_LAMBDA_EVENT_HANDLERS__');
	if (handlers instanceof Map) handlers.delete(`${EventSourceMapping.COGNITO_USER_POOL}:${poolId}`);
}

/**
 * Set the PreSignUp-trigger flag exactly as the CDK layer's `registerConfig()`
 * would for `options` (set when it wires the trigger, absent otherwise), and
 * free `poolId`'s trigger slot (see {@link freeTriggerSlot}).
 */
export function simulateTriggerConfig(fullId: string, options: AuthOptions | undefined, poolId: string): void {
	const key = preSignUpTriggerConfigKey(fullId);
	if (ownsPreSignUpTrigger(options)) process.env[key] = 'true';
	else delete process.env[key];
	freeTriggerSlot(poolId);
}

/**
 * Construct the AWS `Auth` with its config keys set, a spied SDK client, a
 * locally-keyed JWT verifier, and a spied session store.
 */
export function makeAwsAuth<const O extends AuthOptions = AuthOptions>(options?: O): AwsAuthHarness<O> {
	const id = `auth${++counter}${crypto.randomBytes(3).toString('hex')}`;
	const fullId = `${ROOT_ID}-${id}`;
	const keys = cognitoConfigKeys(fullId);
	process.env[keys.USER_POOL_ID] = TEST_POOL_ID;
	process.env[keys.CLIENT_ID] = TEST_CLIENT_ID;
	process.env[keys.REGION] = TEST_REGION;
	simulateTriggerConfig(fullId, options, TEST_POOL_ID);

	const auth = new Auth<O>(ROOT, id, options);
	if (auth.fullId !== fullId) throw new Error(`harness: expected fullId ${fullId}, got ${auth.fullId}`);
	const engine: NativeEngine | undefined = Reflect.get(auth, 'native');
	if (!engine) throw new Error('harness: this configuration builds no native engine (no user pool)');

	// 1. Cognito SDK spy (reading `client` creates the lazy client).
	const sent: SentCommand[] = [];
	const responders = new Map<string, Responder>();
	const client = Reflect.get(engine, 'client');
	client.middlewareStack.add(
		(_next: unknown, context: { commandName?: string }) => async (args: { input: Record<string, unknown> }) => {
			const name = context.commandName ?? 'UnknownCommand';
			// JSON round-trip: deep-copies (later mutation can't rewrite history) and
			// drops `undefined` members, which the SDK treats as absent anyway — so
			// assertions pin the wire-relevant shape, not incidental `undefined`s.
			sent.push({ name, input: JSON.parse(JSON.stringify(args.input)) });
			const fn = responders.get(name);
			if (!fn) throw new Error(`harness: unexpected Cognito command ${name}`);
			return { output: { $metadata: { httpStatusCode: 200 }, ...((await fn(args.input)) ?? {}) } };
		},
		{ step: 'initialize', name: 'd5c-cognito-intercept', override: true },
	);

	// 2. Real verifier, local JWKS.
	const idp = new FakeIdp();
	Reflect.get(engine, 'verifier').cacheJwks(idp.jwks);

	// 3. Session store spy.
	const sessions = Reflect.get(auth, 'sessions');
	const kv = Reflect.get(sessions, 'kv');
	const sessionWrites: SessionWrite[] = [];
	const origPut = kv.put.bind(kv);
	kv.put = (key: string, value: SessionWrite['value'], opts?: { ttlSeconds?: number }) => {
		sessionWrites.push({ key, value: structuredClone(value), options: opts && { ...opts } });
		return origPut(key, value, opts);
	};

	return {
		auth,
		engine,
		fullId,
		cookieName: `auth_${fullId}`,
		idp,
		sent,
		sentNames: () => sent.map((c) => c.name),
		on: (command, fn) => {
			responders.set(command, fn);
		},
		sessionWrites,
		lookupSession: (sid) => sessions.lookup(sid),
		deleteSession: (sid) => sessions.delete(sid),
	};
}

/** `<sessionId>.<sig>` → `<sessionId>`. */
export function sessionIdOf(cookieValue: string): string {
	return cookieValue.slice(0, cookieValue.lastIndexOf('.'));
}

/** Find the `Set-Cookie` line for `name` among `lines`. */
export function setCookieFor(lines: string[], name: string): string | undefined {
	return lines.find((l) => l.startsWith(`${name}=`));
}

/**
 * The fields of a thrown error that the client can observe on the wire — the
 * same projection `errorResponseFromCatch` (core `rpc.ts`) makes: status as
 * the code, `message`, `data.name`, `data.retriable`.
 */
export function wireView(e: unknown): { code: unknown; message: unknown; name: unknown; retriable: unknown } {
	const o = (e ?? {}) as { status?: unknown; message?: unknown; name?: unknown; retriable?: unknown };
	return { code: o.status ?? 500, message: o.message, name: o.name, retriable: o.retriable === true };
}

/**
 * Sign `username` in through the real `signIn` path (Cognito answers with
 * `result`), leaving the session cookie in `browser`. Clears the spies so the
 * test observes only what happens next. Returns the session id.
 */
export async function signInAs<O extends AuthOptions>(
	h: AwsAuthHarness<O>,
	browser: Browser,
	username: string,
	result: ReturnType<FakeIdp['authResult']> = h.idp.authResult(username),
): Promise<string> {
	h.on('InitiateAuthCommand', () => ({ AuthenticationResult: result }));
	// The wide `Auth` view: these tests exercise password configurations only.
	const auth: Auth = h.auth;
	await browser.request((ctx) => auth.signIn(username, 'Password!1', ctx));
	const cookie = browser.jar.get(h.cookieName);
	if (!cookie) throw new Error('harness: sign-in did not set a session cookie');
	h.sent.length = 0;
	h.sessionWrites.length = 0;
	return sessionIdOf(cookie);
}
