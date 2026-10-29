// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert';
import { describe, test } from 'node:test';
import { Window } from 'happy-dom';
import type { AuthAction, AuthState } from './index.js';
import type { AuthActionInput, AuthStateApi } from './ui.js';

// happy-dom globals, installed before importing ui.ts (see ui.test.ts).
const window = new Window();
class BroadcastChannelShim {
	addEventListener() {}
	removeEventListener() {}
	postMessage() {}
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
	KeyboardEvent: window.KeyboardEvent,
	BroadcastChannel: BroadcastChannelShim,
	Event: window.Event,
});

const { MfaSettings, getAuthStateSnapshot } = await import('./ui.js');

const user = { userId: 'alice', username: 'alice', displayName: 'alice@example.com' };
const SECRET = 'JBSWY3DPEHPK3PXP';
const URI = `otpauth://totp/Acme:alice%40example.com?secret=${SECRET}&issuer=Acme&algorithm=SHA1&digits=6&period=30`;

const signedIn: AuthState = { state: 'signedIn', user, actions: [{ name: 'signOut', label: 'Sign Out', fields: [] }] };
const signedOut: AuthState = { state: 'signedOut', actions: [] };

const preference = (factor: string, setting: string, label: string): AuthAction => ({
	name: 'updateMfaPreference',
	label,
	fields: [{ name: factor, label: 'Setting', type: 'hidden', required: true, defaultValue: setting }],
});
const settings = (enrolled: boolean): AuthState => ({
	state: 'signedIn',
	user,
	actions: [
		{ name: 'setUpTotp', label: enrolled ? 'Replace authenticator app' : 'Set up authenticator app', fields: [] },
		...(enrolled ? [preference('totp', 'DISABLED', 'Turn off authenticator app')] : []),
		{ name: 'signOut', label: 'Sign Out', fields: [] },
	],
});
const settingUp: AuthState = {
	state: 'signedIn',
	user,
	actions: [
		{
			name: 'verifyTotpSetup',
			label: 'Verify',
			fields: [
				{ name: 'sharedSecret', label: 'Setup Key', type: 'hidden', required: true, defaultValue: SECRET },
				{ name: 'otpauthUri', label: 'Setup URI', type: 'hidden', required: true, defaultValue: URI },
				{ name: 'code', label: 'Code from Authenticator', type: 'text', required: true },
			],
		},
		{ name: 'getMfaPreference', label: 'Cancel', fields: [] },
	],
};

/** A state API whose `getAuthState` answers `initial`, and whose `setAuthState` answers by action. */
function fakeApi(initial: AuthState, answers: Record<string, AuthState | (() => AuthState)>) {
	const calls: AuthActionInput[] = [];
	const api: AuthStateApi = {
		getAuthState: async () => initial,
		setAuthState: async (input) => {
			calls.push(input);
			const answer = answers[input.action];
			assert.ok(answer, `unexpected action ${input.action}`);
			return typeof answer === 'function' ? answer() : answer;
		},
	};
	return { api, calls };
}

const flush = () => new Promise((r) => setTimeout(r, 10));
const byTestId = (root: ParentNode, id: string) => root.querySelector(`[data-testid="${id}"]`);

/** The `<input>` under `id` (test plumbing: happy-dom's element classes are not lib.dom's). */
function inputAt(root: ParentNode, id: string): HTMLInputElement {
	const el = byTestId(root, id);
	assert.ok(el && el.tagName === 'INPUT', `${id} is an <input>`);
	return el as HTMLInputElement;
}

function click(root: ParentNode, formTestId: string): void {
	const form = byTestId(root, formTestId);
	assert.ok(form, `${formTestId} is rendered`);
	assert.strictEqual(form.tagName, 'FORM', `${formTestId} is a <form>`);
	const button = byTestId(form, 'mfa-settings-submit');
	assert.ok(button && button.tagName === 'BUTTON');
	(button as HTMLButtonElement).click();
}

describe('MfaSettings', () => {
	test('signed out: renders nothing and calls nothing', async () => {
		const { api, calls } = fakeApi(signedOut, {});
		const el = MfaSettings(api);
		await flush();
		assert.strictEqual(el.getAttribute('data-testid'), 'mfa-settings');
		assert.strictEqual(el.querySelector('form'), null);
		assert.deepStrictEqual(calls, []);
	});

	test('signed in: loads the settings (getMfaPreference) and renders each action as a form', async () => {
		const { api, calls } = fakeApi(signedIn, { getMfaPreference: settings(false) });
		const el = MfaSettings(api, { heading: 'Security' });
		await flush();
		assert.deepStrictEqual(calls, [{ action: 'getMfaPreference' }]);
		assert.strictEqual(byTestId(el, 'mfa-settings-heading')?.textContent, 'Security');
		assert.strictEqual(
			byTestId(el, 'mfa-settings-action-setUpTotp')?.textContent,
			'Set up authenticator app',
		);
		assert.strictEqual(byTestId(el, 'mfa-settings-action-signOut'), null, 'sign-out is not the panel’s job');
	});

	test('set up → the QR slot, the grouped setup key and the otpauth link; the code submits verifyTotpSetup', async () => {
		const qrCalls: string[] = [];
		const { api, calls } = fakeApi(signedIn, {
			getMfaPreference: settings(false),
			setUpTotp: settingUp,
			verifyTotpSetup: settings(true),
		});
		const el = MfaSettings(api, {
			renderQrCode: (uri) => {
				qrCalls.push(uri);
				const img = document.createElement('img');
				img.alt = 'QR';
				return img;
			},
		});
		await flush();
		click(el, 'mfa-settings-action-setUpTotp');
		await flush();
		assert.deepStrictEqual(calls.at(-1), { action: 'setUpTotp' });
		assert.deepStrictEqual(qrCalls, [URI]);
		assert.ok(byTestId(el, 'mfa-settings-qr')?.querySelector('img'));
		assert.strictEqual(byTestId(el, 'mfa-settings-secret')?.textContent, 'JBSW Y3DP EHPK 3PXP');
		assert.strictEqual(byTestId(el, 'mfa-settings-otpauth-uri')?.getAttribute('href'), URI);
		const hidden = inputAt(el, 'mfa-settings-sharedSecret');
		assert.strictEqual(hidden.type, 'hidden');
		assert.strictEqual(hidden.value, SECRET);

		const code = inputAt(el, 'mfa-settings-code');
		assert.strictEqual(code.autocomplete, 'one-time-code');
		// Accessible names: a real <label> for the code input, a caption for the setup key.
		const codeLabel = el.querySelector(`label[for="${code.id}"]`);
		assert.ok(code.id && codeLabel, 'the code input has a <label for>');
		assert.strictEqual(codeLabel.textContent, 'Code from Authenticator');
		const secretEl = byTestId(el, 'mfa-settings-secret');
		const labelledBy = secretEl?.getAttribute('aria-labelledby') ?? '';
		assert.strictEqual(el.querySelector(`[id="${labelledBy}"]`)?.textContent, 'Setup key');
		code.value = '123456';
		click(el, 'mfa-settings-action-verifyTotpSetup');
		await flush();
		assert.deepStrictEqual(calls.at(-1), {
			action: 'verifyTotpSetup',
			sharedSecret: SECRET,
			otpauthUri: URI,
			code: '123456',
		});
		assert.strictEqual(byTestId(el, 'mfa-settings-action-setUpTotp')?.textContent, 'Replace authenticator app');
		assert.ok(byTestId(el, 'mfa-settings-action-updateMfaPreference-totp-disabled'));
	});

	test('a wrong code is retriable: the setup panel stays, with the error', async () => {
		const { api } = fakeApi(signedIn, {
			getMfaPreference: settings(false),
			setUpTotp: settingUp,
			verifyTotpSetup: { state: 'signedOut', actions: [], error: 'Code mismatch', retriable: true },
		});
		const el = MfaSettings(api);
		await flush();
		click(el, 'mfa-settings-action-setUpTotp');
		await flush();
		click(el, 'mfa-settings-action-verifyTotpSetup');
		await flush();
		assert.strictEqual(byTestId(el, 'mfa-settings-error')?.textContent, 'Code mismatch');
		assert.ok(byTestId(el, 'mfa-settings-action-verifyTotpSetup'), 'the code form is still there');
		assert.ok(byTestId(el, 'mfa-settings-secret'));
	});

	test('a preference form submits its change; Cancel goes back to the settings', async () => {
		const { api, calls } = fakeApi(signedIn, {
			getMfaPreference: settings(true),
			setUpTotp: settingUp,
			updateMfaPreference: settings(false),
		});
		const el = MfaSettings(api);
		await flush();
		click(el, 'mfa-settings-action-setUpTotp');
		await flush();
		click(el, 'mfa-settings-action-getMfaPreference');
		await flush();
		assert.deepStrictEqual(calls.at(-1), { action: 'getMfaPreference' });
		click(el, 'mfa-settings-action-updateMfaPreference-totp-disabled');
		await flush();
		assert.deepStrictEqual(calls.at(-1), { action: 'updateMfaPreference', totp: 'DISABLED' });
		assert.strictEqual(byTestId(el, 'mfa-settings-action-updateMfaPreference-totp-disabled'), null);
	});

	test('a not-signed-in answer shows its error and no settings', async () => {
		const { api } = fakeApi(signedIn, {
			getMfaPreference: {
				state: 'signedOut',
				actions: [{ name: 'signIn', label: 'Sign In', fields: [] }],
				error: 'Not authenticated',
				errorName: 'NotAuthenticatedException',
			},
		});
		const el = MfaSettings(api);
		await flush();
		assert.strictEqual(byTestId(el, 'mfa-settings-error')?.textContent, 'Not authenticated');
		assert.strictEqual(el.querySelector('form'), null);
	});

	test('leaves the shared auth-state store alone (a mounted Authenticator keeps its signed-in view)', async () => {
		const { api } = fakeApi(signedIn, { getMfaPreference: settings(false), setUpTotp: settingUp });
		const el = MfaSettings(api);
		await flush();
		click(el, 'mfa-settings-action-setUpTotp');
		await flush();
		assert.strictEqual(getAuthStateSnapshot(api), signedIn);
	});
});
