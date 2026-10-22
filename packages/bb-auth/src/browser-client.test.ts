// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * `@aws-blocks/bb-auth/browser-client` (L69) — a web frontend on another
 * origin signs in through the block's existing relay transport, then reads
 * `GET <base>/session` and signs out with `POST <base>/signout?format=json`.
 *
 * The same flow runs against the mock runtime (the routes over real HTTP, as
 * the dev server serves them) and the AWS runtime (an in-process HTTPS API
 * Gateway stage), so the two layers cannot drift. The "browser" is a cookie jar
 * plus an in-memory page: storage, address bar and navigations.
 */

import assert from 'node:assert';
import { rmSync } from 'node:fs';
import { after, afterEach, before, beforeEach, describe, test } from 'node:test';
import { BLOCKS_AUTH_PREFIX, clearRouteRegistry, isBlocksError } from '@aws-blocks/core';
import { type AuthClient, createAuthClient } from './browser-client.js';
import { stubIdpConfigKeys } from './cdk/contract.js';
import { AuthErrors } from './errors.js';
import { Auth, relayOrigin, stubIdp } from './index.mock.js';
import { type FakeGateway, installFakeGateway } from './test-support/gateway.js';
import { location, type RouteServer, startRouteServer, TestBrowser } from './test-support/route-server.js';
import type { AuthClientEnvironment, AuthOptions, StubUser } from './types.js';

const { Auth: AwsAuth } = await import('./index.aws.js');

const ALICE: StubUser = { sub: 'u-1', email: 'alice@example.com', name: 'Alice' };
/** The frontend: another origin (loopback http, which the relay always allows). */
const SPA = 'http://127.0.0.1:5173';
const RETURN_PAGE = `${SPA}/app/return`;

/** A page of the frontend: its address bar, its sessionStorage, its navigations. */
class FakePage {
	url = `${SPA}/app`;
	readonly storage = new Map<string, string>();
	readonly navigations: string[] = [];
	readonly replaced: string[] = [];

	constructor(readonly browser: TestBrowser) {}

	env(): AuthClientEnvironment {
		return {
			// A cross-origin fetch from the frontend: its Origin, the browser's cookies.
			fetch: (input, init) => {
				const headers = new Headers(init?.headers);
				headers.set('origin', SPA);
				return this.browser.fetch(input, { ...init, headers });
			},
			storage: {
				getItem: (k) => this.storage.get(k) ?? null,
				setItem: (k, v) => void this.storage.set(k, v),
				removeItem: (k) => void this.storage.delete(k),
			},
			currentUrl: () => this.url,
			navigate: (url) => void this.navigations.push(url),
			replaceUrl: (url) => {
				this.replaced.push(url);
				this.url = url;
			},
		};
	}
}

/** The provider → the block's callback → the relay to the return page. Returns the return-page URL. */
async function walkProvider(b: TestBrowser, authorizeUrl: string, base: string): Promise<string> {
	const toCallback = await b.fetch(authorizeUrl);
	assert.strictEqual(toCallback.status, 302, `the stub answers with a redirect, got ${toCallback.status}`);
	const callback = location(toCallback, base);
	const toApp = await b.fetch(callback);
	assert.strictEqual(toApp.status, 302, `the callback relays, got ${toApp.status}`);
	return location(toApp, base);
}

async function rejects(p: Promise<unknown>, name: string): Promise<void> {
	await assert.rejects(p, (e: unknown) => {
		assert.ok(isBlocksError(e, name), `expected ${name}, got ${e instanceof Error ? `${e.name}: ${e.message}` : e}`);
		return true;
	});
}

/** The runtime under test: where its routes are served, and how to build an `Auth`. */
interface Runtime {
	base: () => string;
	make: (options: AuthOptions) => void;
}

/** The whole suite, against one runtime. */
function browserClientSuite(runtime: Runtime): void {
	const provider = (extra: Parameters<typeof stubIdp>[0] = {}) =>
		stubIdp({ users: [ALICE], onAuthorize: (req) => req.users[0], unsafeAllowDeployed: true, ...extra });

	function setup(options: Partial<AuthOptions> = {}): { page: FakePage; client: AuthClient<'corp'> } {
		runtime.make({ emailPassword: false, oidcProviders: { corp: provider() }, ...options });
		const page = new FakePage(new TestBrowser());
		const client = createAuthClient<'corp'>({
			baseUrl: runtime.base(),
			redirectUri: RETURN_PAGE,
			environment: page.env(),
		});
		return { page, client };
	}

	async function signIn(page: FakePage, client: AuthClient<'corp'>, customState?: string) {
		const navigated = page.navigations.length;
		await client.signInWithRedirect({ provider: 'corp', ...(customState !== undefined ? { customState } : {}) });
		assert.strictEqual(page.navigations.length, navigated + 1, 'navigates to the provider');
		page.url = await walkProvider(page.browser, page.navigations[navigated], runtime.base());
		return client.handleSignInRedirect();
	}

	test('sign-in round trip: provider → the block callback → the return page → exchange → session', async () => {
		const { page, client } = setup();
		assert.deepStrictEqual(await client.fetchAuthSession(), { signedIn: false });

		await client.signInWithRedirect({ provider: 'corp' });
		const authorize = new URL(page.navigations[0]);
		// PKCE S256, the block's own callback as redirect_uri, the signed state.
		assert.strictEqual(authorize.searchParams.get('code_challenge_method'), 'S256');
		assert.ok((authorize.searchParams.get('code_challenge') ?? '').length >= 43);
		assert.strictEqual(authorize.searchParams.get('redirect_uri'), `${runtime.base()}${BLOCKS_AUTH_PREFIX}/callback`);
		assert.ok(authorize.searchParams.get('state')?.includes('.'), 'a signed envelope');
		assert.ok(authorize.searchParams.get('nonce'), 'an OIDC nonce');

		const returnPage = await walkProvider(page.browser, page.navigations[0], runtime.base());
		assert.ok(returnPage.startsWith(`${RETURN_PAGE}?`), `relayed to the return page: ${returnPage}`);
		assert.ok(new URL(returnPage).searchParams.get('code'), 'with the one-time code');
		assert.ok(!/token/i.test(new URL(returnPage).search), 'never a token in the URL');
		page.url = returnPage;

		const result = await client.handleSignInRedirect();
		assert.ok(result);
		assert.strictEqual(result.user.signInProvider, 'corp');
		assert.strictEqual(result.user.attributes.email, 'alice@example.com');
		assert.strictEqual(result.user.displayName, 'alice@example.com', "getAuthState()'s display name");
		assert.ok(!('claims' in result.user) && !('federatedIdentity' in result.user), 'server-only fields stay server-side');
		assert.strictEqual(page.url, RETURN_PAGE, 'the one-time parameters are removed from the address bar');
		assert.strictEqual(page.storage.size, 0, 'the pending sign-in is used up');

		const user = await client.getCurrentUser();
		assert.strictEqual(user.userId, result.user.userId);
		const session = await client.fetchAuthSession();
		assert.ok(session.signedIn && session.user.userSub === result.user.userSub);
	});

	test('customState round-trips; a page without a sign-in response is a no-op', async () => {
		const { page, client } = setup();
		assert.strictEqual(await client.handleSignInRedirect(), null, 'nothing to finish on an ordinary page load');
		const result = await signIn(page, client, '/dashboard?tab=2');
		assert.strictEqual(result?.customState, '/dashboard?tab=2');
	});

	test('signOut ends the session and returns the provider logout URL; endProviderSession navigates to it', async () => {
		const { page, client } = setup();
		await signIn(page, client);
		const out = await client.signOut();
		assert.ok(out.logoutUrl?.startsWith(`${runtime.base()}${BLOCKS_AUTH_PREFIX}/idp/corp/logout`), out.logoutUrl);
		assert.deepStrictEqual(await client.fetchAuthSession(), { signedIn: false });
		await rejects(client.getCurrentUser(), AuthErrors.NotAuthenticated);

		await signIn(page, client);
		const navigated = page.navigations.length;
		const again = await client.signOut({ endProviderSession: true });
		assert.strictEqual(page.navigations.length, navigated + 1, 'navigates to the provider logout');
		assert.strictEqual(page.navigations.at(-1), again.logoutUrl);
	});

	test('a return page off the allowlist is refused before anything leaves the tab', async () => {
		const { page, client } = setup();
		await rejects(
			client.signInWithRedirect({ provider: 'corp', redirectUri: 'https://evil.example/steal' }),
			AuthErrors.InvalidRelay,
		);
		assert.strictEqual(page.navigations.length, 0);
		assert.strictEqual(page.storage.size, 0);
	});

	test('an allow-listed HTTPS origin is accepted', async () => {
		runtime.make({
			emailPassword: false,
			oidcProviders: { corp: provider() },
			redirects: { allowedRelayOrigins: [relayOrigin('https://app.example.com')] },
		});
		const page = new FakePage(new TestBrowser());
		const client = createAuthClient<'corp'>({
			baseUrl: runtime.base(),
			redirectUri: 'https://app.example.com/return',
			environment: page.env(),
		});
		await client.signInWithRedirect({ provider: 'corp' });
		const returnPage = await walkProvider(page.browser, page.navigations[0], runtime.base());
		assert.ok(returnPage.startsWith('https://app.example.com/return?'), returnPage);
	});

	test('a response for another tab, a forged state, or no pending sign-in is refused', async () => {
		const { page, client } = setup();
		await client.signInWithRedirect({ provider: 'corp' });
		const returnPage = await walkProvider(page.browser, page.navigations[0], runtime.base());

		// Another tab (no pending sign-in here).
		const other = new FakePage(page.browser);
		other.url = returnPage;
		const otherClient = createAuthClient({ baseUrl: runtime.base(), environment: other.env() });
		await rejects(otherClient.handleSignInRedirect(), AuthErrors.InvalidCallback);
		assert.ok(!other.url.includes('code='), 'the code is still removed from the address bar');

		// This tab, but a state that is not the one it was given.
		const forged = new URL(returnPage);
		forged.searchParams.set('state', 'e30.forged');
		page.url = forged.toString();
		await rejects(client.handleSignInRedirect(), AuthErrors.InvalidState);
		assert.deepStrictEqual(await client.fetchAuthSession(), { signedIn: false }, 'no session was issued');
	});

	test('a provider refusal surfaces as IdpErrorException, without the provider text', async () => {
		runtime.make({
			emailPassword: false,
			oidcProviders: {
				corp: stubIdp({
					users: [ALICE],
					unsafeAllowDeployed: true,
					onAuthorize: () => {
						throw new Error('no');
					},
				}),
			},
		});
		const page = new FakePage(new TestBrowser());
		const client = createAuthClient<'corp'>({ baseUrl: runtime.base(), redirectUri: RETURN_PAGE, environment: page.env() });
		await client.signInWithRedirect({ provider: 'corp' });
		page.url = await walkProvider(page.browser, page.navigations[0], runtime.base());
		await assert.rejects(client.handleSignInRedirect(), (e: unknown) => {
			assert.ok(isBlocksError(e, AuthErrors.IdpError));
			assert.ok(e instanceof Error && e.message.includes('access_denied') && !e.message.includes('onAuthorize'));
			return true;
		});
	});

	test('an unknown provider is refused', async () => {
		const { page } = setup();
		const untyped = createAuthClient({ baseUrl: runtime.base(), environment: page.env() });
		await rejects(untyped.signInWithRedirect({ provider: 'nope' }), AuthErrors.ProviderNotConfigured);
		assert.strictEqual(page.navigations.length, 0);
	});
}

describe('browser-client — mock runtime (the dev server)', () => {
	let server: RouteServer;
	let n = 0;
	before(async () => {
		server = await startRouteServer();
	});
	after(async () => server.close());
	beforeEach(() => {
		clearRouteRegistry();
		rmSync('.bb-data', { recursive: true, force: true });
	});
	afterEach(() => rmSync('.bb-data', { recursive: true, force: true }));

	browserClientSuite({
		base: () => server.origin,
		make: (options) => {
			clearRouteRegistry();
			new Auth({ id: `bc${process.pid}x${++n}` }, 'auth', options);
		},
	});
});

describe('browser-client — AWS runtime (behind an API Gateway stage)', () => {
	let gw: FakeGateway;
	let n = 0;
	let rootId = '';
	beforeEach(() => {
		clearRouteRegistry();
		rmSync('.bb-data', { recursive: true, force: true });
		gw = installFakeGateway();
	});
	afterEach(() => {
		gw.uninstall();
		delete process.env[stubIdpConfigKeys(`${rootId}-auth`).API_URL];
		rmSync('.bb-data', { recursive: true, force: true });
	});

	browserClientSuite({
		base: () => gw.base,
		make: (options) => {
			clearRouteRegistry();
			rootId = `bcaws${process.pid}x${++n}`;
			process.env[stubIdpConfigKeys(`${rootId}-auth`).API_URL] = gw.apiUrl;
			new AwsAuth({ id: rootId }, 'auth', options);
		},
	});
});

describe('browser-client — defaults', () => {
	test('the default paths are the block defaults (core is not imported in the browser for them)', async () => {
		const page = new FakePage(new TestBrowser());
		const seen: string[] = [];
		const client = createAuthClient({
			baseUrl: 'https://api.example.com/',
			environment: {
				...page.env(),
				fetch: async (input) => {
					seen.push(input);
					return new Response(JSON.stringify({ error: 'Not signed in' }), { status: 401 });
				},
			},
		});
		await client.fetchAuthSession();
		await client.signOut().catch(() => undefined);
		assert.deepStrictEqual(seen, [
			`https://api.example.com${BLOCKS_AUTH_PREFIX}/session`,
			`https://api.example.com${BLOCKS_AUTH_PREFIX}/signout?format=json`,
		]);
	});

	test('outside a browser, using it without an environment says what is missing', async () => {
		const client = createAuthClient();
		await assert.rejects(client.fetchAuthSession(), /location is not available here/);
	});
});
