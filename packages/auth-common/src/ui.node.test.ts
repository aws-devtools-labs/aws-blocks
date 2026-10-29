// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The auth UI module outside a browser (SSR, Node scripts, e2e cookie-jar
 * clients). Runs in its own process with **no DOM globals** — requirements
 * R10 and S11 in `docs/design/auth-unification/D7-reactivity-requirements.md`.
 *
 * `submitAuthAction` still performs the RPC and returns its result, but skips
 * the store write and the broadcast silently; the store reads return `null`
 * and subscribing is a no-op. Nothing touches `window` or `BroadcastChannel`
 * (Node 22 ships a real global `BroadcastChannel`, which would hold the event
 * loop open and leak across requests).
 */

import assert from 'node:assert';
import { describe, test } from 'node:test';
import type { AuthState } from './index.js';
import type { AuthActionInput, AuthStateApi } from './ui.js';

assert.strictEqual(typeof (globalThis as { window?: unknown }).window, 'undefined', 'this file must run without a DOM');

// Trap every BroadcastChannel construction and every `window` read during import.
let channelsCreated = 0;
const RealBroadcastChannel = globalThis.BroadcastChannel;
globalThis.BroadcastChannel = class extends RealBroadcastChannel {
	constructor(name: string) {
		super(name);
		channelsCreated += 1;
		this.close();
	}
};
let windowReads = 0;
Object.defineProperty(globalThis, 'window', {
	configurable: true,
	get() {
		windowReads += 1;
		return undefined;
	},
});

const ui = await import('./ui.js');

const windowReadsDuringImport = windowReads;
// Back to a plain "no window" global for the rest of the file.
delete (globalThis as { window?: unknown }).window;

function signedInState(): AuthState {
	return { state: 'signedIn', user: { userId: 'alice', username: 'alice' }, actions: [] };
}

function mockApi(next: AuthState) {
	const api = {
		calls: [] as AuthActionInput[],
		gets: 0,
		async getAuthState() {
			api.gets += 1;
			return next;
		},
		async setAuthState(input: AuthActionInput) {
			api.calls.push(input);
			return next;
		},
	} satisfies AuthStateApi & { calls: AuthActionInput[]; gets: number };
	return api;
}

describe('auth UI outside a browser', () => {
	test('R10: importing the module touches neither window nor BroadcastChannel', () => {
		assert.strictEqual(windowReadsDuringImport, 0);
		assert.strictEqual(channelsCreated, 0);
		assert.strictEqual(typeof ui.submitAuthAction, 'function');
	});

	test('R10: submitAuthAction runs the RPC and resolves to its result, without caching or broadcasting', async () => {
		const result = signedInState();
		const api = mockApi(result);

		const next = await ui.submitAuthAction(api, { action: 'signIn', username: 'alice', password: 'secret' });

		assert.strictEqual(next, result, 'resolves to the exact RPC result');
		assert.deepStrictEqual(api.calls, [{ action: 'signIn', username: 'alice', password: 'secret' }]);
		assert.strictEqual(ui.getAuthStateSnapshot(api), null, 'no module-level cache write on the server');
		assert.strictEqual(channelsCreated, 0, 'no broadcast');
	});

	test('R10: sign-out and mid-flow results behave the same — RPC only, no throw', async () => {
		for (const state of [
			{ state: 'signedOut', actions: [] },
			{ state: 'confirmingSignIn', actions: [] },
			{ state: 'confirmingSignIn', retriable: true, error: 'Wrong code', actions: [] },
		] satisfies AuthState[]) {
			const api = mockApi(state);
			assert.strictEqual(await ui.submitAuthAction(api, { action: 'signOut' }), state);
			assert.strictEqual(ui.getAuthStateSnapshot(api), null);
		}
		assert.strictEqual(channelsCreated, 0);
	});

	test('R10: a rejected RPC still rejects with the same error', async () => {
		const e = new Error('network down');
		const api: AuthStateApi = {
			getAuthState: async () => signedInState(),
			setAuthState: async () => {
				throw e;
			},
		};
		await assert.rejects(ui.submitAuthAction(api, { action: 'signOut' }), (x) => x === e);
	});

	test('S11: getAuthStateSnapshot is null and subscribeAuthState is a no-op', async () => {
		const api = mockApi(signedInState());
		let fired = 0;
		const unsubscribe = ui.subscribeAuthState(api, () => {
			fired += 1;
		});
		assert.strictEqual(typeof unsubscribe, 'function');
		unsubscribe();
		unsubscribe();
		await new Promise((r) => setTimeout(r, 10));

		assert.strictEqual(fired, 0);
		assert.strictEqual(api.gets, 0, 'no hydration on the server');
		assert.strictEqual(ui.getAuthStateSnapshot(api), null);
		assert.strictEqual(channelsCreated, 0, 'BroadcastChannel never constructed');
	});
});
