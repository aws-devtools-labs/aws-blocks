// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { AuthOIDCClient, resolveApiBaseOrigin } from './index.browser.js';
import { onAuthChange, type AuthStateApi } from '@aws-blocks/auth-common/ui';

// auth-common's broadcast bus lazily creates a module-level `BroadcastChannel`
// singleton (via getChannel()). Node's real BroadcastChannel keeps the event
// loop alive, which would stop `node --test` from exiting. Swap in a no-op,
// in-process shim (same approach as auth-common/ui.test.ts) before any broadcast
// runs. The same-window delivery we assert on uses window.dispatchEvent, not the
// channel, so an inert channel is sufficient.
class BroadcastChannelShim {
	name: string;
	private listeners: ((event: MessageEvent) => void)[] = [];
	private static channels = new Map<string, BroadcastChannelShim[]>();
	constructor(name: string) {
		this.name = name;
		const group = BroadcastChannelShim.channels.get(name) ?? [];
		group.push(this);
		BroadcastChannelShim.channels.set(name, group);
	}
	postMessage(data: unknown) {
		// BroadcastChannel delivers to OTHER instances with the same name, not self.
		for (const ch of BroadcastChannelShim.channels.get(this.name) ?? []) {
			if (ch !== this) for (const fn of ch.listeners) fn({ data } as MessageEvent);
		}
	}
	addEventListener(_type: string, fn: (event: MessageEvent) => void) { this.listeners.push(fn); }
	removeEventListener(_type: string, fn: (event: MessageEvent) => void) {
		this.listeners = this.listeners.filter((f) => f !== fn);
	}
	close() { /* no-op */ }
}
(globalThis as any).BroadcastChannel = BroadcastChannelShim;

/**
 * Browser-client tests for `AuthOIDCClient.signIn()` redirect-target
 * construction (Phase 8: client PKCE via the hydrated client).
 *
 * The client navigates the real `window`, so these tests stub the minimal
 * browser globals (`window`, `sessionStorage`, `location`) and capture the
 * authorize URL the client would navigate to. We assert the `redirect_uri`
 * it computes — the one thing Phase 8 changed.
 */

const CURRENT_PAGE = 'http://localhost:3000/dashboard';
const AUTHORIZE_URL = 'https://idp.example.com/authorize';

let navigatedTo = '';
let store: Map<string, string>;

function installBrowserGlobals(currentHref: string): void {
	const url = new URL(currentHref);
	const locationStub = {
		get href() { return currentHref; },
		set href(v: string) { navigatedTo = v; },
		origin: url.origin,
		pathname: url.pathname,
		reload() { /* no-op for tests (signOut() calls this) */ },
	};
	store = new Map<string, string>();

	// Back `window` with a real EventTarget so auth-common's broadcastAuthChange()
	// (window.dispatchEvent(new CustomEvent(...))) and onAuthChange()
	// (window.addEventListener(...)) exercise the real same-window event path — no
	// mocks. CustomEvent + BroadcastChannel are Node 22 globals.
	const win = new EventTarget() as EventTarget & { location: typeof locationStub };
	win.location = locationStub;
	(globalThis as any).window = win;
	(globalThis as any).sessionStorage = {
		getItem: (k: string) => store.get(k) ?? null,
		setItem: (k: string, v: string) => { store.set(k, v); },
		removeItem: (k: string) => { store.delete(k); },
	};
	// The client builds `redirect_uri` against window.location.href; some
	// code paths also read the global `location`. Mirror it.
	(globalThis as any).location = locationStub;
}

function clearBrowserGlobals(): void {
	delete (globalThis as any).window;
	delete (globalThis as any).sessionStorage;
	delete (globalThis as any).location;
	navigatedTo = '';
}

/** Build a client with an inlined providerConfig so no network fetch happens. */
function makeClient() {
	return new AuthOIDCClient({
		providers: ['google'],
		providerConfigs: {
			google: {
				authorizeUrl: AUTHORIZE_URL,
				clientId: 'stub-client-id',
				scopes: ['openid', 'email'],
				kind: 'oidc-builtin',
			},
		},
	});
}

/** Pull the `redirect_uri` out of the captured authorize navigation. */
async function captureRedirectUri(action: () => void): Promise<string> {
	action();
	// `signIn` kicks off an async `_signInPKCE`; wait a microtask-ish beat for
	// the navigation to be assigned.
	for (let i = 0; i < 50 && !navigatedTo; i++) await new Promise((r) => setTimeout(r, 2));
	assert.ok(navigatedTo, 'client should have navigated to the authorize URL');
	return new URL(navigatedTo).searchParams.get('redirect_uri') ?? '';
}

describe('resolveApiBaseOrigin', () => {
	test('resolves a relative apiUrl against the page origin (deployed front door)', () => {
		// The single-origin front door writes apiUrl="/aws-blocks/api"; before the
		// fix `new URL("/aws-blocks/api")` threw "Invalid URL".
		assert.strictEqual(
			resolveApiBaseOrigin('/aws-blocks/api', 'https://app.cloudfront.net'),
			'https://app.cloudfront.net',
		);
	});

	test('keeps an absolute apiUrl origin (local/sandbox), ignoring the base', () => {
		assert.strictEqual(
			resolveApiBaseOrigin('http://localhost:3001/aws-blocks/api', 'https://app.cloudfront.net'),
			'http://localhost:3001',
		);
	});
});

describe('AuthOIDCClient.signIn — redirect_uri construction', () => {
	beforeEach(() => { installBrowserGlobals(CURRENT_PAGE); });
	afterEach(() => { clearBrowserGlobals(); });

	test('defaults to the current page (origin + pathname, no query/hash)', async () => {
		const client = makeClient();
		const redirectUri = await captureRedirectUri(() => client.signIn('google'));
		assert.strictEqual(redirectUri, 'http://localhost:3000/dashboard');
	});

	test('honors an absolute redirectPath', async () => {
		const client = makeClient();
		const redirectUri = await captureRedirectUri(() =>
			client.signIn('google', { redirectPath: 'http://localhost:3000/spa-callback' }),
		);
		assert.strictEqual(redirectUri, 'http://localhost:3000/spa-callback');
	});

	test('resolves a relative redirectPath against the current page', async () => {
		const client = makeClient();
		const redirectUri = await captureRedirectUri(() =>
			client.signIn('google', { redirectPath: '/spa-callback' }),
		);
		assert.strictEqual(redirectUri, 'http://localhost:3000/spa-callback');
	});

	test('persists the chosen callbackUrl in the pending blob for the exchange', async () => {
		const client = makeClient();
		await captureRedirectUri(() =>
			client.signIn('google', { redirectPath: '/spa-callback' }),
		);
		const raw = store.get('__blocks_oidc_pending');
		assert.ok(raw, 'pending blob should be stored');
		const pending = JSON.parse(raw!);
		assert.strictEqual(pending.callbackUrl, 'http://localhost:3000/spa-callback');
	});
});

describe('AuthOIDCClient.handleRedirectCallback — return shape', () => {
	const STATE = 'state-123';
	const BARE_USER = { userId: 'iss:sub', username: 'alice', email: 'alice@example.invalid', provider: 'google' };
	let originalFetch: typeof globalThis.fetch;

	beforeEach(() => {
		// The callback page carries the IdP's ?code=&state=.
		installBrowserGlobals(`http://localhost:3000/spa-callback?code=auth-code&state=${STATE}`);
		// Resolve the API base URL deterministically (avoids the config.json
		// fetch path in _getBaseUrl, which our exchange stub would otherwise
		// answer with the wrong body).
		process.env.BLOCKS_API_URL = 'http://localhost:3000/aws-blocks/api';
		// A pending blob matching the returned state (written by signIn earlier).
		store.set('__blocks_oidc_pending', JSON.stringify({
			provider: 'google',
			verifier: 'v',
			state: STATE,
			nonce: 'n',
			callbackUrl: 'http://localhost:3000/spa-callback',
			appState: 'app-state',
		}));
		originalFetch = globalThis.fetch;
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
		delete process.env.BLOCKS_API_URL;
		clearBrowserGlobals();
	});

	/** Stub fetch so /aws-blocks/auth/exchange returns the given body; records the request. */
	let lastExchangeBody: any = null;
	function stubExchange(body: unknown): void {
		lastExchangeBody = null;
		globalThis.fetch = (async (_url: any, init?: any) => {
			if (init?.body) lastExchangeBody = JSON.parse(init.body);
			return { ok: true, json: async () => body };
		}) as unknown as typeof globalThis.fetch;
	}

	test('unwraps the cookie-mode { user } wrapper to a bare user', async () => {
		stubExchange({ user: BARE_USER });
		const client = makeClient();
		const result = await client.handleRedirectCallback();
		assert.ok(result, 'should resolve a user');
		assert.strictEqual(result!.userId, 'iss:sub');
		assert.strictEqual((result as any).username, 'alice');
		// Must NOT be the wrapper.
		assert.strictEqual((result as any).user, undefined);
	});

	test('unwraps the bearer-mode { user, accessToken } wrapper too', async () => {
		stubExchange({ user: BARE_USER, accessToken: 'at', refreshToken: 'rt', expiresIn: 3600 });
		const client = makeClient();
		const result = await client.handleRedirectCallback();
		assert.strictEqual(result!.userId, 'iss:sub');
		assert.strictEqual((result as any).user, undefined);
	});

	test('onAuthStateChange subscribers receive the bare user, not the wrapper', async () => {
		stubExchange({ user: BARE_USER });
		const client = makeClient();
		let received: any = 'unset';
		client.onAuthStateChange((u) => { received = u; });
		await client.handleRedirectCallback();
		assert.ok(received && received !== 'unset', 'subscriber should have been notified');
		assert.strictEqual(received.username, 'alice');
		assert.strictEqual(received.user, undefined);
	});

	test('forwards RFC 9207 iss from the callback URL to /aws-blocks/auth/exchange', async () => {
		// Re-install the page with an iss param (Google/RFC 9207).
		installBrowserGlobals(
			`http://localhost:3000/spa-callback?code=auth-code&state=${STATE}&iss=https://accounts.google.com`,
		);
		store.set('__blocks_oidc_pending', JSON.stringify({
			provider: 'google', verifier: 'v', state: STATE, nonce: 'n',
			callbackUrl: 'http://localhost:3000/spa-callback',
		}));
		stubExchange({ user: BARE_USER });
		const client = makeClient();
		await client.handleRedirectCallback();
		assert.ok(lastExchangeBody, 'exchange should have been called');
		assert.strictEqual(lastExchangeBody.iss, 'https://accounts.google.com');
	});

	test('omits iss from /aws-blocks/auth/exchange when the callback URL has none', async () => {
		stubExchange({ user: BARE_USER });
		const client = makeClient();
		await client.handleRedirectCallback();
		assert.ok(lastExchangeBody, 'exchange should have been called');
		assert.strictEqual('iss' in lastExchangeBody, false, 'iss should be omitted, not sent as undefined');
	});
});

/**
 * Fix (a): `signIn()` was fire-and-forget (`void this._signInPKCE(...)`), so a
 * failed authorize-params fetch was swallowed and callers couldn't react. It now
 * returns the in-flight promise (awaitable / `.catch`-able) while still logging
 * failures for fire-and-forget callers.
 */
describe('AuthOIDCClient.signIn — surfaces errors instead of swallowing them', () => {
	let originalFetch: typeof globalThis.fetch;

	beforeEach(() => {
		installBrowserGlobals(CURRENT_PAGE);
		// Resolve _getBaseUrl() deterministically so the authorize-params fetch is
		// the only network call under test.
		process.env.BLOCKS_API_URL = 'http://localhost:3000/aws-blocks/api';
		originalFetch = globalThis.fetch;
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
		delete process.env.BLOCKS_API_URL;
		clearBrowserGlobals();
	});

	/** Client WITHOUT inlined providerConfigs → signIn hits the authorize-params fetch path. */
	function makeNetworkClient() {
		return new AuthOIDCClient({ providers: ['google'] });
	}

	test('returns a Promise that REJECTS when the authorize-params fetch fails', async () => {
		globalThis.fetch = (async () => ({ ok: false, status: 500, json: async () => ({}) })) as unknown as typeof globalThis.fetch;
		const client = makeNetworkClient();
		// signIn logs the failure for fire-and-forget callers; silence it for clean test output.
		const origError = console.error;
		console.error = () => {};
		try {
			await assert.rejects(
				client.signIn('google'),
				/failed to fetch authorize params for 'google': 500/,
			);
		} finally {
			console.error = origError;
		}
	});

	test('the returned Promise is awaitable and resolves once it navigates to the IdP', async () => {
		// providerConfigs path → no fetch; just computes PKCE and navigates.
		const client = makeClient();
		await client.signIn('google');
		assert.ok(navigatedTo.startsWith(AUTHORIZE_URL), 'should have navigated to the IdP authorize URL');
	});
});

/**
 * Fix (b): `handleRedirectCallback()` consumed the single-use PKCE state only
 * AFTER the exchange await, so a React StrictMode double-mount replayed the
 * single-use `code` and the second exchange threw — stranding the app. It is now
 * idempotent: the in-flight (or settled) exchange is reused per `code`.
 */
describe('AuthOIDCClient.handleRedirectCallback — idempotent under double invocation (StrictMode)', () => {
	const STATE = 'state-idem';
	const BARE_USER = { userId: 'iss:sub', username: 'bob', email: 'bob@example.invalid', provider: 'google' };
	let originalFetch: typeof globalThis.fetch;
	let exchangeCalls: number;

	beforeEach(() => {
		installBrowserGlobals(`http://localhost:3000/spa-callback?code=auth-code-idem&state=${STATE}`);
		process.env.BLOCKS_API_URL = 'http://localhost:3000/aws-blocks/api';
		store.set('__blocks_oidc_pending', JSON.stringify({
			provider: 'google', verifier: 'v', state: STATE, nonce: 'n',
			callbackUrl: 'http://localhost:3000/spa-callback', appState: 'app-state',
		}));
		originalFetch = globalThis.fetch;
		exchangeCalls = 0;
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
		delete process.env.BLOCKS_API_URL;
		clearBrowserGlobals();
	});

	/** Stub the exchange and count how many times the single-use code is sent. */
	function stubCountingExchange(user: unknown): void {
		globalThis.fetch = (async () => {
			exchangeCalls += 1;
			return { ok: true, json: async () => ({ user }) };
		}) as unknown as typeof globalThis.fetch;
	}

	test('concurrent double-invoke exchanges ONCE and both callers get the same user', async () => {
		stubCountingExchange(BARE_USER);
		const client = makeClient();
		const [a, b] = await Promise.all([
			client.handleRedirectCallback(),
			client.handleRedirectCallback(),
		]);
		assert.strictEqual(exchangeCalls, 1, 'the single-use authorization code must not be replayed');
		assert.ok(a && b, 'both invocations resolve a user (the first flow completes and renders)');
		assert.strictEqual(a!.userId, 'iss:sub');
		assert.strictEqual(a, b, 'both callers observe the identical resolved value');
		assert.strictEqual(store.get('__blocks_oidc_pending'), undefined, 'pending PKCE state is consumed');
	});

	test('sequential re-invoke after resolution returns the same user without a second exchange', async () => {
		stubCountingExchange(BARE_USER);
		const client = makeClient();
		const first = await client.handleRedirectCallback();
		const second = await client.handleRedirectCallback();
		assert.strictEqual(exchangeCalls, 1, 'the settled exchange is reused, not replayed');
		assert.ok(first && second);
		assert.strictEqual(first!.userId, second!.userId);
	});

	test('the second invocation never throws (StrictMode safety)', async () => {
		stubCountingExchange(BARE_USER);
		const client = makeClient();
		const p1 = client.handleRedirectCallback();
		const p2 = client.handleRedirectCallback();
		await assert.doesNotReject(Promise.all([p1, p2]));
	});
});

/**
 * Fix (c): the bridge to `@aws-blocks/auth-common`'s `onAuthChange` was unwired —
 * a successful exchange only called the module-local `notify()`. It now also calls
 * `broadcastAuthChange(user)`, so `onAuthChange` / `AuthenticatedContent` /
 * `<Authenticator>` consumers update automatically.
 */
describe('AuthOIDCClient.handleRedirectCallback — bridges to auth-common onAuthChange', () => {
	const STATE = 'state-bcast';
	const BARE_USER = { userId: 'iss:carol', username: 'carol' };
	let originalFetch: typeof globalThis.fetch;

	beforeEach(() => {
		installBrowserGlobals(`http://localhost:3000/spa-callback?code=auth-code-bcast&state=${STATE}`);
		process.env.BLOCKS_API_URL = 'http://localhost:3000/aws-blocks/api';
		store.set('__blocks_oidc_pending', JSON.stringify({
			provider: 'google', verifier: 'v', state: STATE, nonce: 'n',
			callbackUrl: 'http://localhost:3000/spa-callback',
		}));
		originalFetch = globalThis.fetch;
		globalThis.fetch = (async () => ({ ok: true, json: async () => ({ user: BARE_USER }) })) as unknown as typeof globalThis.fetch;
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
		delete process.env.BLOCKS_API_URL;
		clearBrowserGlobals();
	});

	test('a successful exchange notifies real onAuthChange consumers via broadcastAuthChange', async () => {
		// Minimal AuthStateApi for onAuthChange's shared-cache hydration (cold → signedOut).
		const api: AuthStateApi = {
			async getAuthState() { return { state: 'signedOut', actions: [] }; },
			async setAuthState() { return { state: 'signedOut', actions: [] }; },
		};
		const received: Array<{ userId: string } | null> = [];
		const unsub = onAuthChange(api, (user) => { received.push(user as { userId: string } | null); });

		const client = makeClient();
		const user = await client.handleRedirectCallback();
		// Let the broadcast CustomEvent + onAuthChange microtasks flush.
		await new Promise((r) => setTimeout(r, 5));

		assert.ok(user, 'the exchange resolved a user');
		const last = received[received.length - 1];
		assert.ok(last, 'onAuthChange consumer should have been notified via the broadcast');
		assert.strictEqual(last!.userId, 'iss:carol');
		unsub();
	});

	test('dispatches a same-window blocks-auth-change event carrying the exchanged user', async () => {
		// `any` (like `lastExchangeBody` above): the value is only ever assigned
		// inside the listener closure, which TS control-flow can't see.
		let detailUser: any = null;
		const handler = (e: Event) => { detailUser = (e as CustomEvent).detail?.user ?? null; };
		(window as unknown as EventTarget).addEventListener('blocks-auth-change', handler);
		const client = makeClient();
		await client.handleRedirectCallback();
		assert.ok(detailUser, 'broadcastAuthChange should dispatch a same-window CustomEvent');
		assert.strictEqual(detailUser.userId, 'iss:carol');
		(window as unknown as EventTarget).removeEventListener('blocks-auth-change', handler);
	});
});
