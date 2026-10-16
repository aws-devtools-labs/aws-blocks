// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Negative type tests for `AuthStateApi.setAuthState` discrimination.
 *
 * Compile-only. Each `@ts-expect-error` line asserts the following
 * expression is currently a type error; if it stops being a type error
 * (e.g. the map regresses to `Record<string, any>`), the build fails.
 *
 * @internal
 */

import type { AuthState } from './index.js';
import type { AuthStateApi } from './ui.js';
import { getAuthStateSnapshot, submitAuthAction, subscribeAuthState } from './ui.js';

declare const api: AuthStateApi;

async function positive() {
	await api.setAuthState({ action: 'signIn', username: 'alice', password: 'P@ss1' });
	await api.setAuthState({ action: 'signUp', username: 'alice', password: 'P@ss1' });
	// signUp accepts arbitrary extra string attrs (Cognito custom attrs).
	await api.setAuthState({
		action: 'signUp',
		username: 'alice',
		password: 'P@ss1',
		department: 'platform',
	});
	await api.setAuthState({ action: 'confirmSignUp', username: 'alice', code: '123456' });
	await api.setAuthState({ action: 'confirmSignUp', username: 'alice', code: '123456', password: 'P@ss1' });
	await api.setAuthState({ action: 'resendSignUpCode', username: 'alice' });
	await api.setAuthState({ action: 'signOut' });
	await api.setAuthState({ action: 'resetPassword', username: 'alice' });
	await api.setAuthState({
		action: 'confirmResetPassword',
		username: 'alice',
		code: '123456',
		newPassword: 'NewP@ss2',
	});
	// confirmSignIn — one branch per challenge shape, picked via the
	// `challenge` discriminator the BB emits as a hidden form field.
	await api.setAuthState({ action: 'confirmSignIn', challenge: 'code', session: 's1', code: '123456' });
	await api.setAuthState({ action: 'confirmSignIn', challenge: 'mfaType', session: 's1', mfaType: 'TOTP' });
	await api.setAuthState({ action: 'confirmSignIn', challenge: 'newPassword', session: 's1', newPassword: 'NewP@ss2' });
	await api.setAuthState({ action: 'confirmSignIn', challenge: 'totpSetup', session: 's1', sharedSecret: 'xxx', code: '123456' });
}

async function negative() {
	// @ts-expect-error — signIn requires password.
	await api.setAuthState({ action: 'signIn', username: 'alice' });
	// @ts-expect-error — confirmSignUp requires code.
	await api.setAuthState({ action: 'confirmSignUp', username: 'alice' });
	// @ts-expect-error — resetPassword doesn't take a password.
	await api.setAuthState({ action: 'resetPassword', username: 'alice', password: 'P@ss1' });
	// @ts-expect-error — confirmResetPassword requires code + newPassword.
	await api.setAuthState({ action: 'confirmResetPassword', username: 'alice' });
	// @ts-expect-error — confirmSignIn requires session.
	await api.setAuthState({ action: 'confirmSignIn', code: '123456' });
	// @ts-expect-error — password field isn't on signIn (wrong key name).
	await api.setAuthState({ action: 'signIn', username: 'alice', pwd: 'P@ss1' });
	// @ts-expect-error — unknown action.
	await api.setAuthState({ action: 'nonsense' });
}

// ---------------------------------------------------------------------------
// The store against React's `useSyncExternalStore` (requirement S10).
//
// A structural stand-in with React 18/19's exact signature (`@types/react`
// `useSyncExternalStore<Snapshot>`), so this compiles without a React
// dependency. `ui.react-types.test.ts` repeats the check against the real
// `@types/react`. Zero casts: this is the code a customer writes.
// ---------------------------------------------------------------------------

declare function useSyncExternalStore<Snapshot>(
	subscribe: (onStoreChange: () => void) => () => void,
	getSnapshot: () => Snapshot,
	getServerSnapshot?: () => Snapshot,
): Snapshot;

function store() {
	const subscribe: (onStoreChange: () => void) => () => void = (cb) => subscribeAuthState(api, cb);
	const getSnapshot: () => AuthState | null = () => getAuthStateSnapshot(api);
	const state: AuthState | null = useSyncExternalStore(subscribe, getSnapshot, () => null);
	// The README's hook, verbatim.
	const useAuthState = () =>
		useSyncExternalStore(
			(cb: () => void) => subscribeAuthState(api, cb),
			() => getAuthStateSnapshot(api),
			() => null,
		);
	const viaHook: AuthState | null = useAuthState();
	// A listener may also read the new state it is handed.
	const stop: () => void = subscribeAuthState(api, (s: AuthState) => void s.state);
	void state;
	void viaHook;
	stop();
}

// ---------------------------------------------------------------------------
// submitAuthAction — the README / CUSTOMIZING-AUTH-UI.md snippets (R17)
// ---------------------------------------------------------------------------

async function notifier(username: string, password: string, showError: (message?: string) => void) {
	// Same discriminated input as setAuthState, so a wrong payload is a compile error.
	const next: AuthState = await submitAuthAction(api, { action: 'signIn', username, password });
	if (next.retriable) showError(next.error);
	await submitAuthAction(api, { action: 'signOut' });
	// @ts-expect-error — signIn requires password, exactly as setAuthState does.
	await submitAuthAction(api, { action: 'signIn', username });
	// @ts-expect-error — unknown action.
	await submitAuthAction(api, { action: 'nonsense' });
}

// README "Custom auth UI" snippet.
async function readmeSignIn(username: string, password: string): Promise<string | undefined> {
	const next = await submitAuthAction(api, { action: 'signIn', username, password });
	if (next.retriable) return next.error;
	return undefined;
}

// CUSTOMIZING-AUTH-UI.md "Depth 3" snippet.
async function renderAuth(root: HTMLElement, showError: (message?: string) => void) {
	const state = await api.getAuthState();
	if (state.state === 'signedIn') {
		root.textContent = `Signed in as ${state.user?.username}`;
		return;
	}
	const next = await submitAuthAction(api, { action: 'signIn', username: 'alice', password: 'secret' });
	if (next.retriable) {
		showError(next.error);
		return;
	}
	await submitAuthAction(api, { action: 'signOut' });
}

void positive; void negative; void store; void notifier; void readmeSignIn; void renderAuth;
