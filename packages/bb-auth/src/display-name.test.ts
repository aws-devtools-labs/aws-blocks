// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * `AuthState.user.displayName` (D7b): what the sign-in UI shows the signed-in
 * user. On a pool whose users sign in with their email or phone, `username`
 * is a generated id equal to `userSub`, so the UI would otherwise show a UUID.
 *
 * `AuthState` is returned by the public, unauthenticated `getAuthState` RPC:
 * the display value must appear only in the caller's own signed-in state,
 * never in a signed-out or mid-flow (sign-up confirmation, sign-in challenge)
 * state.
 */

import assert from 'node:assert';
import { rmSync } from 'node:fs';
import { after, afterEach, before, beforeEach, describe, test } from 'node:test';
import type { AuthActionInput, AuthState, AuthStateApi } from '@aws-blocks/auth-common';
import { type BlocksContext, clearRouteRegistry } from '@aws-blocks/core';
import { Auth, stubIdp } from './index.mock.js';
import { displayNameOf } from './state-machine.js';
import { Browser } from './test-helpers.js';
import { location, type RouteServer, startRouteServer, TestBrowser } from './test-support/route-server.js';
import type { StubUser } from './types.js';

beforeEach(() => rmSync('.bb-data', { recursive: true, force: true }));
afterEach(() => rmSync('.bb-data', { recursive: true, force: true }));

const PASSWORD = 'Passw0rd!';

/** Bind the namespace to one request, the way the RPC layer does. */
function bind(api: AuthStateApi, ctx: BlocksContext): AuthStateApi {
	const target: unknown = api;
	assert.ok(typeof target === 'function');
	const handler: unknown = Reflect.apply(target, undefined, [ctx]);
	assert.ok(typeof handler === 'object' && handler !== null);
	const getAuthState: unknown = Reflect.get(handler, 'getAuthState');
	const setAuthState: unknown = Reflect.get(handler, 'setAuthState');
	assert.ok(typeof getAuthState === 'function' && typeof setAuthState === 'function');
	return {
		getAuthState: () => Reflect.apply(getAuthState, handler, []),
		setAuthState: (input: AuthActionInput) => Reflect.apply(setAuthState, handler, [input]),
	};
}

let apps = 0;

/** A fresh block (own local pool) and browser driving `auth.createApi()`, with the delivered codes. */
function app(options: ConstructorParameters<typeof Auth>[2]) {
	const codes: string[] = [];
	const auth = new Auth({ id: `dn${process.pid}-${++apps}` }, 'auth', {
		...options,
		codeDelivery: async (_username, code) => {
			codes.push(code);
		},
	});
	const api = auth.createApi();
	const b = new Browser();
	const call = (fn: (a: AuthStateApi) => Promise<AuthState>) => b.request((ctx) => fn(bind(api, ctx)));
	const lastCode = () => {
		const code = codes.at(-1);
		assert.ok(code, 'a code was delivered');
		return code;
	};
	return { auth, call, lastCode };
}

/** Sign up through the state machine and land signed in; returns every state on the way. */
async function signUpThroughUi(
	h: ReturnType<typeof app>,
	input: { username: string; email?: string; phone_number?: string },
): Promise<{ midFlow: AuthState[]; signedIn: AuthState }> {
	const midFlow: AuthState[] = [];
	midFlow.push(await h.call((a) => a.getAuthState()));
	midFlow.push(await h.call((a) => a.setAuthState({ action: 'signUp', password: PASSWORD, ...input })));
	midFlow.push(
		await h.call((a) => a.setAuthState({ action: 'confirmSignUp', username: input.username, code: h.lastCode() })),
	);
	const signedIn = await h.call((a) => a.setAuthState({ action: 'autoSignIn', username: input.username }));
	return { midFlow, signedIn };
}

function assertNoUser(state: AuthState, label: string): void {
	assert.strictEqual(state.user, undefined, `${label}: no user`);
	assert.ok(!JSON.stringify(state).includes('displayName'), `${label}: no displayName anywhere`);
}

describe('displayNameOf', () => {
	const base = { userSub: 'sub-1', attributes: {} };

	test('an email + password user who chose a username keeps it, even with an email alias', () => {
		assert.strictEqual(
			displayNameOf({
				...base,
				username: 'alice',
				signInProvider: 'password',
				attributes: { email: 'alice@example.com' },
			}),
			'alice',
		);
	});

	test('email-only pool: the generated username (= userSub) is replaced by the email', () => {
		assert.strictEqual(
			displayNameOf({
				username: 'sub-1',
				userSub: 'sub-1',
				signInProvider: 'password',
				attributes: { email: 'alice@example.com', email_verified: 'true' },
			}),
			'alice@example.com',
		);
	});

	test('phone-only pool: the phone number', () => {
		assert.strictEqual(
			displayNameOf({
				username: 'sub-1',
				userSub: 'sub-1',
				signInProvider: 'password',
				attributes: { phone_number: '+15555550100' },
			}),
			'+15555550100',
		);
	});

	test('an email the pool marks unverified is skipped', () => {
		assert.strictEqual(
			displayNameOf({
				username: 'sub-1',
				userSub: 'sub-1',
				signInProvider: 'password',
				attributes: { email: 'old@example.com', email_verified: 'false', phone_number: '+15555550100' },
			}),
			'+15555550100',
		);
	});

	test('the ID token’s boolean flags (`verified`) decide, and win over a string flag in `attributes` (FX31)', () => {
		const user = {
			username: 'sub-1',
			userSub: 'sub-1',
			signInProvider: 'password',
			attributes: { email: 'new@example.com', phone_number: '+15555550100', preferred_username: 'ali' },
		};
		assert.strictEqual(displayNameOf({ ...user, verified: { email: true } }), 'new@example.com');
		assert.strictEqual(displayNameOf({ ...user, verified: { email: false } }), '+15555550100');
		assert.strictEqual(displayNameOf({ ...user, verified: { email: false, phone_number: false } }), 'ali');
		assert.strictEqual(displayNameOf({ ...user, verified: {} }), 'new@example.com', 'no flag: not skipped');
		assert.strictEqual(
			displayNameOf({
				...user,
				attributes: { ...user.attributes, email_verified: 'false' },
				verified: { email: true },
			}),
			'new@example.com',
			'the ID token wins',
		);
	});

	test('a hosted-UI federated user (`Google_…`) shows their email; then preferred_username; then the username', () => {
		assert.strictEqual(
			displayNameOf({
				...base,
				username: 'Google_1098',
				signInProvider: 'google',
				attributes: { email: 'alice@gmail.com', preferred_username: 'ali' },
			}),
			'alice@gmail.com',
		);
		assert.strictEqual(
			displayNameOf({
				...base,
				username: 'Google_1098',
				signInProvider: 'google',
				attributes: { preferred_username: 'ali' },
			}),
			'ali',
		);
		assert.strictEqual(
			displayNameOf({ ...base, username: 'Google_1098', signInProvider: 'google' }),
			'Google_1098',
		);
	});

	test('a directly federated OIDC user shows their email, else their username (the name / subject)', () => {
		assert.strictEqual(
			displayNameOf({
				username: 'Alice Smith',
				userSub: 'https://idp.example.com:u-1',
				signInProvider: 'corp',
				attributes: { email: 'alice@corp.example.com', name: 'Alice Smith' },
			}),
			'alice@corp.example.com',
		);
		assert.strictEqual(
			displayNameOf({
				username: 'Alice Smith',
				userSub: 'https://idp.example.com:u-1',
				signInProvider: 'corp',
				attributes: { name: 'Alice Smith' },
			}),
			'Alice Smith',
		);
	});
});

describe('AuthState.user.displayName through createApi() (local pool)', () => {
	test('email-only pool: the signed-in state shows the email, not the generated username', async () => {
		const h = app({ users: { signInWith: ['email'] } });
		const { midFlow, signedIn } = await signUpThroughUi(h, { username: 'alice@example.com' });
		assert.strictEqual(signedIn.state, 'signedIn');
		assert.ok(signedIn.user);
		assert.notStrictEqual(signedIn.user.username, 'alice@example.com', 'the username is a generated id');
		assert.strictEqual(signedIn.user.displayName, 'alice@example.com');
		const again = await h.call((a) => a.getAuthState());
		assert.strictEqual(again.user?.displayName, 'alice@example.com');
		for (const [i, s] of midFlow.entries()) assertNoUser(s, `state ${i} (${s.state})`);
	});

	test('username + email-alias pool (the default): the chosen username', async () => {
		const h = app({});
		const { signedIn } = await signUpThroughUi(h, { username: 'alice', email: 'alice@example.com' });
		assert.strictEqual(signedIn.user?.username, 'alice');
		assert.strictEqual(signedIn.user?.displayName, 'alice');
	});

	test('phone-only pool: the phone number', async () => {
		const h = app({ users: { signInWith: ['phone'] } });
		const { signedIn } = await signUpThroughUi(h, { username: '+15555550100' });
		assert.strictEqual(signedIn.user?.displayName, '+15555550100');
	});

	test('signed out, after sign-out, and a sign-in challenge carry no user and no display value', async () => {
		const h = app({ users: { signInWith: ['email'] }, mfa: { mode: 'required', types: ['TOTP'] } });
		const { signedIn } = await signUpThroughUi(h, { username: 'alice@example.com' });
		// Required MFA with nothing enrolled: the auto sign-in stops at TOTP setup.
		assertNoUser(signedIn, `after sign-up (${signedIn.state})`);
		assert.strictEqual(signedIn.state, 'confirmingSignIn');

		const fresh = app({ users: { signInWith: ['email'] } });
		assertNoUser(await fresh.call((a) => a.getAuthState()), 'a new visitor');

		const other = app({ users: { signInWith: ['email'] } });
		await signUpThroughUi(other, { username: 'bob@example.com' });
		const out = await other.call((a) => a.setAuthState({ action: 'signOut' }));
		assertNoUser(out, 'after sign-out');
		assertNoUser(await other.call((a) => a.getAuthState()), 'signed out again');
		const challenge = await other.call((a) =>
			a.setAuthState({ action: 'signIn', username: 'bob@example.com', password: 'wrong' }),
		);
		assertNoUser(challenge, 'a failed sign-in');
	});
});

describe('AuthState.user.displayName for a directly federated OIDC user (FX31)', () => {
	let server: RouteServer;
	before(async () => {
		server = await startRouteServer();
	});
	after(async () => {
		await server.close();
	});
	beforeEach(() => clearRouteRegistry());

	/** Sign `user` in through the stub IdP over real HTTP; the signed-in `getAuthState`. */
	async function directSignIn(user: StubUser): Promise<AuthState> {
		const auth = new Auth({ id: `dn${process.pid}-${++apps}` }, 'auth', {
			emailPassword: false,
			oidcProviders: { corp: stubIdp({ users: [user], onAuthorize: (r) => r.users[0] }) },
		});
		const b = new TestBrowser();
		const start = await b.fetch(`${server.origin}/aws-blocks/auth/signin/corp`);
		const toCallback = await b.fetch(location(start, server.origin));
		await b.fetch(location(toCallback, server.origin));
		return bind(auth.createApi(), b.context(server.origin)).getAuthState();
	}

	// The IdP's ID token carries `email_verified` as a JSON boolean (OIDC Core §5.1),
	// so it is not a string attribute; the display name reads it from the token.
	test('an email the IdP marks verified (boolean `true`) is shown', async () => {
		const state = await directSignIn({ sub: 'u-1', email: 'alice@corp.example.com', name: 'Alice' });
		assert.strictEqual(state.user?.displayName, 'alice@corp.example.com');
	});

	test('an email the IdP marks unverified (boolean `false`) is skipped: the name', async () => {
		const state = await directSignIn({
			sub: 'u-1',
			email: 'alice@corp.example.com',
			name: 'Alice',
			extra: { email_verified: false },
		});
		assert.strictEqual(state.user?.username, 'Alice');
		assert.strictEqual(state.user?.displayName, 'Alice');
	});

	test('an IdP that sends the flag as the string "false" is honoured too', async () => {
		const state = await directSignIn({
			sub: 'u-1',
			email: 'alice@corp.example.com',
			name: 'Alice',
			extra: { email_verified: 'false' },
		});
		assert.strictEqual(state.user?.displayName, 'Alice');
	});
});
