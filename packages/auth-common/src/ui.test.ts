// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, test, beforeEach } from 'node:test';
import assert from 'node:assert';
import { Window } from 'happy-dom';
import type { AuthState, AuthAction } from './index.js';
import type { AuthStateApi } from './ui.js';

// ---------------------------------------------------------------------------
// happy-dom setup — install globals before importing ui.ts
// ---------------------------------------------------------------------------

const window = new Window();

// happy-dom doesn't implement BroadcastChannel — provide a minimal shim
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
	postMessage(data: any) {
		// BroadcastChannel delivers to OTHER instances with the same name, not self
		for (const ch of BroadcastChannelShim.channels.get(this.name) ?? []) {
			if (ch !== this) {
				for (const fn of ch.listeners) fn({ data } as MessageEvent);
			}
		}
	}
	addEventListener(_type: string, fn: any) { this.listeners.push(fn); }
	removeEventListener(_type: string, fn: any) { this.listeners = this.listeners.filter((f) => f !== fn); }
	close() {}
}

Object.assign(globalThis, {
	window,
	document: window.document,
	HTMLElement: window.HTMLElement,
	HTMLFormElement: window.HTMLFormElement,
	HTMLInputElement: window.HTMLInputElement,
	HTMLButtonElement: window.HTMLButtonElement,
	CustomEvent: window.CustomEvent,
	BroadcastChannel: BroadcastChannelShim,
	Event: window.Event,
});

// Import after globals are set
const { Authenticator, AuthenticatedContent, onAuthChange, broadcastAuthChange } = await import('./ui.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function signedOutState(actions?: AuthAction[]): AuthState {
	return {
		state: 'signedOut',
		actions: actions ?? [
			{ name: 'signIn', label: 'Sign In', fields: [
				{ name: 'username', label: 'Username', type: 'text', required: true },
				{ name: 'password', label: 'Password', type: 'password', required: true },
			]},
			{ name: 'signUp', label: 'Create Account', fields: [
				{ name: 'username', label: 'Username', type: 'text', required: true },
				{ name: 'password', label: 'Password', type: 'password', required: true },
			]},
		],
	};
}

function signedInState(): AuthState {
	return {
		state: 'signedIn',
		user: { userId: 'alice', username: 'alice' },
		actions: [{ name: 'signOut', label: 'Sign Out', fields: [] }],
	};
}

function mockApi(initial: AuthState): AuthStateApi & { calls: { action: string; fields: Record<string, string> }[]; nextState: AuthState } {
	const api = {
		calls: [] as { action: string; fields: Record<string, string> }[],
		nextState: initial,
		async getAuthState() { return api.nextState; },
		async setAuthState(input: any) {
			const { action, ...fields } = input;
			api.calls.push({ action, fields });
			return api.nextState;
		},
	};
	return api;
}

async function flush() {
	// Let microtasks (promises) and happy-dom async operations settle
	await new Promise((r) => setTimeout(r, 10));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Authenticator', () => {

	test('renders sign-in form when signed out', async () => {
		const api = mockApi(signedOutState());
		const el = Authenticator(api);
		await flush();

		const inputs = el.querySelectorAll('input');
		assert.ok(inputs.length >= 2, 'Should render username and password inputs');

		const buttons = el.querySelectorAll('button');
		const labels = Array.from(buttons).map((b) => b.textContent);
		assert.ok(labels.includes('Sign In'), 'Should have Sign In button');
		assert.ok(labels.includes('Create Account'), 'Should have Create Account button');
	});

	test('calls setAuthState on form submit', async () => {
		const out = signedOutState();
		const api = mockApi(out);
		const el = Authenticator(api);
		await flush();

		// Set next state to signed in so setAuthState returns it
		api.nextState = signedInState();

		// Find the Sign In button and its sibling inputs
		const buttons = Array.from(el.querySelectorAll('button'));
		const signInBtn = buttons.find((b) => b.textContent === 'Sign In');
		assert.ok(signInBtn, `Should find Sign In button. Found: ${buttons.map(b => b.textContent)}`);

		const actionDiv = signInBtn!.parentElement!;
		const inputs = actionDiv.querySelectorAll('input') as NodeListOf<HTMLInputElement>;
		inputs[0].value = 'alice';
		inputs[1].value = 'secret';

		signInBtn!.click();
		await flush();

		assert.strictEqual(api.calls.length, 1);
		assert.strictEqual(api.calls[0].action, 'signIn');
		assert.strictEqual(api.calls[0].fields.username, 'alice');
		assert.strictEqual(api.calls[0].fields.password, 'secret');
	});

	test('renders signed-in state with username and sign out', async () => {
		const api = mockApi(signedInState());
		const el = Authenticator(api);
		await flush();

		assert.ok(el.textContent?.includes('alice'), 'Should show username');
		const signOutBtn = Array.from(el.querySelectorAll('button')).find((b) => b.textContent === 'Sign Out');
		assert.ok(signOutBtn, 'Should have Sign Out button');
	});

	test('shows error message', async () => {
		const api = mockApi({ ...signedOutState(), error: 'Invalid password' });
		const el = Authenticator(api);
		await flush();

		assert.ok(el.textContent?.includes('Invalid password'), 'Should display error');
	});

	test('renders external action as HTML form with url', async () => {
		const state = signedOutState([
			{
				name: 'signIn:google',
				label: 'Sign in with Google',
				url: 'https://accounts.google.com/o/oauth2/auth?client_id=test',
				method: 'GET',
				fields: [],
			},
		]);
		const api = mockApi(state);
		const el = Authenticator(api);
		await flush();

		const form = el.querySelector('form') as HTMLFormElement;
		assert.ok(form, 'Should render an HTML form for external action');
		assert.strictEqual(form.action, 'https://accounts.google.com/o/oauth2/auth?client_id=test');
		assert.strictEqual(form.method, 'GET');

		const submitBtn = form.querySelector('button');
		assert.ok(submitBtn?.textContent?.includes('Google'), 'Button should show provider label');
	});

	test('external action includes hidden fields with defaultValue', async () => {
		const state = signedOutState([
			{
				name: 'signIn:okta',
				label: 'Sign in with Okta',
				url: 'https://myco.okta.com/authorize',
				method: 'GET',
				fields: [
					{ name: 'redirect_uri', label: 'Redirect', type: 'hidden', required: true, defaultValue: 'https://myapp.com/callback' },
				],
			},
		]);
		const api = mockApi(state);
		const el = Authenticator(api);
		await flush();

		const hidden = el.querySelector('input[name="redirect_uri"]') as HTMLInputElement;
		assert.ok(hidden, 'Should have hidden redirect_uri input');
		assert.strictEqual(hidden.value, 'https://myapp.com/callback');
		assert.strictEqual(hidden.type, 'hidden');
	});

	// ---------------------------------------------------------------------
	// Override surface (formFields-style customization)
	// ---------------------------------------------------------------------

	test('hideActions filters whole actions out of the DOM', async () => {
		const api = mockApi(signedOutState());
		const el = Authenticator(api, { hideActions: ['signUp'] });
		await flush();

		const labels = Array.from(el.querySelectorAll('button')).map((b) => b.textContent);
		assert.ok(labels.includes('Sign In'), 'Sign In must remain');
		assert.ok(!labels.includes('Create Account'), 'Create Account must be hidden');
	});

	test('headings.signedOut overrides the default heading', async () => {
		const api = mockApi(signedOutState());
		const el = Authenticator(api, { headings: { signedOut: 'Welcome back' } });
		await flush();

		const heading = el.querySelector('h3');
		assert.strictEqual(heading?.textContent, 'Welcome back');
	});

	test('actions[name].heading wins over state-level heading', async () => {
		const api = mockApi(signedOutState());
		const el = Authenticator(api, {
			headings: { signedOut: 'Generic' },
			actions: { signIn: { heading: 'Sign in to continue' } },
		});
		await flush();

		const heading = el.querySelector('h3');
		assert.strictEqual(heading?.textContent, 'Sign in to continue');
	});

	test('actions[name].submitLabel overrides the button text', async () => {
		const api = mockApi(signedOutState());
		const el = Authenticator(api, {
			actions: { signIn: { submitLabel: 'Continue →' } },
		});
		await flush();

		const labels = Array.from(el.querySelectorAll('button')).map((b) => b.textContent);
		assert.ok(labels.includes('Continue →'), 'submitLabel applied');
		assert.ok(!labels.includes('Sign In'), 'default label replaced');
	});

	test('field override label / placeholder / autocomplete take effect', async () => {
		const api = mockApi(signedOutState());
		const el = Authenticator(api, {
			actions: {
				signIn: {
					fields: {
						username: { label: 'Email address', placeholder: 'you@example.com', autocomplete: 'email' },
					},
				},
			},
		});
		await flush();

		const usernameInput = el.querySelector('input[name="username"]') as HTMLInputElement;
		assert.ok(usernameInput, 'username input rendered');
		assert.strictEqual(usernameInput.placeholder, 'you@example.com');
		assert.strictEqual(usernameInput.getAttribute('autocomplete'), 'email');
	});

	test('field override hidden:true suppresses the visible input', async () => {
		const api = mockApi(signedOutState());
		const el = Authenticator(api, {
			actions: {
				signIn: {
					fields: { password: { hidden: true } },
				},
			},
		});
		await flush();

		// `signUp` action also has a password field; we only hide signIn's.
		const signInButton = Array.from(el.querySelectorAll('button')).find((b) => b.textContent === 'Sign In');
		const signInWrapper = signInButton?.parentElement;
		const hiddenSignInPwd = signInWrapper?.querySelector('input[name="password"]');
		assert.strictEqual(hiddenSignInPwd, null, 'sign-in password input must be removed');

		const signUpButton = Array.from(el.querySelectorAll('button')).find((b) => b.textContent === 'Create Account');
		const signUpWrapper = signUpButton?.parentElement;
		const signUpPwd = signUpWrapper?.querySelector('input[name="password"]');
		assert.ok(signUpPwd, 'sign-up password remains untouched');
	});

	test('field override hidden:true preserves defaultValue as a hidden input', async () => {
		// confirmingSignUp emits { username (hidden, defaultValue), code }.
		// Hiding `code` (or any field with defaultValue) must keep the
		// value flowing on submit even though the visible input is gone.
		const api = mockApi({
			state: 'confirmingSignUp',
			actions: [{
				name: 'confirmSignUp',
				label: 'Confirm Account',
				fields: [
					{ name: 'username', label: 'Username', type: 'hidden', required: true, defaultValue: 'alice' },
					{ name: 'code', label: 'Verification Code', type: 'text', required: true, defaultValue: '111111' },
				],
			}],
		});
		const el = Authenticator(api, {
			actions: { confirmSignUp: { fields: { code: { hidden: true } } } },
		});
		await flush();

		const codeInput = el.querySelector('input[name="code"]') as HTMLInputElement;
		assert.ok(codeInput, 'code input still present');
		assert.strictEqual(codeInput.type, 'hidden');
		assert.strictEqual(codeInput.value, '111111');
	});

	test('field override `order` reorders inputs within the action', async () => {
		const api = mockApi(signedOutState());
		const el = Authenticator(api, {
			actions: {
				signIn: {
					fields: {
						password: { order: 1 },
						username: { order: 2 },
					},
				},
			},
		});
		await flush();

		const signInBtn = Array.from(el.querySelectorAll('button')).find((b) => b.textContent === 'Sign In');
		const wrapper = signInBtn?.parentElement;
		const inputs = Array.from(wrapper?.querySelectorAll('input') ?? []);
		const names = inputs.map((i) => (i as HTMLInputElement).name);
		assert.deepStrictEqual(names, ['password', 'username'], 'fields reordered');
	});

	test('field override `hint` renders helper text below the input', async () => {
		const api = mockApi(signedOutState());
		const el = Authenticator(api, {
			actions: {
				signIn: { fields: { password: { hint: '8+ chars, one digit' } } },
			},
		});
		await flush();

		assert.ok(el.textContent?.includes('8+ chars, one digit'), 'hint text rendered');
	});

	test('actions[name].render replaces the entire form (slot replacement)', async () => {
		const api = mockApi(signedOutState());
		const el = Authenticator(api, {
			actions: {
				signIn: {
					render: (action, _helpers) => {
						const div = document.createElement('div');
						div.setAttribute('data-custom-signin', 'yes');
						div.textContent = `custom: ${action.label}`;
						return div;
					},
				},
			},
		});
		await flush();

		const custom = el.querySelector('[data-custom-signin]');
		assert.ok(custom, 'custom render output present');
		assert.strictEqual(custom?.textContent, 'custom: Sign In');
		// Default Sign In button must NOT have rendered.
		const defaultSignIn = Array.from(el.querySelectorAll('button')).find((b) => b.textContent === 'Sign In');
		assert.strictEqual(defaultSignIn, undefined, 'default form suppressed');
	});

	test('field override `render` lets the customer supply the input', async () => {
		const api = mockApi(signedOutState());
		const el = Authenticator(api, {
			actions: {
				signIn: {
					fields: {
						username: {
							render: ({ name, defaultValue }) => {
								const wrap = document.createElement('div');
								wrap.setAttribute('data-custom-username', 'yes');
								const input = document.createElement('input');
								input.name = name;
								input.value = defaultValue ?? '';
								wrap.appendChild(input);
								return wrap;
							},
						},
					},
				},
			},
		});
		await flush();

		assert.ok(el.querySelector('[data-custom-username]'), 'custom field wrapper rendered');
		const usernameInput = el.querySelector('input[name="username"]');
		assert.ok(usernameInput, 'name="username" input still in DOM for submit');
	});

	test('action with capability=webauthn-get runs navigator.credentials.get and submits the encoded credential', async () => {
		const calls: any[] = [];
		// Stub navigator.credentials.get to return a synthetic credential.
		// happy-dom doesn't ship a WebAuthn implementation, so we install a
		// stub that mimics the surface we care about: a `PublicKeyCredential`
		// with a `toJSON()` method. Node 22+ defines `globalThis.navigator`
		// as a getter (no setter), so direct assignment throws — use
		// `Object.defineProperty` to override it.
		const navigatorStub = {
			credentials: {
				get: async (opts: any) => {
					calls.push(opts);
					return {
						id: 'cred-stub',
						type: 'public-key',
						rawId: new ArrayBuffer(2),
						response: { clientDataJSON: new ArrayBuffer(2), authenticatorData: new ArrayBuffer(2), signature: new ArrayBuffer(2) },
						getClientExtensionResults: () => ({}),
						toJSON: () => ({ id: 'cred-stub', type: 'public-key' }),
					} as any;
				},
				create: async () => null,
			},
		};
		Object.defineProperty(globalThis, 'navigator', {
			value: navigatorStub,
			writable: true,
			configurable: true,
		});
		(globalThis as any).PublicKeyCredential = class {};

		const passkeyState: AuthState = {
			state: 'confirmingSignIn',
			actions: [{
				name: 'confirmSignIn',
				label: 'Use Passkey',
				capability: 'webauthn-get',
				fields: [
					{ name: 'session', label: 'Session', type: 'hidden', required: true, defaultValue: 'sess-1' },
					{ name: 'challenge', label: 'Challenge', type: 'hidden', required: true, defaultValue: 'webauthn' },
					{
						name: 'credentialRequestOptions',
						label: 'opts',
						type: 'hidden',
						required: true,
						defaultValue: '{"challenge":"abc","rpId":"localhost"}',
					},
					{ name: 'credential', label: 'Credential', type: 'hidden', required: true },
				],
			}],
		};
		const api = mockApi(passkeyState);
		const el = Authenticator(api);
		await flush();
		// Swap the next-state to signed-in AFTER initial render, so the
		// hydration sees the passkey form but the click resolves to the
		// signed-in screen.
		api.nextState = signedInState();
		const btn = el.querySelector('button')!;
		btn.click();
		await flush();
		await flush();
		assert.strictEqual(api.calls.length, 1);
		assert.strictEqual(api.calls[0].action, 'confirmSignIn');
		assert.strictEqual(api.calls[0].fields.session, 'sess-1');
		assert.strictEqual(api.calls[0].fields.challenge, 'webauthn');
		// The renderer must overwrite the hidden `credential` input with
		// the JSON-encoded PublicKeyCredential before submit.
		const credPayload = JSON.parse(api.calls[0].fields.credential);
		assert.strictEqual(credPayload.id, 'cred-stub');
		assert.strictEqual(calls.length, 1, 'navigator.credentials.get called once');
	});

	test('options=undefined keeps prior behavior (no regression)', async () => {
		const api = mockApi(signedOutState());
		// Same as the very first test, but explicitly verifies that the
		// old call shape `Authenticator(api)` keeps working.
		const el = Authenticator(api);
		await flush();

		const inputs = el.querySelectorAll('input');
		assert.ok(inputs.length >= 2);
	});
});

describe('AuthenticatedContent', () => {

	test('renders content when signed in', async () => {
		const api = mockApi(signedInState());
		const el = AuthenticatedContent(api, (user) => {
			const span = document.createElement('span');
			span.textContent = `Hello ${user.username}`;
			return span;
		});
		await flush();

		assert.ok(el.textContent?.includes('Hello alice'));
	});

	test('renders nothing when signed out', async () => {
		const api = mockApi(signedOutState());
		const el = AuthenticatedContent(api, (user) => {
			const span = document.createElement('span');
			span.textContent = `Hello ${user.username}`;
			return span;
		});
		await flush();

		assert.strictEqual(el.children.length, 0);
	});
});

describe('onAuthChange', () => {

	test('calls callback immediately with current user', async () => {
		const api = mockApi(signedInState());
		let received: any ;
		const unsub = onAuthChange(api, (user) => { received = user; });
		await flush();

		assert.deepStrictEqual(received, { userId: 'alice', username: 'alice' });
		unsub();
	});

	test('calls callback with null when signed out', async () => {
		const api = mockApi(signedOutState());
		let received: any = 'not-called';
		const unsub = onAuthChange(api, (user) => { received = user; });
		await flush();

		assert.strictEqual(received, null);
		unsub();
	});

	// Regression guard: the FIRST emit must be synchronous (no await). Before
	// the fix the only emit was deferred behind `ensureState().then(...)`, so a
	// signed-out UI never painted a first frame and CI harnesses timed out.
	test('emits synchronously on subscribe (signed out)', () => {
		const api = mockApi(signedOutState());
		let called = false;
		let received: any = 'sentinel';
		onAuthChange(api, (user) => { called = true; received = user; });
		// No `await flush()` here — synchronous emission is the whole point.
		assert.strictEqual(called, true, 'callback must fire synchronously on subscribe');
		assert.strictEqual(received, null, 'cold signed-out load emits null synchronously');
	});

	test('emits the signed-in user synchronously from a warm cache', async () => {
		const api = mockApi(signedInState());
		// Warm the shared cache (async hydration triggered by the first subscribe).
		const unsubWarm = onAuthChange(api, () => {});
		await flush();

		// A subsequent subscribe must emit the known user synchronously, and must
		// NOT flash null → user — the dedupe suppresses the redundant refresh.
		const seen: any[] = [];
		const unsub = onAuthChange(api, (user) => { seen.push(user); });
		assert.strictEqual(seen.length, 1, 'warm-cache subscribe emits exactly once, synchronously');
		assert.deepStrictEqual(seen[0], { userId: 'alice', username: 'alice' });

		await flush();
		assert.strictEqual(seen.length, 1, 'no redundant repaint after async refresh (no null → user flash)');

		unsub();
		unsubWarm();
	});

	test('does not throw or strand the UI when getAuthState rejects', async () => {
		const api = mockApi(signedOutState());
		api.getAuthState = async () => { throw new Error('network down'); };

		const seen: any[] = [];
		// Subscribing must not throw even though hydration will reject.
		const unsub = onAuthChange(api, (user) => { seen.push(user); });

		// Synchronous first frame still painted from the (cold) cache.
		assert.strictEqual(seen.length, 1, 'sync first frame emitted before the rejection');
		assert.strictEqual(seen[0], null);

		// Let the rejected hydration settle: no unhandled rejection, no throw,
		// and the last-known frame is preserved (no extra emit).
		await flush();
		assert.strictEqual(seen.length, 1, 'rejection does not strand or re-emit');

		unsub();
	});

	test('reacts to broadcastAuthChange', async () => {
		const api = mockApi(signedOutState());
		const events: any[] = [];
		const unsub = onAuthChange(api, (user) => { events.push(user); });
		await flush();

		broadcastAuthChange({ userId: 'bob', username: 'bob' });
		await flush();

		assert.ok(events.length >= 2, 'Should have initial + broadcast');
		assert.deepStrictEqual(events.at(-1), { userId: 'bob', username: 'bob' });
		unsub();
	});

	test('unsubscribe stops callbacks', async () => {
		const api = mockApi(signedOutState());
		let callCount = 0;
		const unsub = onAuthChange(api, () => { callCount++; });
		await flush();

		const countAfterInit = callCount;
		unsub();

		broadcastAuthChange({ userId: 'x', username: 'x' });
		await flush();

		assert.strictEqual(callCount, countAfterInit, 'Should not receive events after unsubscribe');
	});
});
