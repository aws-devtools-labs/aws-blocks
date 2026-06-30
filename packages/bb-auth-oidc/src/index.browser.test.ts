// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { onAuthChange, broadcastAuthChange } from '@aws-blocks/auth-common/ui';
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
let store: Map<string, string>;

function installBrowserGlobals(currentHref: string): void {
	const url = new URL(currentHref);
	const locationStub = {
		get href() { return currentHref; },
		set href(v: string) { navigatedTo = v; },
		origin: url.origin,
		pathname: url.pathname,
	};
	store = new Map<string, string>();

	(globalThis as any).window = { location: locationStub };
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

describe('AuthOIDCClient.signIn — error propagation', () => {
	let originalFetch: typeof globalThis.fetch;

	beforeEach(() => {
		installBrowserGlobals(CURRENT_PAGE);
		// Resolve the API base URL deterministically (skip the config.json fetch).
		process.env.BLOCKS_API_URL = 'http://localhost:3000/aws-blocks/api';
		originalFetch = globalThis.fetch;
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
		delete process.env.BLOCKS_API_URL;
		clearBrowserGlobals();
	});

	test('returns a promise that rejects when authorize-params discovery fails', async () => {
		// No inlined providerConfig → the client fetches authorize params; make
		// that fetch fail so the PKCE setup throws. Before the fix `signIn` did
		// `void this._signInPKCE(...)`, swallowing this into a silent unhandled
		// rejection that callers could neither await nor catch.
		globalThis.fetch = (async () => ({ ok: false, status: 500, json: async () => ({}) })) as unknown as typeof globalThis.fetch;
		const client = new AuthOIDCClient({ providers: ['google'] });
		await assert.rejects(
			client.signIn('google'),
			/failed to fetch authorize params for 'google': 500/,
			'signIn() must surface the discovery failure to the caller',
		);
		// A failed setup must not have navigated the browser anywhere.
		assert.strictEqual(navigatedTo, '', 'must not navigate to the IdP on failure');
	});

	test('returns a promise that resolves once navigation to the IdP is scheduled', async () => {
		const client = makeClient();
		await assert.doesNotReject(client.signIn('google'), 'happy-path signIn() should resolve');
		assert.ok(navigatedTo.startsWith(AUTHORIZE_URL), 'should have navigated to the IdP');
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

describe('AuthOIDCClient.handleRedirectCallback — idempotency under double invocation', () => {
	const STATE = 'state-dbl';
	const BARE_USER = { userId: 'iss:sub', username: 'alice', email: 'alice@example.invalid', provider: 'google' };
	let originalFetch: typeof globalThis.fetch;

	beforeEach(() => {
		installBrowserGlobals(`http://localhost:3000/spa-callback?code=auth-code-dbl&state=${STATE}`);
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

	test('concurrent double invocation shares one exchange and both resolve to the same user', async () => {
		// React StrictMode mounts → unmounts → mounts, firing the callback effect
		// twice synchronously. Count the exchange POSTs to prove the single-use
		// PKCE code is exchanged exactly once and neither caller is stranded.
		let exchangeCalls = 0;
		globalThis.fetch = (async (_url: any, init?: any) => {
			if (init?.method === 'POST') exchangeCalls++;
			// Settle on a later tick so both calls are genuinely in flight together.
			await new Promise((r) => setTimeout(r, 5));
			return { ok: true, json: async () => ({ user: BARE_USER }) };
		}) as unknown as typeof globalThis.fetch;

		const client = makeClient();
		let notifyCount = 0;
		client.onAuthStateChange(() => { notifyCount++; });
		// onAuthStateChange fires synchronously on subscribe with the last-known
		// state; capture that baseline so the assertion below measures only the
		// callback-driven notify as a delta, independent of cross-test module state.
		const notifyBaseline = notifyCount;

		// Fire twice WITHOUT awaiting the first — the double-mount race.
		const [r1, r2] = await Promise.all([
			client.handleRedirectCallback(),
			client.handleRedirectCallback(),
		]);

		assert.ok(r1, 'first call must resolve a user');
		assert.ok(r2, 'second (concurrent) call must resolve a user — not null/throw');
		assert.strictEqual(r1!.userId, 'iss:sub');
		assert.strictEqual(r2!.userId, 'iss:sub');
		assert.strictEqual(exchangeCalls, 1, 'single-use PKCE code must be exchanged exactly once');
		assert.strictEqual(notifyCount - notifyBaseline, 1, 'callback should notify subscribers exactly once');
		assert.strictEqual(store.get('__blocks_oidc_pending'), undefined, 'pending entry should be consumed');
	});

	test('a sequential double invocation also shares the in-flight result', async () => {
		// Same race, expressed as two calls captured before awaiting either.
		let exchangeCalls = 0;
		globalThis.fetch = (async (_url: any, init?: any) => {
			if (init?.method === 'POST') exchangeCalls++;
			await new Promise((r) => setTimeout(r, 5));
			return { ok: true, json: async () => ({ user: BARE_USER }) };
		}) as unknown as typeof globalThis.fetch;

		const client = makeClient();
		const p1 = client.handleRedirectCallback();
		const p2 = client.handleRedirectCallback();
		const r1 = await p1;
		const r2 = await p2;
		assert.strictEqual(r1!.userId, 'iss:sub');
		assert.strictEqual(r2!.userId, 'iss:sub');
		assert.strictEqual(exchangeCalls, 1, 'only one exchange for the shared in-flight code');
	});

	test('releases the guard after settling so a fresh flow on the same page can run', async () => {
		let exchangeCalls = 0;
		globalThis.fetch = (async (_url: any, init?: any) => {
			if (init?.method === 'POST') exchangeCalls++;
			return { ok: true, json: async () => ({ user: BARE_USER }) };
		}) as unknown as typeof globalThis.fetch;

		const client = makeClient();
		const first = await client.handleRedirectCallback();
		assert.ok(first, 'first flow resolves');
		assert.strictEqual(exchangeCalls, 1);

		// Simulate a brand-new flow (new code/state + freshly stored pending blob).
		installBrowserGlobals('http://localhost:3000/spa-callback?code=auth-code-2&state=state-2');
		process.env.BLOCKS_API_URL = 'http://localhost:3000/aws-blocks/api';
		store.set('__blocks_oidc_pending', JSON.stringify({
			provider: 'google', verifier: 'v', state: 'state-2', nonce: 'n',
			callbackUrl: 'http://localhost:3000/spa-callback',
		}));

		const second = await client.handleRedirectCallback();
		assert.ok(second, 'second independent flow resolves — guard released after the first settled');
		assert.strictEqual(exchangeCalls, 2, 'the second flow runs its own exchange');
	});

	test('error path under concurrent double invocation rejects both callers identically and releases the guard', async () => {
		// The guard must propagate ONE shared rejection to both callers and
		// release on failure. Without this, a refactor that mishandled the shared
		// rejection (stranding the page) or failed to release the guard (blocking
		// a same-page retry) would keep the success-path tests green.
		let exchangeCalls = 0;
		globalThis.fetch = (async (_url: any, init?: any) => {
			if (init?.method === 'POST') exchangeCalls++;
			// Settle on a later tick so both calls are genuinely in flight together.
			await new Promise((r) => setTimeout(r, 5));
			return { ok: false, json: async () => ({ error: 'invalid_grant' }) };
		}) as unknown as typeof globalThis.fetch;

		const client = makeClient();

		// Fire twice WITHOUT awaiting the first; allSettled captures both outcomes.
		const [s1, s2] = await Promise.allSettled([
			client.handleRedirectCallback(),
			client.handleRedirectCallback(),
		]);

		assert.strictEqual(s1.status, 'rejected', 'first call must reject when the exchange fails');
		assert.strictEqual(s2.status, 'rejected', 'second (concurrent) call must reject too — never resolve null');
		// Both callers share the one in-flight promise, so the rejection is the
		// identical Error instance — not two independently-thrown errors.
		const reason1 = (s1 as PromiseRejectedResult).reason;
		const reason2 = (s2 as PromiseRejectedResult).reason;
		assert.strictEqual(reason1, reason2, 'both callers must reject with the identical shared error');
		assert.match(reason1.message, /exchange failed/i);
		assert.strictEqual(exchangeCalls, 1, 'single-use PKCE code must be exchanged exactly once, even on failure');

		// The finally must release the guard on failure: a fresh-code flow on the
		// same page runs its own exchange instead of being blocked by a stale entry.
		installBrowserGlobals('http://localhost:3000/spa-callback?code=auth-code-retry&state=state-retry');
		process.env.BLOCKS_API_URL = 'http://localhost:3000/aws-blocks/api';
		store.set('__blocks_oidc_pending', JSON.stringify({
			provider: 'google', verifier: 'v', state: 'state-retry', nonce: 'n',
			callbackUrl: 'http://localhost:3000/spa-callback',
		}));
		globalThis.fetch = (async (_url: any, init?: any) => {
			if (init?.method === 'POST') exchangeCalls++;
			return { ok: true, json: async () => ({ user: BARE_USER }) };
		}) as unknown as typeof globalThis.fetch;

		const retry = await client.handleRedirectCallback();
		assert.ok(retry, 'a fresh-code flow resolves — the guard was released after the failure');
		assert.strictEqual(retry!.userId, 'iss:sub');
		assert.strictEqual(exchangeCalls, 2, 'the fresh flow runs its own second exchange');
	});
});

describe('AuthOIDCClient.handleRedirectCallback — @aws-blocks/auth-common bridge (#79)', () => {
	// The browser client notifies only its OWN onAuthStateChange subscribers, not
	// auth-common's onAuthChange / <AuthenticatedContent>. The README documents
	// that a SPA must announce a client-PKCE sign-in with broadcastAuthChange().
	// These tests pin that documented wiring against the real auth-common module.
	const STATE = 'state-bridge';
	const BARE_USER = { userId: 'iss:sub', username: 'alice', email: 'alice@example.invalid', provider: 'google' };
	let originalFetch: typeof globalThis.fetch;
	let originalBroadcastChannel: typeof globalThis.BroadcastChannel;

	/**
	 * Install a `window` that is a real `EventTarget` — so broadcastAuthChange's
	 * `dispatchEvent` and onAuthChange's `addEventListener` genuinely wire up —
	 * carrying the `location` the callback reads its `?code=&state=` from.
	 */
	function installEventTargetWindow(href: string): void {
		const url = new URL(href);
		const target = new EventTarget() as EventTarget & { location: unknown };
		(target as any).location = { get href() { return href; }, origin: url.origin, pathname: url.pathname };
		(globalThis as any).window = target;
		(globalThis as any).location = (target as any).location;
		store = new Map<string, string>();
		(globalThis as any).sessionStorage = {
			getItem: (k: string) => store.get(k) ?? null,
			setItem: (k: string, v: string) => { store.set(k, v); },
			removeItem: (k: string) => { store.delete(k); },
		};
	}

	beforeEach(() => {
		// A real BroadcastChannel is a ref'd handle that keeps `node --test` alive;
		// stub it with an in-memory no-op. The same-window delivery path is what we
		// assert, and broadcastAuthChange drives that via a window CustomEvent.
		originalBroadcastChannel = globalThis.BroadcastChannel;
		(globalThis as any).BroadcastChannel = class {
			constructor(public name: string) {}
			postMessage(): void {}
			addEventListener(): void {}
			removeEventListener(): void {}
			close(): void {}
		};
		installEventTargetWindow(`http://localhost:3000/spa-callback?code=auth-code-bridge&state=${STATE}`);
		process.env.BLOCKS_API_URL = 'http://localhost:3000/aws-blocks/api';
		store.set('__blocks_oidc_pending', JSON.stringify({
			provider: 'google', verifier: 'v', state: STATE, nonce: 'n',
			callbackUrl: 'http://localhost:3000/spa-callback', appState: 'app-state',
		}));
		originalFetch = globalThis.fetch;
		globalThis.fetch = (async () => ({ ok: true, json: async () => ({ user: BARE_USER }) })) as unknown as typeof globalThis.fetch;
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
		globalThis.BroadcastChannel = originalBroadcastChannel;
		delete process.env.BLOCKS_API_URL;
		delete (globalThis as any).window;
		delete (globalThis as any).location;
		delete (globalThis as any).sessionStorage;
	});

	/** The minimal AuthStateApi shape that `auth.createApi()` exposes (getAuthState/setAuthState). */
	function makeAuthStateApi() {
		return {
			getAuthState: async () => ({ user: null }),
			setAuthState: async () => ({ user: null }),
		};
	}

	test('the callback alone does NOT reach onAuthChange; broadcastAuthChange(user) does (documented SPA wiring)', async () => {
		const api = makeAuthStateApi();
		const seen: unknown[] = [];
		const unsubscribe = onAuthChange(api as any, (u) => { seen.push(u); });

		const client = makeClient();
		const user = await client.handleRedirectCallback();
		assert.ok(user, 'callback should resolve the signed-in user');
		assert.strictEqual(user!.userId, 'iss:sub');

		// Completing the OIDC exchange notifies only the client's own subscribers —
		// auth-common's onAuthChange consumers must NOT have seen the user yet. This
		// is exactly the gap the README's broadcastAuthChange step closes.
		assert.ok(
			!seen.some((u) => (u as any)?.userId === 'iss:sub'),
			'onAuthChange must not observe the user from handleRedirectCallback alone',
		);

		// The documented step: announce the sign-in.
		broadcastAuthChange(user as any);

		const delivered = seen.find((u) => (u as any)?.userId === 'iss:sub') as any;
		assert.ok(delivered, 'onAuthChange subscriber should receive the user after broadcastAuthChange');
		assert.strictEqual(delivered.username, 'alice');

		unsubscribe();
	});

	test('a failed callback (state mismatch) must not broadcast a phantom sign-in', async () => {
		// Mismatch the pending state so the exchange rejects before any user exists.
		store.set('__blocks_oidc_pending', JSON.stringify({
			provider: 'google', verifier: 'v', state: 'a-different-state', nonce: 'n',
			callbackUrl: 'http://localhost:3000/spa-callback',
		}));
		const api = makeAuthStateApi();
		const seen: unknown[] = [];
		const unsubscribe = onAuthChange(api as any, (u) => { seen.push(u); });

		const client = makeClient();
		await assert.rejects(client.handleRedirectCallback(), /state mismatch/i);

		// No user resolved → the documented `if (user) broadcastAuthChange(user)`
		// guard never fires, so onAuthChange consumers never see a phantom user.
		assert.ok(
			!seen.some((u) => (u as any)?.userId === 'iss:sub'),
			'a rejected callback must not surface a signed-in user to onAuthChange',
		);

		unsubscribe();
	});
});
