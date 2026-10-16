// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

'use client';

import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import {
	DEFAULT_THEME_PREFERENCE,
	pendingResolvedTheme,
	readStoredPreference,
	readSystemPrefersDark,
	type ResolvedTheme,
	resolveTheme,
	SYSTEM_DARK_QUERY,
	THEME_ATTRIBUTE,
	THEME_STORAGE_KEY,
	type ThemePreference,
} from '@/theme/preference';

/**
 * Theme selection. All the decisions live in `@/theme/preference` where unit
 * tests can reach them; this file is only the React and DOM plumbing:
 *
 *   - the inline `<head>` script has already applied the stored preference to
 *     `data-theme` before first paint, so mounting here is React catching up
 *     with what the page is *already* showing, not applying it for the first time
 *     -- which is why this provider must write NOTHING until it has actually read
 *     the browser, rather than write a default and correct it
 *   - `system` follows the OS live, because a preference that only updates on
 *     reload is indistinguishable from a broken one
 */
const ThemeContext = createContext<{
	preference: ThemePreference;
	/**
	 * What `system` would resolve to right now, independent of the current
	 * preference. Separate from the applied theme on purpose: a control that
	 * offers "follow the system" has to say what the *system* says, and reading
	 * that off the applied theme would make it claim dark simply because dark was
	 * chosen.
	 */
	systemTheme: ResolvedTheme;
	setPreference: (preference: ThemePreference) => void;
}>({
	preference: DEFAULT_THEME_PREFERENCE,
	systemTheme: 'dark',
	setPreference: () => {},
});

export function ThemeProvider({ children }: { children: React.ReactNode }) {
	// `null` is "not read yet", NOT a default: the server has no preference and no
	// media query, and the boot script has already applied the right answer to
	// `data-theme` before React mounts. Starting from a concrete placeholder here
	// is what let the mount effect overwrite that correct answer with dark for a
	// frame on every light-themed load.
	const [preference, setPreferenceState] = useState<ThemePreference | null>(null);
	const [systemPrefersDark, setSystemPrefersDark] = useState<boolean | null>(null);

	useEffect(() => {
		// Both reads are guarded in the theme module: an exception escaping here
		// unmounts the whole dashboard, and a theme preference must never be able
		// to do that. Verified live -- an unguarded read blanked every page.
		setPreferenceState(readStoredPreference(() => window.localStorage.getItem(THEME_STORAGE_KEY)));
		setSystemPrefersDark(readSystemPrefersDark(() => window.matchMedia(SYSTEM_DARK_QUERY)));
	}, []);

	// Subscribed unconditionally: the signal is only *consulted* when the
	// preference is `system`, and re-subscribing on every preference change would
	// miss an OS flip that happens while an explicit theme is selected.
	useEffect(() => {
		const query = window.matchMedia(SYSTEM_DARK_QUERY);
		const onChange = (event: MediaQueryListEvent) => setSystemPrefersDark(event.matches);
		query.addEventListener('change', onChange);
		return () => query.removeEventListener('change', onChange);
	}, []);

	const pending = pendingResolvedTheme(preference, systemPrefersDark);

	useEffect(() => {
		// `null` means the browser has not been read yet, so the boot script's
		// pre-paint answer is the best one available and must be left alone.
		if (pending === null) return;
		document.documentElement.setAttribute(THEME_ATTRIBUTE, pending);
	}, [pending]);

	const setPreference = useCallback((next: ThemePreference) => {
		try {
			window.localStorage.setItem(THEME_STORAGE_KEY, next);
		} catch {
			// Private-mode storage can refuse a write. The choice still applies to
			// this page; it just will not survive a reload, which is better than
			// letting the click throw.
		}
		setPreferenceState(next);
	}, []);

	return (
		<ThemeContext.Provider
			value={{
				// The control has to render something before the read lands, and the
				// default is what the boot script also falls back to, so the two agree.
				preference: preference ?? DEFAULT_THEME_PREFERENCE,
				systemTheme: resolveTheme('system', systemPrefersDark ?? true),
				setPreference,
			}}
		>
			{children}
		</ThemeContext.Provider>
	);
}

export function useTheme() {
	return useContext(ThemeContext);
}
