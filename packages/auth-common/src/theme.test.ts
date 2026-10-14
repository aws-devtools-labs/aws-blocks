// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { beforeEach, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
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

// ---------------------------------------------------------------------------
// Class-name contract — every `bb-*` class a factory assigns must be a
// selector in THEME_CSS. This is the entire visual contract of the theme:
// without it a typo (`bb-butotn`) or a one-sided rename renders the component
// unstyled while every other assertion stays green. The factories assign most
// classes inside async `onAuthChange` callbacks, so a live-render walk only
// sees a subset; scanning the ui.ts source for `className = '...'` literals
// catches the whole set deterministically, both directions (a class the code
// renders that the CSS lacks, and drift either way).
// ---------------------------------------------------------------------------

describe('bb-* class contract: every class ui.ts assigns exists in THEME_CSS', () => {
	// ui.ts source lives next to this test's source; the test runs from dist,
	// so resolve back to ../src relative to the compiled file.
	const uiSource = readFileSync(
		fileURLToPath(new URL('../src/ui.ts', import.meta.url)),
		'utf-8',
	);

	/** Every `bb-*` token across all `className = '...'` assignments in ui.ts. */
	function renderedBbClasses(): Set<string> {
		const found = new Set<string>();
		for (const m of uiSource.matchAll(/className\s*=\s*'([^']+)'/g)) {
			const classAttr = m[1] ?? '';
			for (const token of classAttr.split(/\s+/)) {
				if (token.startsWith('bb-')) found.add(token);
			}
		}
		return found;
	}

	/** Does THEME_CSS declare a rule selecting this class? */
	function cssDefinesClass(cls: string): boolean {
		// Match `.bb-foo` as a whole token — the negative lookahead stops
		// `.bb-button` from spuriously matching `.bb-button-primary`.
		return new RegExp(`\\.${cls}(?![\\w-])`).test(THEME_CSS);
	}

	test('ui.ts assigns at least a handful of bb-* classes', () => {
		assert.ok(renderedBbClasses().size >= 10, 'the scan found the component classes');
	});

	test('every class ui.ts renders is defined in THEME_CSS', () => {
		for (const cls of renderedBbClasses()) {
			assert.ok(cssDefinesClass(cls), `THEME_CSS defines a selector for .${cls} (assigned in ui.ts)`);
		}
	});
});
