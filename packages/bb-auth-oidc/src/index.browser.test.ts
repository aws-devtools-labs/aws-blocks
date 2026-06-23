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
		// Discard the synchronous fire-on-subscribe (carries the module-level
		// lastUser from earlier tests); we only care about callback-driven notifies.
		notifyCount = 0;

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
		assert.strictEqual(notifyCount, 1, 'subscribers should be notified exactly once');
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
});
