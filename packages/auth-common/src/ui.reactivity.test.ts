// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Acceptance tests for the client-side auth notifier (`submitAuthAction`) and
 * the public auth-state store (`subscribeAuthState` / `getAuthStateSnapshot`).
 *
 * Each test names the requirement it covers from
 * `docs/design/auth-unification/D7-reactivity-requirements.md` (R1–R17 for
 * `submitAuthAction`, S1–S11 for the store). The Node-only cases (R10, S11)
 * live in `ui.node.test.ts`, which runs without DOM globals.
 */

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Window } from 'happy-dom';
import ts from 'typescript';
import type { AuthAction, AuthState, AuthUser } from './index.js';
import type { AuthActionInput, AuthStateApi } from './ui.js';

// ---------------------------------------------------------------------------
// happy-dom setup — install globals before importing ui.ts
// ---------------------------------------------------------------------------

const window = new Window();

/** Every shim instance the test itself creates (vs. the UI module's one). */
const testOwned = new Set<BroadcastChannelShim>();

// happy-dom doesn't implement BroadcastChannel — a minimal shim that, like the
// real one, delivers to OTHER instances with the same name, never to itself.
class BroadcastChannelShim {
	static channels = new Map<string, BroadcastChannelShim[]>();
	name: string;
	listeners: ((event: MessageEvent) => void)[] = [];
	constructor(name: string) {
		this.name = name;
		const group = BroadcastChannelShim.channels.get(name) ?? [];
		group.push(this);
		BroadcastChannelShim.channels.set(name, group);
	}
	postMessage(data: unknown) {
		for (const ch of BroadcastChannelShim.channels.get(this.name) ?? []) {
			if (ch !== this) {
				for (const fn of [...ch.listeners]) fn({ data } as MessageEvent);
			}
		}
	}
	addEventListener(_type: string, fn: (event: MessageEvent) => void) {
		this.listeners.push(fn);
	}
	removeEventListener(_type: string, fn: (event: MessageEvent) => void) {
		this.listeners = this.listeners.filter((f) => f !== fn);
	}
	close() {}
}

/** A second "tab": a channel instance owned by the test. */
function otherTab(): BroadcastChannelShim {
	const ch = new BroadcastChannelShim('blocks-auth');
	testOwned.add(ch);
	return ch;
}

/** Listeners the UI module has on its own `blocks-auth` channel. */
function moduleChannelListeners(): number {
	return (BroadcastChannelShim.channels.get('blocks-auth') ?? [])
		.filter((ch) => !testOwned.has(ch))
		.reduce((n, ch) => n + ch.listeners.length, 0);
}

Object.assign(globalThis, {
	window,
	document: window.document,
	HTMLElement: window.HTMLElement,
	HTMLFormElement: window.HTMLFormElement,
	HTMLInputElement: window.HTMLInputElement,
	HTMLButtonElement: window.HTMLButtonElement,
	CustomEvent: window.CustomEvent,
	KeyboardEvent: window.KeyboardEvent,
	BroadcastChannel: BroadcastChannelShim,
	Event: window.Event,
});

const { Authenticator, AccountMenuBar, onAuthChange, submitAuthAction, subscribeAuthState, getAuthStateSnapshot } =
	await import('./ui.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const signInAction: AuthAction = {
	name: 'signIn',
	label: 'Sign In',
	fields: [
		{ name: 'username', label: 'Username', type: 'text', required: true },
		{ name: 'password', label: 'Password', type: 'password', required: true },
	],
};

function signedOutState(): AuthState {
	return { state: 'signedOut', actions: [signInAction] };
}

function signedInState(username = 'alice'): AuthState {
	return {
		state: 'signedIn',
		user: { userId: username, username },
		actions: [{ name: 'signOut', label: 'Sign Out', fields: [] }],
	};
}

function confirmSignInState(): AuthState {
	return {
		state: 'confirmingSignIn',
		actions: [
			{
				name: 'confirmSignIn',
				label: 'Confirm Code',
				fields: [
					{ name: 'challenge', label: 'Challenge', type: 'hidden', required: true, defaultValue: 'code' },
					{ name: 'session', label: 'Session', type: 'hidden', required: true, defaultValue: 'sess-123' },
					{ name: 'code', label: 'Code', type: 'text', required: true },
				],
			},
		],
	};
}

function autoSignInState(): AuthState {
	return {
		state: 'confirmingSignUp',
		actions: [
			{
				name: 'autoSignIn',
				label: 'Continue',
				fields: [
					{ name: 'username', label: 'Username', type: 'hidden', required: true, defaultValue: 'alice' },
				],
			},
		],
	};
}

interface MockApi extends AuthStateApi {
	/** Every `setAuthState` input, verbatim. */
	calls: AuthActionInput[];
	/** Number of `getAuthState` calls. */
	gets: number;
	/** What `getAuthState` resolves to. Advanced by a non-retriable `setAuthState`. */
	current: AuthState;
	/** What `setAuthState` resolves to. */
	next: AuthState;
	/** Results for the next `setAuthState` calls, in order; `next` once empty. */
	queue: AuthState[];
	/** When set, `setAuthState` rejects with it. */
	reject?: unknown;
}

function mockApi(initial: AuthState): MockApi {
	const api: MockApi = {
		calls: [],
		queue: [],
		gets: 0,
		current: initial,
		next: initial,
		async getAuthState() {
			api.gets += 1;
			return api.current;
		},
		async setAuthState(input: AuthActionInput) {
			api.calls.push(input);
			if (api.reject !== undefined) throw api.reject;
			const result = api.queue.shift() ?? api.next;
			if (result.retriable !== true) api.current = result;
			return result;
		},
	};
	return api;
}

async function flush() {
	// Let microtasks (promises) and happy-dom async operations settle
	await new Promise((r) => setTimeout(r, 10));
}

/** Record every `onAuthChange` emission for `api`, after its first frame settled. */
async function watchUsers(api: AuthStateApi) {
	const users: (AuthUser | null)[] = [];
	const stop = onAuthChange(api, (u) => {
		users.push(u);
	});
	await flush();
	const before = users.length;
	return { users, stop, delta: () => users.length - before, last: () => users.at(-1) };
}

/** A hydrated api plus an `onAuthChange` recorder and a store-listener counter. */
async function setup(initial: AuthState) {
	const api = mockApi(initial);
	const watch = await watchUsers(api);
	const store: AuthState[] = [];
	const unsubscribe = subscribeAuthState(api, (s) => {
		store.push(s);
	});
	await flush();
	store.length = 0;
	return { api, ...watch, store, unsubscribe };
}

function testId(root: ParentNode, id: string) {
	return root.querySelector(`[data-testid="${id}"]`);
}

function fillSignIn(el: HTMLElement) {
	const signIn = testId(el, 'authenticator-action-signIn')!;
	(testId(signIn, 'authenticator-username') as HTMLInputElement).value = 'alice';
	(testId(signIn, 'authenticator-password') as HTMLInputElement).value = 'secret';
	return signIn;
}

// ---------------------------------------------------------------------------
// submitAuthAction
// ---------------------------------------------------------------------------

describe('submitAuthAction', () => {
	test('R2: calls setAuthState exactly once with the input unchanged, and resolves to the same object', async () => {
		const { api } = await setup(signedOutState());
		const resolved: AuthState = {
			state: 'signedOut',
			actions: [signInAction],
			error: 'Incorrect username or password.',
			errorName: 'NotAuthorizedException',
		};
		api.next = resolved;
		const input: AuthActionInput = { action: 'signIn', username: 'alice', password: 'wrong' };

		const result = await submitAuthAction(api, input);

		assert.strictEqual(api.calls.length, 1);
		assert.strictEqual(api.calls[0], input, 'the input object is passed through, not copied');
		assert.deepStrictEqual(api.calls[0], { action: 'signIn', username: 'alice', password: 'wrong' });
		assert.strictEqual(result, resolved, 'resolves to the exact object setAuthState returned');
		assert.strictEqual(result.errorName, 'NotAuthorizedException');
	});

	test('R3: a signedIn result fires onAuthChange exactly once with the user', async () => {
		const { api, delta, last } = await setup(signedOutState());
		api.next = signedInState();

		await submitAuthAction(api, { action: 'signIn', username: 'alice', password: 'secret' });
		await flush();

		assert.strictEqual(delta(), 1);
		assert.strictEqual(last()?.username, 'alice');
	});

	test('R4: a signedOut result fires onAuthChange exactly once with null', async () => {
		const { api, delta, last } = await setup(signedInState());
		api.next = { state: 'signedOut', actions: [] };

		await submitAuthAction(api, { action: 'signOut' });
		await flush();

		assert.strictEqual(delta(), 1);
		assert.strictEqual(last(), null);
	});

	test('R5/S5: a retriable result broadcasts nothing and leaves the store untouched', async () => {
		const { api, delta, store } = await setup(confirmSignInState());
		const before = getAuthStateSnapshot(api);
		api.next = { state: 'confirmingSignIn', retriable: true, error: 'Wrong code', actions: [] };

		const result = await submitAuthAction(api, {
			action: 'confirmSignIn',
			challenge: 'code',
			session: 'sess-123',
			code: '000000',
		});
		await flush();

		assert.strictEqual(delta(), 0, 'no broadcast');
		assert.strictEqual(store.length, 0, 'no store listener fired');
		assert.strictEqual(result.retriable, true);
		assert.strictEqual(result.error, 'Wrong code');
		assert.strictEqual(getAuthStateSnapshot(api), before, 'the snapshot is still the previous state');

		// An Authenticator mounted afterwards paints the previous state, synchronously.
		const el = Authenticator(api);
		assert.ok(testId(el, 'authenticator-action-confirmSignIn'), 'previous (confirm-code) state painted');
		assert.strictEqual(testId(el, 'authenticator-error'), null, 'the retriable error is not in the store');
	});

	for (const state of ['confirmingSignIn', 'confirmingSignUp', 'confirmingMfa', 'confirmingPasswordReset'] as const) {
		test(`R6/S5: a mid-flow ${state} result writes the store once and broadcasts nothing`, async () => {
			const { api, delta, store } = await setup(signedOutState());
			api.next = { ...confirmSignInState(), state };

			const result = await submitAuthAction(api, { action: 'signIn', username: 'alice', password: 'secret' });
			await flush();

			assert.strictEqual(delta(), 0, 'no broadcast for a mid-flow state');
			assert.strictEqual(getAuthStateSnapshot(api), result, 'the store holds the result');
			assert.strictEqual(store.length, 1, 'store listeners fire exactly once');
			assert.strictEqual(store[0], result);
		});
	}

	test('R7: broadcast follows the resulting state — a signedOut error result re-broadcasts null', async () => {
		const { api, delta, last } = await setup(signedOutState());
		api.next = {
			state: 'signedOut',
			error: 'x',
			errorName: 'NotAuthorizedException',
			actions: [signInAction],
		};

		await submitAuthAction(api, { action: 'signIn', username: 'alice', password: 'wrong' });
		await flush();

		assert.strictEqual(delta(), 1, 'signedOut → signedOut still broadcasts');
		assert.strictEqual(last(), null);
	});

	test('R7: a signedIn result without a user broadcasts null, not undefined', async () => {
		const { api, users, delta } = await setup(signedOutState());
		const tab = otherTab();
		const received: unknown[] = [];
		tab.addEventListener('message', (e) => received.push(e.data));
		api.next = { state: 'signedIn', actions: [] };

		await submitAuthAction(api, { action: 'signIn', username: 'alice', password: 'secret' });
		await flush();

		assert.strictEqual(delta(), 1);
		assert.strictEqual(users.at(-1), null);
		assert.deepStrictEqual(received, [{ type: 'auth-change', user: null }]);
		assert.ok(Object.hasOwn(received[0] as object, 'user'), 'payload carries user: null');
	});

	test('R8: the broadcast reaches other tabs and this window with the unchanged wire format', async () => {
		const { api } = await setup(signedOutState());
		const tab = otherTab();
		const crossTab: unknown[] = [];
		tab.addEventListener('message', (e) => crossTab.push(e.data));
		const sameWindow: unknown[] = [];
		const onLocal = (e: Event) => sameWindow.push((e as CustomEvent).detail);
		globalThis.window.addEventListener('blocks-auth-change', onLocal);

		api.next = signedInState();
		await submitAuthAction(api, { action: 'signIn', username: 'alice', password: 'secret' });
		api.next = { state: 'signedOut', actions: [] };
		await submitAuthAction(api, { action: 'signOut' });
		await flush();
		globalThis.window.removeEventListener('blocks-auth-change', onLocal);

		const expected = [
			{ type: 'auth-change', user: { userId: 'alice', username: 'alice' } },
			{ type: 'auth-change', user: null },
		];
		assert.deepStrictEqual(crossTab, expected, "BroadcastChannel('blocks-auth'), once per submit");
		assert.deepStrictEqual(sameWindow, expected, "window 'blocks-auth-change', once per submit");
	});

	test('R9/S5: a rejected setAuthState rejects with the same error; nothing cached or broadcast', async () => {
		const { api, delta, store } = await setup(signedOutState());
		const before = getAuthStateSnapshot(api);
		const e = new Error('network down');
		api.reject = e;

		await assert.rejects(
			submitAuthAction(api, { action: 'signIn', username: 'alice', password: 'x' }),
			(x) => x === e,
		);
		await flush();

		assert.strictEqual(delta(), 0);
		assert.strictEqual(store.length, 0);
		assert.strictEqual(getAuthStateSnapshot(api), before);
	});

	test('R16: the store is keyed by api identity; the broadcast stays global', async () => {
		const a = await setup(signedOutState());
		const b = await setup(signedOutState());
		const bBefore = getAuthStateSnapshot(b.api);
		a.api.next = signedInState();

		await submitAuthAction(a.api, { action: 'signIn', username: 'alice', password: 'secret' });
		await flush();

		assert.strictEqual(getAuthStateSnapshot(b.api), bBefore, "B's snapshot is untouched");
		assert.strictEqual(b.store.length, 0, "B's store listeners did not fire");
		assert.strictEqual(a.store.length, 1, "A's store listener fired");
		assert.strictEqual(b.delta(), 1, 'onAuthChange(B) still fires: the broadcast is global');
		assert.strictEqual(b.api.calls.length, 0);
	});
});

// ---------------------------------------------------------------------------
// The built-in components submit only through submitAuthAction
// ---------------------------------------------------------------------------

describe('built-in components use submitAuthAction (R11–R14)', () => {
	test('R11: Authenticator form submit (click) — one RPC, one broadcast, signed-in view', async () => {
		const api = mockApi(signedOutState());
		const { delta } = await watchUsers(api);
		const el = Authenticator(api);
		await flush();
		api.next = signedInState();

		const signIn = fillSignIn(el);
		(testId(signIn, 'authenticator-submit') as HTMLButtonElement).click();
		await flush();

		assert.deepStrictEqual(api.calls, [{ action: 'signIn', username: 'alice', password: 'secret' }]);
		assert.strictEqual(delta(), 1);
		assert.strictEqual(testId(el, 'authenticator-signed-in')?.textContent, 'Signed in as: alice');
	});

	test('R11: Authenticator Enter from any field — one RPC, one broadcast', async () => {
		const api = mockApi(signedOutState());
		const { delta } = await watchUsers(api);
		const el = Authenticator(api);
		await flush();
		api.next = signedInState();

		const signIn = fillSignIn(el);
		testId(signIn, 'authenticator-username')!.dispatchEvent(
			new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
		);
		await flush();

		assert.strictEqual(api.calls.length, 1);
		assert.strictEqual(delta(), 1);
		assert.ok(testId(el, 'authenticator-signed-in'));
	});

	test('R11: slot submit — one RPC and one broadcast for signedIn, none for mid-flow', async () => {
		const api = mockApi(signedOutState());
		const { delta } = await watchUsers(api);
		let submit: ((values: Record<string, string>) => Promise<void>) | undefined;
		const el = Authenticator(api, {
			actions: {
				signIn: {
					render: (_action, helpers) => {
						submit = helpers.submit;
						return document.createElement('div');
					},
				},
				confirmSignIn: {
					render: (_action, helpers) => {
						submit = helpers.submit;
						return document.createElement('div');
					},
				},
			},
		});
		await flush();

		api.next = confirmSignInState();
		await submit!({ username: 'alice', password: 'secret' });
		await flush();
		assert.strictEqual(delta(), 0, 'mid-flow: no broadcast');
		assert.strictEqual(getAuthStateSnapshot(api)?.state, 'confirmingSignIn');

		api.next = signedInState();
		await submit!({ challenge: 'code', session: 'sess-123', code: '123456' });
		await flush();
		assert.strictEqual(api.calls.length, 2);
		assert.strictEqual(delta(), 1, 'signedIn: exactly one broadcast');
		assert.ok(testId(el, 'authenticator-signed-in'));
	});

	test('R11: AccountMenuBar sign-out — one RPC, one null broadcast, bar flips to Sign In', async () => {
		const api = mockApi(signedInState());
		const { delta, last } = await watchUsers(api);
		const bar = AccountMenuBar(api);
		await flush();
		api.next = { state: 'signedOut', actions: [signInAction] };

		(testId(bar, 'account-menu-signout') as HTMLButtonElement).click();
		await flush();

		assert.deepStrictEqual(api.calls, [{ action: 'signOut' }]);
		assert.strictEqual(delta(), 1);
		assert.strictEqual(last(), null);
		assert.ok(testId(bar, 'account-menu-signin'), 'bar re-rendered signed out');
		assert.strictEqual(getAuthStateSnapshot(api)?.state, 'signedOut', 'the store was written');
	});

	test('AccountMenuBar follows a url-bearing signOut (federated) as a form submit, not an RPC', async () => {
		const federated: AuthState = {
			...signedInState(),
			actions: [
				{ name: 'signOut', label: 'Sign Out', fields: [], url: '/aws-blocks/auth/signout', method: 'POST' },
			],
		};
		const api = mockApi(federated);
		const { delta } = await watchUsers(api);
		const bar = AccountMenuBar(api);
		await flush();
		const submitted: { action: string; method: string }[] = [];
		const proto = window.HTMLFormElement.prototype;
		const original = proto.submit;
		proto.submit = function (this: HTMLFormElement) {
			submitted.push({ action: this.getAttribute('action') ?? '', method: this.method.toLowerCase() });
		};
		try {
			(testId(bar, 'account-menu-signout') as HTMLButtonElement).click();
			await flush();
		} finally {
			proto.submit = original;
		}

		assert.deepStrictEqual(submitted, [{ action: '/aws-blocks/auth/signout', method: 'post' }]);
		assert.strictEqual(api.calls.length, 0, 'no setAuthState RPC');
		assert.strictEqual(delta(), 0, 'no broadcast: the navigation ends the page');
	});

	test('R11: source scan — only submitAuthAction submits or broadcasts', () => {
		const here = dirname(fileURLToPath(import.meta.url));
		const file = join(here, '..', 'src', 'ui.ts');
		const sf = ts.createSourceFile(file, readFileSync(file, 'utf-8'), ts.ScriptTarget.Latest, true);
		const callers: Record<'setAuthState' | 'updateState' | 'broadcastAuthChange', Set<string>> = {
			setAuthState: new Set(),
			updateState: new Set(),
			broadcastAuthChange: new Set(),
		};
		const enclosing = (node: ts.Node): string => {
			let n: ts.Node | undefined = node;
			let name = '<module>';
			while (n) {
				if (ts.isFunctionDeclaration(n) && n.name) name = n.name.text; // outermost wins
				n = n.parent;
			}
			return name;
		};
		const visit = (node: ts.Node) => {
			if (ts.isCallExpression(node)) {
				const callee = node.expression;
				if (ts.isPropertyAccessExpression(callee) && callee.name.text === 'setAuthState') {
					callers.setAuthState.add(enclosing(node));
				} else if (
					ts.isIdentifier(callee) &&
					(callee.text === 'updateState' || callee.text === 'broadcastAuthChange')
				) {
					callers[callee.text].add(enclosing(node));
				}
			}
			ts.forEachChild(node, visit);
		};
		visit(sf);

		assert.deepStrictEqual(
			[...callers.setAuthState],
			['submitAuthAction'],
			'only submitAuthAction calls setAuthState',
		);
		assert.deepStrictEqual(
			[...callers.broadcastAuthChange],
			['submitAuthAction'],
			'only submitAuthAction broadcasts',
		);
		// The store's other inputs are hydration and the cross-tab refetch (S4, S6).
		assert.deepStrictEqual(
			[...callers.updateState].sort(),
			['ensureState', 'refetchFromOtherTab', 'submitAuthAction'],
			'store writes: submitAuthAction, hydration, cross-tab refetch — nothing else',
		);
	});

	test('R12: Authenticator advances to the challenge form through the store, without broadcasting', async () => {
		const api = mockApi(signedOutState());
		const { delta } = await watchUsers(api);
		const el = Authenticator(api);
		await flush();
		api.next = confirmSignInState();

		const signIn = fillSignIn(el);
		(testId(signIn, 'authenticator-submit') as HTMLButtonElement).click();
		await flush();

		const confirm = testId(el, 'authenticator-action-confirmSignIn');
		assert.ok(confirm, 'confirm-code form rendered');
		assert.strictEqual(testId(confirm!, 'authenticator-submit')?.textContent, 'Confirm Code');
		assert.strictEqual((testId(confirm!, 'authenticator-session') as HTMLInputElement).value, 'sess-123');
		assert.strictEqual(delta(), 0);
	});

	test('R13: a retriable form submit keeps the current form + hidden session and overlays the error', async () => {
		const api = mockApi(confirmSignInState());
		const { delta } = await watchUsers(api);
		const el = Authenticator(api);
		await flush();
		const before = getAuthStateSnapshot(api);
		api.next = { state: 'confirmingSignIn', retriable: true, error: 'Wrong code', actions: [] };

		const confirm = testId(el, 'authenticator-action-confirmSignIn')!;
		(testId(confirm, 'authenticator-code') as HTMLInputElement).value = '000000';
		(testId(confirm, 'authenticator-submit') as HTMLButtonElement).click();
		await flush();

		assert.strictEqual(testId(el, 'authenticator-error')?.textContent, 'Wrong code');
		const session = testId(el, 'authenticator-session') as HTMLInputElement;
		assert.strictEqual(session.value, 'sess-123', 'hidden session intact');
		assert.strictEqual(delta(), 0);
		assert.strictEqual(getAuthStateSnapshot(api), before, 'nothing cached');
		assert.deepStrictEqual(api.calls[0], {
			action: 'confirmSignIn',
			challenge: 'code',
			session: 'sess-123',
			code: '000000',
		});
	});

	test("R13: a retriable result with an empty error shows 'An error occurred'", async () => {
		const api = mockApi(confirmSignInState());
		const el = Authenticator(api);
		await flush();
		api.next = { state: 'confirmingSignIn', retriable: true, error: '', actions: [] };

		(testId(el, 'authenticator-submit') as HTMLButtonElement).click();
		await flush();

		assert.strictEqual(testId(el, 'authenticator-error')?.textContent, 'An error occurred');
	});

	test('R13: a retriable slot submit overlays the error on the current state', async () => {
		const api = mockApi(confirmSignInState());
		const { delta } = await watchUsers(api);
		let submit: ((values: Record<string, string>) => Promise<void>) | undefined;
		const el = Authenticator(api, {
			actions: {
				confirmSignIn: {
					render: (_action, helpers) => {
						submit = helpers.submit;
						const div = document.createElement('div');
						div.setAttribute('data-custom', 'confirm');
						return div;
					},
				},
			},
		});
		await flush();
		api.next = { state: 'confirmingSignIn', retriable: true, error: 'Wrong code', actions: [] };

		await submit!({ challenge: 'code', session: 'sess-123', code: '000000' });
		await flush();

		assert.strictEqual(testId(el, 'authenticator-error')?.textContent, 'Wrong code');
		assert.ok(el.querySelector('[data-custom="confirm"]'), 'the custom slot is still on screen');
		assert.strictEqual(delta(), 0);
	});

	test('R13: a rejected submit keeps the fallbacks — retriable overlays, otherwise signedOut with the action', async () => {
		const api = mockApi(confirmSignInState());
		const { delta } = await watchUsers(api);
		const el = Authenticator(api);
		await flush();

		api.reject = Object.assign(new Error('Too many attempts'), { retriable: true });
		(testId(el, 'authenticator-submit') as HTMLButtonElement).click();
		await flush();
		assert.strictEqual(testId(el, 'authenticator-error')?.textContent, 'Too many attempts');
		assert.strictEqual((testId(el, 'authenticator-session') as HTMLInputElement).value, 'sess-123');

		api.reject = new Error('Bad gateway');
		(testId(el, 'authenticator-submit') as HTMLButtonElement).click();
		await flush();
		assert.strictEqual(testId(el, 'authenticator-error')?.textContent, 'Bad gateway');
		assert.ok(testId(el, 'authenticator-action-confirmSignIn'), 'the failed action is offered again');
		assert.strictEqual(delta(), 0);
	});

	test('R14a: autoSignIn submits through submitAuthAction — one RPC, one broadcast, signed-in view', async () => {
		const api = mockApi(autoSignInState());
		const { delta } = await watchUsers(api);
		api.next = signedInState();
		const el = Authenticator(api);
		await flush();
		await flush();

		assert.deepStrictEqual(api.calls, [{ action: 'autoSignIn', username: 'alice' }]);
		assert.strictEqual(delta(), 1);
		assert.strictEqual(testId(el, 'authenticator-signed-in')?.textContent, 'Signed in as: alice');
	});

	test('R14b: a rejected autoSignIn shows the error and broadcasts nothing', async () => {
		const api = mockApi(autoSignInState());
		const { delta } = await watchUsers(api);
		api.reject = new Error('Session expired');
		const el = Authenticator(api);
		await flush();
		await flush();

		assert.strictEqual(testId(el, 'authenticator-error')?.textContent, 'Session expired');
		assert.strictEqual(delta(), 0);
		assert.strictEqual(api.calls.length, 1);
	});

	test('R14c: a retriable autoSignIn shows the error once, without looping', async () => {
		const api = mockApi(autoSignInState());
		const { delta } = await watchUsers(api);
		api.next = { state: 'confirmingSignUp', retriable: true, error: 'Try again', actions: [] };
		const el = Authenticator(api);
		await flush();
		await flush();

		assert.strictEqual(testId(el, 'authenticator-error')?.textContent, 'Try again');
		assert.ok(testId(el, 'authenticator-action-autoSignIn'), 'the manual Continue fallback stays on screen');
		assert.strictEqual(api.calls.length, 1, 'the error overlay does not re-fire autoSignIn');
		assert.strictEqual(delta(), 0);
	});

	test('R14: two mounted Authenticators redeem the autoSignIn bridge once', async () => {
		const api = mockApi(signedOutState());
		const { delta } = await watchUsers(api);
		const a = Authenticator(api);
		const b = Authenticator(api);
		await flush();
		api.queue = [autoSignInState(), signedInState()];

		// confirmSignUp → the autoSignIn-only state reaches both through the store.
		await submitAuthAction(api, { action: 'confirmSignUp', username: 'alice', code: '123456' });
		await flush();
		await flush();

		assert.deepStrictEqual(
			api.calls.map((c) => c.action),
			['confirmSignUp', 'autoSignIn'],
			'autoSignIn submitted once, not once per Authenticator',
		);
		assert.strictEqual(delta(), 1);
		assert.ok(testId(a, 'authenticator-signed-in'));
		assert.ok(testId(b, 'authenticator-signed-in'));
	});
});

// ---------------------------------------------------------------------------
// The store
// ---------------------------------------------------------------------------

describe('subscribeAuthState / getAuthStateSnapshot', () => {
	test('S2: the snapshot is a pure read — null when cold, no network call', async () => {
		const api = mockApi(signedInState());
		assert.strictEqual(getAuthStateSnapshot(api), null);
		await flush();
		assert.strictEqual(api.gets, 0, 'reading the snapshot never hydrates');

		const unsubscribe = subscribeAuthState(api, () => {});
		await flush();
		assert.deepStrictEqual(getAuthStateSnapshot(api), signedInState());
		unsubscribe();
	});

	test('S3: the snapshot is referentially stable between writes', async () => {
		const { api } = await setup(signedOutState());
		const first = getAuthStateSnapshot(api);
		assert.ok(first);
		assert.strictEqual(getAuthStateSnapshot(api), first, 'same object with no change in between');

		api.next = confirmSignInState();
		const result = await submitAuthAction(api, { action: 'signIn', username: 'alice', password: 'secret' });
		const second = getAuthStateSnapshot(api);
		assert.notStrictEqual(second, first, 'a store write changes identity');
		assert.strictEqual(second, result);
		assert.strictEqual(getAuthStateSnapshot(api), second);
	});

	test('S4: subscribing on a cold api shares one getAuthState and fires the listener once, asynchronously', async () => {
		const api = mockApi(signedOutState());
		let fired = 0;
		const unsubscribe = subscribeAuthState(api, () => {
			fired += 1;
		});
		const stop = onAuthChange(api, () => {});
		Authenticator(api);
		assert.strictEqual(fired, 0, 'never called synchronously');

		await flush();
		assert.strictEqual(api.gets, 1, 'one shared hydration for store, onAuthChange and Authenticator');
		assert.strictEqual(fired, 1, 'fired once when the hydration landed');
		unsubscribe();
		stop();
	});

	test('S4: a warm subscribe does not fire or refetch', async () => {
		const { api } = await setup(signedOutState());
		const gets = api.gets;
		let fired = 0;
		const unsubscribe = subscribeAuthState(api, () => {
			fired += 1;
		});
		await flush();
		assert.strictEqual(fired, 0);
		assert.strictEqual(api.gets, gets);
		unsubscribe();
	});

	test('S6: a cross-tab broadcast triggers one refetch per api, however many are mounted', async () => {
		const api = mockApi(signedOutState());
		const a = Authenticator(api);
		const b = Authenticator(api);
		const store: AuthState[] = [];
		const unsubscribe = subscribeAuthState(api, (s) => {
			store.push(s);
		});
		await flush();
		const gets = api.gets;
		store.length = 0; // drop the hydration notification

		// Another tab signs in: its server state changes, then it broadcasts.
		api.current = signedInState();
		otherTab().postMessage({ type: 'auth-change', user: { userId: 'alice', username: 'alice' } });
		await flush();

		assert.strictEqual(api.gets - gets, 1, 'one refetch, not one per Authenticator');
		assert.strictEqual(store.length, 1, 'the refetch notifies store listeners');
		assert.ok(testId(a, 'authenticator-signed-in'));
		assert.ok(testId(b, 'authenticator-signed-in'));
		unsubscribe();
	});

	test('S6: a same-window submit does not trigger a refetch', async () => {
		const api = mockApi(signedOutState());
		Authenticator(api);
		const unsubscribe = subscribeAuthState(api, () => {});
		await flush();
		const gets = api.gets;

		api.next = signedInState();
		await submitAuthAction(api, { action: 'signIn', username: 'alice', password: 'secret' });
		await flush();

		assert.strictEqual(api.gets, gets, 'the store was already written; no getAuthState round trip');
		unsubscribe();
	});

	test('S7: unsubscribe is idempotent; the cross-tab listener is per api and removed with the last subscriber', async () => {
		const api = mockApi(signedOutState());
		const before = moduleChannelListeners();
		let calls = 0;
		const listener = () => {
			calls += 1;
		};
		const unsub1 = subscribeAuthState(api, listener);
		const unsub2 = subscribeAuthState(api, listener);
		assert.strictEqual(moduleChannelListeners(), before + 1, 'one channel listener per api, not per subscriber');
		await flush();
		calls = 0;

		unsub1();
		unsub1();
		assert.strictEqual(moduleChannelListeners(), before + 1, 'still subscribed through unsub2');
		unsub2();
		unsub2();
		assert.strictEqual(moduleChannelListeners(), before, 'removed with the last subscriber');

		api.next = signedInState();
		await submitAuthAction(api, { action: 'signIn', username: 'alice', password: 'secret' });
		otherTab().postMessage({ type: 'auth-change', user: null });
		await flush();
		assert.strictEqual(calls, 0, 'an unsubscribed listener never fires again');
	});

	test('S8: a failed hydration leaves the snapshot null, fires nothing, and the next subscribe retries', async () => {
		const api = mockApi(signedInState());
		let attempts = 0;
		api.getAuthState = async () => {
			attempts += 1;
			if (attempts === 1) throw new Error('network down');
			return signedInState();
		};
		let fired = 0;
		const unsub1 = subscribeAuthState(api, () => {
			fired += 1;
		});
		await flush();
		assert.strictEqual(getAuthStateSnapshot(api), null);
		assert.strictEqual(fired, 0);

		const unsub2 = subscribeAuthState(api, () => {});
		await flush();
		assert.strictEqual(attempts, 2, 'retried, not replayed');
		assert.strictEqual(getAuthStateSnapshot(api)?.user?.username, 'alice');
		unsub1();
		unsub2();
	});

	test('S9: one sign-in fires the store once and onAuthChange once — two views, not a double fire', async () => {
		const { api, store, delta } = await setup(signedOutState());
		api.next = signedInState();

		await submitAuthAction(api, { action: 'signIn', username: 'alice', password: 'secret' });
		await flush();

		assert.strictEqual(store.length, 1);
		assert.strictEqual(delta(), 1);
	});

	test('S9: onAuthChange keeps its synchronous first frame with a store subscriber present', async () => {
		const api = mockApi(signedInState());
		const unsubscribe = subscribeAuthState(api, () => {});
		await flush();
		const seen: (AuthUser | null)[] = [];
		const stop = onAuthChange(api, (u) => {
			seen.push(u);
		});
		assert.strictEqual(seen.length, 1, 'synchronous first frame from the warm store');
		await flush();
		assert.strictEqual(seen.length, 1, 'no extra emission from the store');
		stop();
		unsubscribe();
	});

	test('S9: a hydration landing after a newer store write does not overwrite it', async () => {
		const api = mockApi(signedOutState());
		let release: (s: AuthState) => void = () => {};
		api.getAuthState = () =>
			new Promise<AuthState>((resolve) => {
				release = resolve;
			});
		const unsubscribe = subscribeAuthState(api, () => {});
		api.next = signedInState();
		const result = await submitAuthAction(api, { action: 'signIn', username: 'alice', password: 'secret' });

		release(signedOutState()); // stale hydration lands last
		await flush();

		assert.strictEqual(getAuthStateSnapshot(api), result, 'the newer submit result wins');
		unsubscribe();
	});
});
