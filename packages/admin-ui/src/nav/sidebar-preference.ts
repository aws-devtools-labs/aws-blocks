// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * First-level sidebar collapse — the rules, with no React, `window` or
 * `document` in sight.
 *
 * Deliberately built the same way as `src/theme/preference.ts`, for the same two
 * reasons. The test runner only sees `dist/**`, so rules left in a `.tsx` file
 * are unreachable by a unit test. And the stored value must be applied BEFORE
 * first paint: a rail that renders 208px wide and then snaps to 56px on
 * hydration is a layout shift on every page load, which is exactly the flash the
 * theme's boot script exists to avoid.
 */

/** Collapsed or not. A two-state preference, so a boolean would do — but the
 * attribute value has to be a string, and naming both states makes the CSS
 * selector and the tests read the same way. */
export type SidebarState = 'expanded' | 'collapsed';

export const SIDEBAR_STATES: readonly SidebarState[] = ['expanded', 'collapsed'];

/** Expanded: a first visit should show what the destinations are called. */
export const DEFAULT_SIDEBAR_STATE: SidebarState = 'expanded';

/**
 * `localStorage`, like the theme and unlike the stage selection: whether the
 * navigation is collapsed is a durable preference about the tool, not per-tab
 * working context, and having a second tab open it wide again would be a defect.
 */
export const SIDEBAR_STORAGE_KEY = 'blocks-dashboard-sidebar';

/** The attribute `globals.css` keys the collapsed rail on. */
export const SIDEBAR_ATTRIBUTE = 'data-sidebar';

export function isSidebarState(value: unknown): value is SidebarState {
	return value === 'expanded' || value === 'collapsed';
}

/**
 * Storage is user-writable and outlives any rename, so an unrecognised value
 * falls back to the default rather than leaving the rail in no state at all.
 */
export function parseSidebarState(raw: string | null | undefined): SidebarState {
	return isSidebarState(raw) ? raw : DEFAULT_SIDEBAR_STATE;
}

export function toggleSidebarState(state: SidebarState): SidebarState {
	return state === 'collapsed' ? 'expanded' : 'collapsed';
}

/**
 * Read the stored state through a caller-supplied getter, defensively.
 *
 * Storage access can THROW rather than return null — privacy modes and
 * partitioned contexts refuse it outright — and an exception escaping a mount
 * effect was observed blanking the entire dashboard when the theme did exactly
 * this. The failure degrades to the default instead.
 */
export function readStoredSidebarState(read: () => string | null): SidebarState {
	try {
		return parseSidebarState(read());
	} catch {
		return DEFAULT_SIDEBAR_STATE;
	}
}

/** Persist, defensively: a refused write must not take the toggle down with it. */
export function writeStoredSidebarState(write: (value: string) => void, state: SidebarState): void {
	try {
		write(state);
	} catch {
		// Nothing to do: the state still applies for this page, it just will not
		// survive a reload. Failing the click would be worse.
	}
}

/** What the control says it does. The label describes the ACTION, not the state. */
export function sidebarToggleLabel(state: SidebarState): string {
	return state === 'collapsed' ? 'Expand the navigation' : 'Collapse the navigation to icons';
}

/**
 * Source of the inline `<head>` script that applies the stored state BEFORE first
 * paint, so a collapsed rail never renders at full width and snap shut.
 *
 * A string rather than shared code because it must run before any bundle loads,
 * but built from the constants above so the key and attribute cannot drift from
 * the React path. Wrapped in try/catch because `localStorage` access itself
 * throws in some contexts; the default is `expanded`, which is also what the
 * server renders, so a failure here is invisible rather than broken.
 */
export function sidebarBootScript(): string {
	const key = JSON.stringify(SIDEBAR_STORAGE_KEY);
	const attribute = JSON.stringify(SIDEBAR_ATTRIBUTE);
	const fallback = JSON.stringify(DEFAULT_SIDEBAR_STATE);
	return (
		'(function(){try{' +
		`var s=localStorage.getItem(${key});` +
		`var v=(s==='collapsed'||s==='expanded')?s:${fallback};` +
		`document.documentElement.setAttribute(${attribute},v);` +
		'}catch(e){}})();'
	);
}
