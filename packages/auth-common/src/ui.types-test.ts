// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Negative type tests for `AuthStateApi.setAuthState` discrimination and the
 * `StatusMessage` factory signature.
 *
 * Compile-only. Each `@ts-expect-error` line asserts the following
 * expression is currently a type error; if it stops being a type error
 * (e.g. the map regresses to `Record<string, any>`, or `StatusMessage`'s
 * `text` becomes required), the build fails.
 *
 * @internal
 */

import { StatusMessage } from './ui.js';
import type { AuthStateApi, StatusKind } from './ui.js';

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

void positive; void negative;

// StatusMessage — the factory and its handle. Mirrors the sibling UI
// surfaces so an accidental signature change (e.g. making the initial
// options or set()'s text required) is caught at build time.
function statusPositive() {
	// No-arg call compiles — every option is optional.
	const bare = StatusMessage();
	// Options are all optional and independently omittable.
	StatusMessage({});
	StatusMessage({ kind: 'loading' });
	StatusMessage({ text: 'Saving…' });
	StatusMessage({ testId: 'app-status' });
	StatusMessage({ kind: 'success', text: 'Done.', testId: 'app-status' });
	// set() — kind required, text optional, every StatusKind member accepted.
	bare.set('idle');
	bare.set('loading');
	bare.set('success', 'Done.');
	bare.set('error', 'Failed.');
	// The handle's element is a read-only HTMLElement.
	const el: HTMLElement = bare.element;
	void el;
}

function statusNegative() {
	const handle = StatusMessage();
	// @ts-expect-error — kind must be a StatusKind member, not an arbitrary string.
	StatusMessage({ kind: 'pending' });
	// @ts-expect-error — testId is a string, not a number.
	StatusMessage({ testId: 42 });
	// @ts-expect-error — set() requires a kind argument.
	handle.set();
	// @ts-expect-error — set()'s kind must be a StatusKind member.
	handle.set('pending');
	// @ts-expect-error — element is read-only.
	handle.element = document.createElement('div');
	// @ts-expect-error — StatusKind has no 'pending' member.
	const bad: StatusKind = 'pending';
	void bad;
}

void statusPositive; void statusNegative;
