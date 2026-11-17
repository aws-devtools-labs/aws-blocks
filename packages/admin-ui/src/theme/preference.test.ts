// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert';
import { describe, it } from 'node:test';

import {
	DEFAULT_THEME_PREFERENCE,
	isThemePreference,
	parseThemePreference,
	pendingResolvedTheme,
	readStoredPreference,
	readSystemPrefersDark,
	resolveTheme,
	SYSTEM_DARK_QUERY,
	THEME_ATTRIBUTE,
	THEME_PREFERENCES,
	THEME_STORAGE_KEY,
	type ThemePreference,
	themeBootScript,
} from './preference.js';

/**
 * Run the SHIPPED boot-script string against stubbed globals and report what it
 * set on the document. Executing it is the point: asserting that the string
 * contains the constants it was built from would prove nothing about behaviour,
 * and this is code no unit test could otherwise reach because it runs before any
 * bundle loads.
 */
function runBootScript(options: { stored?: string | null; systemPrefersDark?: boolean; storageThrows?: boolean }): {
	applied: string | null;
	attributeName: string | null;
} {
	let applied: string | null = null;
	let attributeName: string | null = null;

	const localStorage = {
		getItem(name: string): string | null {
			if (options.storageThrows) throw new Error('The operation is insecure.');
			return name === THEME_STORAGE_KEY ? (options.stored ?? null) : null;
		},
	};
	const win = {
		matchMedia(query: string) {
			return { matches: query === SYSTEM_DARK_QUERY && options.systemPrefersDark === true };
		},
	};
	const doc = {
		documentElement: {
			setAttribute(name: string, value: string) {
				attributeName = name;
				applied = value;
			},
		},
	};

	// `new Function` is the point: it executes the shipped string rather than
	// asserting on its text.
	new Function('localStorage', 'window', 'document', themeBootScript())(localStorage, win, doc);
	return { applied, attributeName };
}

describe('theme preference -- accepting only what the palette can render', () => {
	it('accepts exactly the three preferences', () => {
		assert.deepStrictEqual([...THEME_PREFERENCES], ['system', 'light', 'dark']);
		for (const preference of THEME_PREFERENCES) {
			assert.ok(isThemePreference(preference), `${preference} must be a valid preference`);
		}
	});

	it('rejects a value that is not a preference', () => {
		for (const value of ['Dark', 'DARK', 'blue', '', ' dark', null, undefined, 0, {}]) {
			assert.strictEqual(isThemePreference(value), false, `${String(value)} must not be accepted`);
		}
	});

	it('falls back to the default rather than throwing on stored garbage', () => {
		// Storage outlives any rename we make, and a user can edit it by hand.
		assert.strictEqual(parseThemePreference('midnight'), DEFAULT_THEME_PREFERENCE);
		assert.strictEqual(parseThemePreference(null), DEFAULT_THEME_PREFERENCE);
		assert.strictEqual(parseThemePreference(undefined), DEFAULT_THEME_PREFERENCE);
		assert.strictEqual(parseThemePreference(''), DEFAULT_THEME_PREFERENCE);
	});

	it('preserves a stored preference verbatim', () => {
		assert.strictEqual(parseThemePreference('light'), 'light');
		assert.strictEqual(parseThemePreference('dark'), 'dark');
		assert.strictEqual(parseThemePreference('system'), 'system');
	});

	it('defaults to following the system', () => {
		assert.strictEqual(DEFAULT_THEME_PREFERENCE, 'system');
	});
});

describe('resolveTheme -- system is resolved, never rendered', () => {
	const cases: Array<[ThemePreference, boolean, string]> = [
		['system', true, 'dark'],
		['system', false, 'light'],
		['dark', true, 'dark'],
		['dark', false, 'dark'],
		['light', true, 'light'],
		['light', false, 'light'],
	];

	for (const [preference, systemPrefersDark, expected] of cases) {
		it(`${preference} + system:${systemPrefersDark ? 'dark' : 'light'} -> ${expected}`, () => {
			assert.strictEqual(resolveTheme(preference, systemPrefersDark), expected);
		});
	}

	it('ignores the system signal once a theme is chosen explicitly', () => {
		// The whole point of an explicit choice: the OS flipping must not move it.
		assert.strictEqual(resolveTheme('light', true), resolveTheme('light', false));
		assert.strictEqual(resolveTheme('dark', false), resolveTheme('dark', true));
	});
});

describe('pendingResolvedTheme -- unread is not a palette', () => {
	// The boot script writes the right answer before paint. The provider mounting
	// with a PLACEHOLDER and writing it overwrote that answer with dark for a
	// frame on every light-themed load (measured live: light -> dark -> light
	// inside 45ms). So an unread signal must resolve to "write nothing".
	it('writes nothing when neither the preference nor the OS signal is read', () => {
		assert.strictEqual(pendingResolvedTheme(null, null), null);
	});

	it('writes nothing when only the OS signal is read', () => {
		assert.strictEqual(pendingResolvedTheme(null, false), null);
		assert.strictEqual(pendingResolvedTheme(null, true), null);
	});

	it('writes nothing when only the preference is read, even an explicit one', () => {
		// An explicit preference does not need the OS signal to resolve, but both
		// are read in one effect, so "one known, one not" means the read is still
		// in flight -- treating it as complete is how the placeholder leaks back.
		assert.strictEqual(pendingResolvedTheme('system', null), null);
		assert.strictEqual(pendingResolvedTheme('dark', null), null);
		assert.strictEqual(pendingResolvedTheme('light', null), null);
	});

	it('agrees with resolveTheme once both are read', () => {
		for (const preference of THEME_PREFERENCES) {
			for (const systemPrefersDark of [true, false]) {
				assert.strictEqual(
					pendingResolvedTheme(preference, systemPrefersDark),
					resolveTheme(preference, systemPrefersDark),
					`${preference} + system:${systemPrefersDark}`,
				);
			}
		}
	});

	it('never resolves an unread signal to the dark fallback', () => {
		// Specifically NOT dark: `:root` is already dark and the boot script may
		// legitimately have written light, so falling back to dark here is the
		// defect rather than a safe default.
		assert.notStrictEqual(pendingResolvedTheme(null, null), 'dark');
		assert.notStrictEqual(pendingResolvedTheme('system', null), 'dark');
	});
});

describe('reading the environment -- neither storage nor the media query may take the app down', () => {
	it('returns the stored preference when storage answers', () => {
		assert.strictEqual(
			readStoredPreference(() => 'light'),
			'light',
		);
		assert.strictEqual(
			readStoredPreference(() => null),
			DEFAULT_THEME_PREFERENCE,
		);
	});

	it('survives storage that THROWS rather than returning null', () => {
		// Observed live: an unguarded read propagated out of the provider's mount
		// effect and blanked the whole dashboard with "The operation is insecure."
		// Privacy modes and partitioned contexts refuse storage access outright.
		const insecure = () => {
			throw new DOMException('The operation is insecure.', 'SecurityError');
		};
		assert.doesNotThrow(() => readStoredPreference(insecure));
		assert.strictEqual(readStoredPreference(insecure), DEFAULT_THEME_PREFERENCE);
	});

	it('reads the OS signal when the query answers', () => {
		assert.strictEqual(
			readSystemPrefersDark(() => ({ matches: true })),
			true,
		);
		assert.strictEqual(
			readSystemPrefersDark(() => ({ matches: false })),
			false,
		);
	});

	it('falls back to dark when the OS signal cannot be read at all', () => {
		// Dark matches `:root` and the server-rendered default, so an unreadable
		// signal causes no visible flip. Absent and throwing are the same case.
		assert.strictEqual(
			readSystemPrefersDark(() => null),
			true,
		);
		assert.strictEqual(
			readSystemPrefersDark(() => undefined),
			true,
		);
		assert.strictEqual(
			readSystemPrefersDark(() => {
				throw new Error('matchMedia unavailable');
			}),
			true,
		);
	});
});

describe('themeBootScript -- what the browser runs before first paint', () => {
	it('applies a stored explicit preference against the OS signal', () => {
		// A light preference on a dark-mode OS is the case that would flash.
		assert.deepStrictEqual(runBootScript({ stored: 'light', systemPrefersDark: true }), {
			applied: 'light',
			attributeName: THEME_ATTRIBUTE,
		});
		assert.strictEqual(runBootScript({ stored: 'dark', systemPrefersDark: false }).applied, 'dark');
	});

	it('resolves a stored system preference from the media query', () => {
		assert.strictEqual(runBootScript({ stored: 'system', systemPrefersDark: true }).applied, 'dark');
		assert.strictEqual(runBootScript({ stored: 'system', systemPrefersDark: false }).applied, 'light');
	});

	it('treats nothing stored as the default preference', () => {
		assert.strictEqual(runBootScript({ stored: null, systemPrefersDark: false }).applied, 'light');
		assert.strictEqual(runBootScript({ stored: null, systemPrefersDark: true }).applied, 'dark');
	});

	it('ignores a stored value it does not recognise', () => {
		assert.strictEqual(runBootScript({ stored: 'midnight', systemPrefersDark: false }).applied, 'light');
	});

	it('writes the same attribute the stylesheet keys on', () => {
		assert.strictEqual(runBootScript({ stored: 'light' }).attributeName, 'data-theme');
	});

	it('survives storage that throws, leaving the dark default in place', () => {
		// Private browsing can make localStorage access throw. An exception escaping
		// an inline head script would abort it, so nothing may propagate.
		let result: { applied: string | null } | undefined;
		assert.doesNotThrow(() => {
			result = runBootScript({ storageThrows: true, systemPrefersDark: false });
		});
		// Nothing was applied, so `:root` (dark) stands -- a styled page, not an unstyled one.
		assert.strictEqual(result?.applied, null);
	});

	it('is synchronous and self-contained, so it can be inlined in <head>', () => {
		const source = themeBootScript();
		assert.ok(source.startsWith('(function(){'), 'must be an IIFE, not a declaration');
		assert.ok(!/\bimport\b|\brequire\(|\basync\b|await |addEventListener/.test(source), 'must not defer work');
	});
});
