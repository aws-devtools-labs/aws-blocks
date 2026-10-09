// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Test-only fakes for `AuthBase`: a request context, a browser cookie jar, an
 * in-memory user pool behind the {@link NativeEngine} contract, a scriptable
 * {@link FederationEngine}, and a recording logger. Never imported by an entry
 * point.
 *
 * @internal
 */

import type { ChildLogger } from '@aws-blocks/bb-logger';
import type { BlocksContext, ScopeParent } from '@aws-blocks/core';
import { AuthBase, defineAuthLayer } from './auth-base.js';
import type {
	AuthLayer,
	FederatedIdentity,
	FederationEngine,
	NativeAdminEngine,
	NativeEngine,
	NativeSignInOutcome,
	PoolTokens,
	ResolvedProvider,
} from './engines/types.js';
import type { AuthOptions, PasskeyDescription, SignInNextStep } from './types.js';

export const TEST_SECRET = 'test-session-secret-0123456789abcdef';

// ─────────────────────────────────────────────────────────────────────────────
// Context + browser
// ─────────────────────────────────────────────────────────────────────────────

/** A minimal `BlocksContext` for a request carrying `cookie`. */
export function makeContext(cookie?: string, host = 'app.example.com'): BlocksContext {
	const headers = new Headers({ host });
	if (cookie) headers.set('cookie', cookie);
	return {
		request: {
			headers,
			body: null,
			json: async () => ({}),
			text: async () => '',
			url: new URL(`https://${host}/aws-blocks/api`),
			params: {},
		},
		response: { headers: new Headers(), status: 200, send: () => {} },
	};
}

/** A cookie jar that applies `Set-Cookie` the way a browser would. */
export class Browser {
	readonly jar = new Map<string, string>();
	lastSetCookies: string[] = [];

	cookieHeader(): string | undefined {
		if (this.jar.size === 0) return undefined;
		return [...this.jar].map(([k, v]) => `${k}=${v}`).join('; ');
	}

	/** Run `fn` as one request; apply its `Set-Cookie` lines even when it throws (A1c). */
	async request<T>(fn: (ctx: BlocksContext) => Promise<T>): Promise<T> {
		const ctx = makeContext(this.cookieHeader());
		try {
			return await fn(ctx);
		} finally {
			this.apply(ctx);
		}
	}

	apply(ctx: BlocksContext): void {
		this.lastSetCookies = ctx.response.headers.getSetCookie();
		for (const line of this.lastSetCookies) {
			const [pair] = line.split(';');
			const eq = pair.indexOf('=');
			const name = pair.slice(0, eq);
			const value = pair.slice(eq + 1);
			if (/Max-Age=0(?:;|$)/.test(line) || value === '') this.jar.delete(name);
			else this.jar.set(name, value);
		}
	}
}

/** The `Set-Cookie` line for `name`, if any. */
export function setCookieFor(lines: readonly string[], name: string): string | undefined {
	return lines.find((l) => l.startsWith(`${name}=`));
}

// ─────────────────────────────────────────────────────────────────────────────
// Tokens
// ─────────────────────────────────────────────────────────────────────────────

/** An unsigned JWT-shaped token (what the mocks mint; the session layer only decodes). */
export function jwt(payload: Record<string, unknown>): string {
	const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
	return `${b64({ alg: 'none', typ: 'JWT' })}.${b64(payload)}.sig`;
}

/** Cognito-shaped tokens for `username`. */
export function poolTokens(
	username: string,
	opts: {
		sub?: string;
		groups?: string[];
		accessExpIn?: number;
		authTime?: number;
		attributes?: Record<string, string>;
	} = {},
): PoolTokens {
	const now = Math.floor(Date.now() / 1000);
	const sub = opts.sub ?? `sub-${username}`;
	return {
		idToken: jwt({
			sub,
			'cognito:username': username,
			'cognito:groups': opts.groups ?? [],
			token_use: 'id',
			auth_time: opts.authTime ?? now,
			iat: now,
			exp: now + 3600,
			...opts.attributes,
		}),
		accessToken: jwt({ sub, username, token_use: 'access', exp: now + (opts.accessExpIn ?? 3600) }),
		refreshToken: `refresh-${username}`,
	};
}

/** Build an error shaped like an AWS SDK v3 service exception. */
export function sdkError(name: string, message: string, httpStatusCode = 400): Error {
	const err = new Error(message);
	err.name = name;
	Object.assign(err, {
		$fault: httpStatusCode >= 500 ? 'server' : 'client',
		$metadata: { httpStatusCode, requestId: 'req-0000-1111', attempts: 1, totalRetryDelay: 0 },
		__type: name,
	});
	return err;
}

// ─────────────────────────────────────────────────────────────────────────────
// Fake native engine (an in-memory user pool)
// ─────────────────────────────────────────────────────────────────────────────

interface FakeUser {
	password: string;
	sub: string;
	confirmed: boolean;
	disabled: boolean;
	attributes: Record<string, string>;
}

/** A member the fake does not model: rejects, naming itself, so a test that reaches it fails loudly. */
function unmodelled(method: string): () => Promise<never> {
	return () => Promise.reject(new Error(`FakeNativeEngine does not model ${method}`));
}

/**
 * An in-memory pool behind the `NativeEngine` contract, recording every call.
 * It models the sign-in core; the account and admin members reject (the real
 * engines' suites cover them: `native-mock.test.ts`, `index.aws.*.test.ts`).
 */
export class FakeNativeEngine implements NativeEngine {
	readonly getUserAttributes = unmodelled('getUserAttributes');
	readonly updateUserAttributes = unmodelled('updateUserAttributes');
	readonly confirmUserAttribute = unmodelled('confirmUserAttribute');
	readonly sendUserAttributeVerificationCode = unmodelled('sendUserAttributeVerificationCode');
	readonly deleteUser = unmodelled('deleteUser');
	readonly setUpTotp = unmodelled('setUpTotp');
	readonly verifyTotpSetup = unmodelled('verifyTotpSetup');
	readonly updateMfaPreference = unmodelled('updateMfaPreference');
	readonly getMfaPreference = unmodelled('getMfaPreference');
	readonly listDevices = unmodelled('listDevices');
	readonly rememberDevice = unmodelled('rememberDevice');
	readonly forgetDevice = unmodelled('forgetDevice');
	readonly admin: NativeAdminEngine = {
		addUserToGroup: unmodelled('admin.addUserToGroup'),
		removeUserFromGroup: unmodelled('admin.removeUserFromGroup'),
		listUsersInGroup: unmodelled('admin.listUsersInGroup'),
		createUser: unmodelled('admin.createUser'),
		deleteUser: unmodelled('admin.deleteUser'),
		disableUser: unmodelled('admin.disableUser'),
		enableUser: unmodelled('admin.enableUser'),
		resetUserPassword: unmodelled('admin.resetUserPassword'),
		setUserPassword: unmodelled('admin.setUserPassword'),
		getUser: unmodelled('admin.getUser'),
		listUsers: unmodelled('admin.listUsers'),
		globalSignOut: unmodelled('admin.globalSignOut'),
	};
	readonly users = new Map<string, FakeUser>();
	readonly groups = new Map<string, string[]>();
	readonly calls: string[] = [];
	readonly codes = new Map<string, string>();
	/** Lifetime of minted access tokens, in seconds. */
	accessTtl = 3600;
	/** The next `signIn` returns this challenge instead of tokens. */
	nextChallenge?: SignInNextStep;
	/** `listGroups` rejects with this, once. */
	listGroupsError?: Error;
	/** `refresh` rejects with this (transient failure). */
	refreshError?: Error;

	addUser(
		username: string,
		password = 'Passw0rd!',
		groups: string[] = [],
		attributes: Record<string, string> = {},
	): void {
		this.users.set(username, { password, sub: `sub-${username}`, confirmed: true, disabled: false, attributes });
		this.groups.set(username, groups);
	}

	tokensFor(username: string): PoolTokens {
		const u = this.users.get(username);
		return poolTokens(username, {
			sub: u?.sub,
			groups: this.groups.get(username),
			accessExpIn: this.accessTtl,
			attributes: u?.attributes,
		});
	}

	async signUp(input: { username: string; password: string; attributes: Record<string, string> }) {
		this.calls.push(`signUp:${input.username}`);
		if (this.users.has(input.username)) throw sdkError('UsernameExistsException', 'User already exists');
		this.users.set(input.username, {
			password: input.password,
			sub: `sub-${input.username}`,
			confirmed: false,
			disabled: false,
			attributes: input.attributes,
		});
		this.groups.set(input.username, []);
		this.codes.set(input.username, '123456');
		return {
			userConfirmed: false,
			userSub: `sub-${input.username}`,
			codeDeliveryDetails: { destination: 'a***@e***', deliveryMedium: 'EMAIL' as const, attributeName: 'email' },
			bridgeSession: 'bridge-from-signup',
		};
	}

	async confirmSignUp(input: { username: string; code: string; bridgeSession?: string }) {
		this.calls.push(`confirmSignUp:${input.username}:${input.bridgeSession ?? '-'}`);
		const u = this.users.get(input.username);
		if (!u) throw sdkError('UserNotFoundException', 'Username/client id combination not found.');
		if (this.codes.get(input.username) !== input.code) throw sdkError('CodeMismatchException', 'Invalid code');
		u.confirmed = true;
		return { bridgeSession: 'bridge-from-confirm' };
	}

	async resendSignUpCode(username: string): Promise<void> {
		this.calls.push(`resendSignUpCode:${username}`);
	}

	async signIn(input: { username: string; password: string; bridgeSession?: string }): Promise<NativeSignInOutcome> {
		this.calls.push(`signIn:${input.username}:${input.bridgeSession ?? '-'}`);
		const u = this.users.get(input.username);
		if (!u) throw sdkError('UserNotFoundException', 'User does not exist.');
		if (u.disabled) throw sdkError('NotAuthorizedException', 'User is disabled.');
		if (u.password !== input.password) throw sdkError('NotAuthorizedException', 'Incorrect username or password.');
		if (this.nextChallenge) {
			const nextStep = this.nextChallenge;
			this.nextChallenge = undefined;
			return { status: 'continueSignIn', nextStep };
		}
		return { status: 'signedIn', tokens: this.tokensFor(input.username) };
	}

	async confirmSignIn(input: { session: string; response: string }): Promise<NativeSignInOutcome> {
		this.calls.push(`confirmSignIn:${input.session}`);
		const [, username] = input.session.split(':');
		if (input.response !== '000000') throw sdkError('CodeMismatchException', 'Invalid code received for user');
		return { status: 'signedIn', tokens: this.tokensFor(username) };
	}

	async resetPassword(username: string) {
		this.calls.push(`resetPassword:${username}`);
		if (!this.users.has(username))
			throw sdkError('UserNotFoundException', 'Username/client id combination not found.');
		return {
			isPasswordReset: false,
			nextStep: {
				name: 'CONFIRM_RESET_PASSWORD_WITH_CODE' as const,
				codeDeliveryDetails: {
					destination: 'a***@e***',
					deliveryMedium: 'EMAIL' as const,
					attributeName: 'email',
				},
			},
		};
	}

	async confirmResetPassword(input: { username: string; code: string }): Promise<void> {
		this.calls.push(`confirmResetPassword:${input.username}`);
		if (!this.users.has(input.username))
			throw sdkError('UserNotFoundException', 'Username/client id combination not found.');
	}

	async updatePassword(input: { accessToken: string }): Promise<void> {
		this.calls.push(`updatePassword:${input.accessToken.length > 0}`);
	}

	async refresh(tokens: PoolTokens): Promise<PoolTokens | null> {
		this.calls.push('refresh');
		if (this.refreshError) throw this.refreshError;
		const username = tokens.refreshToken.replace(/^refresh-/, '');
		const u = this.users.get(username);
		if (!u || u.disabled) return null;
		return this.tokensFor(username);
	}

	async listGroups(username: string): Promise<string[]> {
		this.calls.push(`listGroups:${username}`);
		if (this.listGroupsError) {
			const e = this.listGroupsError;
			this.listGroupsError = undefined;
			throw e;
		}
		if (!this.users.has(username)) throw sdkError('UserNotFoundException', 'User does not exist.');
		return this.groups.get(username) ?? [];
	}

	async signOut(_tokens: PoolTokens, options: { global: boolean }): Promise<void> {
		this.calls.push(`signOut:${options.global}`);
	}

	async startPasskeyRegistration(): Promise<{ credentialCreationOptions: string }> {
		return { credentialCreationOptions: '{"challenge":"x"}' };
	}
	async completePasskeyRegistration(): Promise<void> {}
	async listPasskeys(): Promise<PasskeyDescription[]> {
		return [{ credentialId: 'cred-1234567890', friendlyName: 'Laptop' }];
	}
	async deletePasskey(): Promise<void> {}
}

// ─────────────────────────────────────────────────────────────────────────────
// Fake federation engine
// ─────────────────────────────────────────────────────────────────────────────

/** A scriptable federation engine for one provider. */
export class FakeFederationEngine implements FederationEngine {
	readonly calls: string[] = [];
	identity?: FederatedIdentity;
	refreshResult: 'same' | 'null' = 'same';
	logoutUrl?: string;

	constructor(readonly provider: ResolvedProvider) {}

	async buildSignInUrl(): Promise<string> {
		this.calls.push('buildSignInUrl');
		return `https://idp.example.com/authorize?client=${this.provider.id}`;
	}
	async completeSignIn(): Promise<FederatedIdentity> {
		this.calls.push('completeSignIn');
		if (!this.identity) throw new Error('no identity scripted');
		return this.identity;
	}
	async refresh(session: Parameters<FederationEngine['refresh']>[0]) {
		this.calls.push(`refresh:${session.kind}`);
		if (this.refreshResult === 'null') return null;
		if (session.kind === 'direct') {
			return { kind: 'direct' as const, record: { ...session.record, expiresAt: Date.now() + 3600_000 } };
		}
		return session;
	}
	async signOut(): Promise<{ logoutUrl?: string }> {
		this.calls.push('signOut');
		return this.logoutUrl ? { logoutUrl: this.logoutUrl } : {};
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Logger + harness
// ─────────────────────────────────────────────────────────────────────────────

export interface LogEntry {
	level: 'debug' | 'info' | 'warn' | 'error';
	message: string;
	context?: Record<string, unknown>;
}

/** A `ChildLogger` that records every entry. */
export function captureLogger(): { logger: ChildLogger; entries: LogEntry[] } {
	const entries: LogEntry[] = [];
	const make = (): ChildLogger => ({
		debug: (message, context) => entries.push({ level: 'debug', message, context }),
		info: (message, context) => entries.push({ level: 'info', message, context }),
		warn: (message, context) => entries.push({ level: 'warn', message, context }),
		error: (message, context) => entries.push({ level: 'error', message, context }),
		child: () => make(),
	});
	return { logger: make(), entries };
}

/** A test `Auth`: `AuthBase` over the fakes. */
export class TestAuth<const O extends AuthOptions = AuthOptions> extends AuthBase<O> {
	completeFederated(ctx: BlocksContext, providerId: string) {
		return this.completeFederatedSignIn(ctx, providerId);
	}
	redirectFor(ctx: BlocksContext) {
		return this.signOutRedirect(ctx);
	}
}

export interface Harness<O extends AuthOptions> {
	auth: TestAuth<O>;
	native: FakeNativeEngine;
	federation: Map<string, FakeFederationEngine>;
	nativeBuilt: boolean;
	cookieName: string;
}

let counter = 0;

/**
 * Build an `AuthBase` over fake engines. Each call uses a fresh root id (so a
 * fresh session table) unless `rootId` is given.
 */
export function makeAuth<const O extends AuthOptions = AuthOptions>(
	options?: O,
	opts: { rootId?: string; id?: string; secret?: string } = {},
): Harness<O> {
	const native = new FakeNativeEngine();
	const federation = new Map<string, FakeFederationEngine>();
	const h: { nativeBuilt: boolean } = { nativeBuilt: false };
	const layer: AuthLayer = {
		sessionSecret: () => async () => opts.secret ?? TEST_SECRET,
		native: () => {
			h.nativeBuilt = true;
			return native;
		},
		federation: (_host, provider) => {
			const engine = new FakeFederationEngine(provider);
			federation.set(provider.id, engine);
			return engine;
		},
	};
	const root: ScopeParent = { id: opts.rootId ?? `t${process.pid}x${++counter}` };
	// One class per harness, so each harness gets its own fake engines.
	class HarnessAuth extends TestAuth<O> {}
	defineAuthLayer(HarnessAuth, layer);
	const auth = new HarnessAuth(root, opts.id ?? 'auth', options);
	return {
		auth,
		native,
		federation,
		get nativeBuilt() {
			return h.nativeBuilt;
		},
		cookieName: `auth_${auth.fullId}`,
	};
}
