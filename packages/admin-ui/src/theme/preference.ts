// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Theme preference resolution -- every decision the theme switch makes, with no
 * React, `window` or `document` in sight.
 *
 * WHY THIS IS ITS OWN DIRECTORY
 * -----------------------------
 * The test runner only sees `dist/**`, which `tsconfig.server.json` compiles, so
 * anything under `app/` or a `.tsx` file is unreachable by a unit test. Rather
 * than leave the resolution rules in the provider where nothing could assert on
 * them, they live here and `src/theme` is added to that tsconfig's `include`.
 * The module is therefore compiled twice -- once by tsc for the tests, once by
 * Next for the browser -- which is the price of being testable and is paid by
 * one small dependency-free file.
 */

/** What the user chose. `system` is a preference, never a palette. */
export type ThemePreference = 'system' | 'light' | 'dark';

/** What the document is actually painted in, after `system` is resolved. */
export type ResolvedTheme = 'light' | 'dark';

/** Order the header control renders, and the only accepted values. */
export const THEME_PREFERENCES: readonly ThemePreference[] = ['system', 'light', 'dark'];

/**
 * Following the OS is the right default for a tool that sits beside an editor,
 * and it is also the only default that is never wrong on a first visit.
 */
export const DEFAULT_THEME_PREFERENCE: ThemePreference = 'system';

/**
 * `localStorage`, deliberately unlike the stage selection's `sessionStorage`: a
 * stage is per-tab working context, whereas a theme is a durable preference and
 * a second tab opening in the other one would be a defect.
 */
export const THEME_STORAGE_KEY = 'blocks-dashboard-theme';

/** The attribute `globals.css` keys the light palette on (`html[data-theme='light']`). */
export const THEME_ATTRIBUTE = 'data-theme';

/** The OS-level signal `system` resolves against. */
export const SYSTEM_DARK_QUERY = '(prefers-color-scheme: dark)';

export function isThemePreference(value: unknown): value is ThemePreference {
	return value === 'system' || value === 'light' || value === 'dark';
}

/**
 * Storage is user-writable and outlives any rename we make, so an unrecognised
 * value falls back to the default rather than throwing or painting nothing.
 */
export function parseThemePreference(raw: string | null | undefined): ThemePreference {
	return isThemePreference(raw) ? raw : DEFAULT_THEME_PREFERENCE;
}

export function resolveTheme(preference: ThemePreference, systemPrefersDark: boolean): ResolvedTheme {
	if (preference === 'system') return systemPrefersDark ? 'dark' : 'light';
	return preference;
}

/**
 * The theme to write to `data-theme` right now, or `null` for "write nothing yet".
 *
 * A `null` input means the browser has not been READ yet, which is a different
 * state from having read it and got dark -- and the difference is load-bearing,
 * because the inline boot script has ALREADY written the correct answer before
 * React mounts. Resolving an unread signal to a palette makes the provider
 * overwrite that correct answer with its placeholder: measured live as
 * `light -> dark -> light` inside the first ~45ms of every load, i.e. a dark
 * frame painted on top of a correct light one. Writing nothing until both are
 * read leaves the boot script's answer standing, which is the whole reason it
 * runs before paint.
 *
 * Deliberately `null` even for an explicit `dark`/`light` preference whose OS
 * signal is still unread: the two are read in one effect, so "preference known,
 * OS unknown" is a state of the read itself being incomplete, and treating it as
 * complete is how the placeholder leaks back in.
 */
export function pendingResolvedTheme(
	preference: ThemePreference | null,
	systemPrefersDark: boolean | null,
): ResolvedTheme | null {
	if (preference === null || systemPrefersDark === null) return null;
	return resolveTheme(preference, systemPrefersDark);
}

/**
 * Read the stored preference through a caller-supplied getter, defensively.
 *
 * Storage access itself can THROW rather than return null -- privacy modes and
 * partitioned/embedded contexts refuse it outright -- and an exception escaping
 * this read used to propagate out of the provider's mount effect and blank the
 * entire dashboard. A theme preference must never be able to do that, so the
 * failure degrades to the default (and `:root`'s dark palette) instead.
 *
 * Takes a getter rather than a `Storage` so this module stays free of `window`
 * and the failure is reproducible in a unit test.
 */
export function readStoredPreference(read: () => string | null): ThemePreference {
	try {
		return parseThemePreference(read());
	} catch {
		return DEFAULT_THEME_PREFERENCE;
	}
}

/**
 * Read the OS colour-scheme signal through a caller-supplied matcher, defensively.
 *
 * Falls back to dark when the query is unavailable, matching both `:root` and the
 * server-rendered default so an unreadable signal cannot cause a visible flip.
 * That does mean `system` behaves as dark in that case, which is the honest
 * outcome when the OS preference genuinely cannot be read -- and the control says
 * so, because its hint reports this same value.
 */
export function readSystemPrefersDark(match: () => { matches: boolean } | null | undefined): boolean {
	try {
		const query = match();
		// Absent and throwing are the same case: the signal cannot be read.
		if (!query) return true;
		return query.matches === true;
	} catch {
		return true;
	}
}

/**
 * Source of the inline `<head>` script that applies the stored preference BEFORE
 * first paint. It has to be a string of its own rather than shared code, because
 * it must run before any bundle loads -- but it is built from the constants
 * above so the storage key and attribute cannot drift from the React path.
 *
 * `:root` carries the dark palette, so a failure here degrades to dark rather
 * than to an unstyled page; that is why the whole body is wrapped in try/catch
 * (private-mode `localStorage` access throws in some browsers) and why a light
 * preference is the only case that would ever have flashed.
 */
export function themeBootScript(): string {
	const key = JSON.stringify(THEME_STORAGE_KEY);
	const query = JSON.stringify(SYSTEM_DARK_QUERY);
	const attribute = JSON.stringify(THEME_ATTRIBUTE);
	return (
		'(function(){try{' +
		`var s=localStorage.getItem(${key});` +
		"var p=(s==='light'||s==='dark'||s==='system')?s:" +
		`${JSON.stringify(DEFAULT_THEME_PREFERENCE)};` +
		`var d=p==='system'?window.matchMedia(${query}).matches:p==='dark';` +
		`document.documentElement.setAttribute(${attribute},d?'dark':'light');` +
		'}catch(e){}})();'
	);
}
