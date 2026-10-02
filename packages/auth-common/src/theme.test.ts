// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert';
import { beforeEach, describe, test } from 'node:test';
import { Window } from 'happy-dom';
import type { AuthState } from './index.js';
import type { AuthStateApi } from './ui.js';

// ---------------------------------------------------------------------------
// happy-dom setup — install globals before importing the modules under test
// ---------------------------------------------------------------------------

const window = new Window();

// happy-dom doesn't implement BroadcastChannel — the UI factories construct
// one via onAuthChange, so provide a minimal no-op shim.
class BroadcastChannelShim {
	name: string;
	constructor(name: string) {
		this.name = name;
	}
	postMessage(_data: unknown) {}
	addEventListener(_type: string, _fn: unknown) {}
	removeEventListener(_type: string, _fn: unknown) {}
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

// Import after globals are set.
const { injectTheme, THEME_CSS, THEME_STYLE_ID } = await import('./theme.js');
const { Authenticator, AuthenticatedContent, AccountMenuBar } = await import('./ui.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Remove the injected theme <style> so each test starts clean. */
function clearTheme(): void {
	document.getElementById(THEME_STYLE_ID)?.remove();
}

function styleEls(): NodeListOf<Element> {
	return document.querySelectorAll(`#${THEME_STYLE_ID}`);
}

function signedOutApi(): AuthStateApi {
	const state: AuthState = {
		state: 'signedOut',
		actions: [{ name: 'signIn', label: 'Sign In', fields: [] }],
	};
	return {
		async getAuthState() {
			return state;
		},
		async setAuthState() {
			return state;
		},
	};
}

// ---------------------------------------------------------------------------
// injectTheme
// ---------------------------------------------------------------------------

describe('injectTheme', () => {
	beforeEach(() => {
		clearTheme();
	});

	test('appends exactly one <style> carrying the theme CSS', () => {
		injectTheme();

		const els = styleEls();
		assert.strictEqual(els.length, 1, 'exactly one theme <style> is present');
		const style = els[0];
		assert.strictEqual(style.tagName, 'STYLE');
		assert.strictEqual(style.id, THEME_STYLE_ID);
		assert.strictEqual(style.textContent, THEME_CSS, 'style carries THEME_CSS verbatim');
		assert.ok(THEME_CSS.includes('--bb-color-accent'), 'THEME_CSS declares the --bb-* tokens');
	});

	test('is idempotent — a second call is a no-op (keyed on THEME_STYLE_ID)', () => {
		injectTheme();
		injectTheme();
		injectTheme();

		assert.strictEqual(styleEls().length, 1, 'repeated calls never duplicate the <style>');
	});

	test('returns silently when there is no document (SSR-safe)', () => {
		// A server environment has no DOM. Model `globalThis` as a bag with an
		// optional `document` so we can remove it without a cast.
		const g: { document?: unknown } = globalThis;
		const saved = g.document;
		try {
			g.document = undefined;
			assert.doesNotThrow(() => injectTheme(), 'injectTheme must not throw without a document');
		} finally {
			g.document = saved;
		}
	});
});

// ---------------------------------------------------------------------------
// Factory self-injection contract — "the theme travels with the component"
// ---------------------------------------------------------------------------

describe('UI factories inject the theme', () => {
	beforeEach(() => {
		clearTheme();
	});

	test('Authenticator injects the theme on construction', () => {
		Authenticator(signedOutApi());
		assert.strictEqual(styleEls().length, 1, 'Authenticator injects the theme <style>');
	});

	test('AccountMenuBar injects the theme on construction', () => {
		AccountMenuBar(signedOutApi());
		assert.strictEqual(styleEls().length, 1, 'AccountMenuBar injects the theme <style>');
	});

	test('AuthenticatedContent injects the theme on construction', () => {
		// Regression guard: a direct consumer mounting ONLY AuthenticatedContent
		// (without the other factories and without calling injectTheme itself)
		// must still get the tokens, per the self-contained-component contract.
		AuthenticatedContent(signedOutApi(), (user) => {
			const el = document.createElement('span');
			el.textContent = user.username;
			return el;
		});
		assert.strictEqual(styleEls().length, 1, 'AuthenticatedContent injects the theme <style>');
	});
});
