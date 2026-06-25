// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { AuthOIDCClient, resolveApiBaseOrigin } from './index.browser.js';

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
let reloaded = false;
let store: Map<string, string>;

/**
 * Cross-tab payloads captured from `BroadcastChannel.postMessage` so tests can
 * assert the OIDC client bridged its sign-in into `@aws-blocks/auth-common`.
 * Cleared (in place — the stub closes over this exact array) on each install.
 */
const broadcasts: unknown[] = [];
let savedBroadcastChannel: unknown;

/**
 * A no-op `BroadcastChannel`. `auth-common`'s `broadcastAuthChange()` lazily
 * opens a real channel via `getChannel()`; a real one is a ref'd libuv handle
 * that keeps `node --test` alive and hangs the run. This records posts instead.
 *
 * `auth-common` caches that channel in a module-level singleton it never resets,
 * so whichever test triggers the first `broadcastAuthChange()` pins the live
 * instance for the rest of the run. Every stub instance posts to the SAME
 * module-level `broadcasts` array (emptied per test in `installBrowserGlobals`),
 * so the captured posts stay correct regardless of which describe block ran
 * first — preserve that shared-array invariant if this stub is refactored.
 */
class StubBroadcastChannel {
	name: string;
	onmessage: ((ev: unknown) => void) | null = null;
	constructor(name: string) { this.name = name; }
	postMessage(msg: unknown): void { broadcasts.push(msg); }
	addEventListener(): void {}
	removeEventListener(): void {}
	close(): void {}
}

function installBrowserGlobals(currentHref: string): void {
	const url = new URL(currentHref);
	const locationStub = {
		get href() { return currentHref; },
		set href(v: string) { navigatedTo = v; },
		origin: url.origin,
		pathname: url.pathname,
		reload() { reloaded = true; },
	};
	store = new Map<string, string>();
	broadcasts.length = 0;
	reloaded = false;

	// Back `window` with a real EventTarget so auth-common's
	// `window.dispatchEvent(new CustomEvent('blocks-auth-change', …))` works and
	// tests can listen for the same-window auth-change event.
	const target = new EventTarget();
	(globalThis as any).window = {
		location: locationStub,
		addEventListener: target.addEventListener.bind(target),
		removeEventListener: target.removeEventListener.bind(target),
		dispatchEvent: target.dispatchEvent.bind(target),
	};
	(globalThis as any).sessionStorage = {
		getItem: (k: string) => store.get(k) ?? null,
		setItem: (k: string, v: string) => { store.set(k, v); },
		removeItem: (k: string) => { store.delete(k); },
	};
	// The client builds `redirect_uri` against window.location.href; some
	// code paths also read the global `location`. Mirror it.
	(globalThis as any).location = locationStub;

	// Swap in the no-op BroadcastChannel before any broadcastAuthChange() call
	// caches a (real) channel instance.
	savedBroadcastChannel = (globalThis as any).BroadcastChannel;
	(globalThis as any).BroadcastChannel = StubBroadcastChannel;
}

function clearBrowserGlobals(): void {
	delete (globalThis as any).window;
	delete (globalThis as any).sessionStorage;
	delete (globalThis as any).location;
	if (savedBroadcastChannel === undefined) delete (globalThis as any).BroadcastChannel;
	else (globalThis as any).BroadcastChannel = savedBroadcastChannel;
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

describe('AuthOIDCClient.handleRedirectCallback — @aws-blocks/auth-common bridge', () => {
	const STATE = 'state-bridge';
	const BARE_USER = { userId: 'iss:sub', username: 'alice', email: 'alice@example.invalid', provider: 'google' };
	let originalFetch: typeof globalThis.fetch;

	beforeEach(() => {
		installBrowserGlobals(`http://localhost:3000/spa-callback?code=auth-code&state=${STATE}`);
		process.env.BLOCKS_API_URL = 'http://localhost:3000/aws-blocks/api';
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

	function stubExchangeOk(body: unknown): void {
		globalThis.fetch = (async () => ({ ok: true, json: async () => body })) as unknown as typeof globalThis.fetch;
	}

	test('dispatches a same-window auth-change event so on-page onAuthChange consumers re-render', async () => {
		stubExchangeOk({ user: BARE_USER });
		// auth-common's broadcastAuthChange() fires a 'blocks-auth-change'
		// CustomEvent on window; onAuthChange listeners on THIS page rely on it.
		let detail: any = null;
		(globalThis as any).window.addEventListener('blocks-auth-change', (e: any) => { detail = e.detail; });

		const client = makeClient();
		const user = await client.handleRedirectCallback();

		assert.ok(user, 'callback should resolve a user');
		assert.ok(detail, 'a blocks-auth-change event should have been dispatched on window');
		assert.strictEqual(detail.type, 'auth-change');
		assert.strictEqual(detail.user.userId, 'iss:sub');
		assert.strictEqual(detail.user.username, 'alice');
	});

	test('posts the signed-in user across tabs via BroadcastChannel', async () => {
		stubExchangeOk({ user: BARE_USER });
		const client = makeClient();
		await client.handleRedirectCallback();

		assert.strictEqual(broadcasts.length, 1, 'exactly one cross-tab post should have been made');
		const msg = broadcasts[0] as any;
		assert.strictEqual(msg.type, 'auth-change');
		assert.strictEqual(msg.user.userId, 'iss:sub');
	});

	test('does NOT broadcast when the callback fails (state mismatch)', async () => {
		stubExchangeOk({ user: BARE_USER });
		// Tamper the stored state so validation throws before any exchange.
		store.set('__blocks_oidc_pending', JSON.stringify({
			provider: 'google', verifier: 'v', state: 'a-different-state', nonce: 'n',
			callbackUrl: 'http://localhost:3000/spa-callback',
		}));
		let dispatched = false;
		(globalThis as any).window.addEventListener('blocks-auth-change', () => { dispatched = true; });

		const client = makeClient();
		await assert.rejects(() => client.handleRedirectCallback(), /state mismatch/);

		assert.strictEqual(dispatched, false, 'no auth-change event on a failed callback');
		assert.strictEqual(broadcasts.length, 0, 'no cross-tab post on a failed callback');
	});
});

describe('AuthOIDCClient.signOut — @aws-blocks/auth-common bridge', () => {
	let originalFetch: typeof globalThis.fetch;

	beforeEach(() => {
		installBrowserGlobals('http://localhost:3000/dashboard');
		process.env.BLOCKS_API_URL = 'http://localhost:3000/aws-blocks/api';
		originalFetch = globalThis.fetch;
		// The /aws-blocks/auth/signout POST just needs to resolve OK.
		globalThis.fetch = (async () => ({ ok: true, json: async () => ({}) })) as unknown as typeof globalThis.fetch;
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
		delete process.env.BLOCKS_API_URL;
		clearBrowserGlobals();
	});

	test('posts a signed-out (null) user across tabs via BroadcastChannel', async () => {
		const client = makeClient();
		await client.signOut();

		assert.strictEqual(broadcasts.length, 1, 'exactly one cross-tab post should have been made');
		const msg = broadcasts[0] as any;
		assert.strictEqual(msg.type, 'auth-change');
		assert.strictEqual(msg.user, null, 'sign-out broadcasts a null user so other tabs re-render');
	});

	test('dispatches a same-window auth-change(null) event before reloading', async () => {
		// Other tabs rely on the cross-tab post above; same-tab onAuthChange
		// consumers rely on this same-window event. The page then reloads.
		let detail: any = 'unset';
		(globalThis as any).window.addEventListener('blocks-auth-change', (e: any) => { detail = e.detail; });

		const client = makeClient();
		await client.signOut();

		assert.notStrictEqual(detail, 'unset', 'a blocks-auth-change event should have been dispatched on window');
		assert.strictEqual(detail.type, 'auth-change');
		assert.strictEqual(detail.user, null);
		assert.strictEqual(reloaded, true, 'signOut should reload the page after broadcasting');
	});
});
