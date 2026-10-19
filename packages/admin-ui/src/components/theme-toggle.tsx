// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

'use client';

import { Monitor, Moon, Sun } from 'lucide-react';
import { useTheme } from '@/components/theme-context';
import { cn } from '@/lib/utils';
import { THEME_PREFERENCES, type ThemePreference } from '@/theme/preference';

/**
 * Theme control. Visually the stage switcher's twin, because they are the same
 * kind of thing in the same bar and inventing a second idiom for it would only
 * make both harder to recognise.
 *
 * Semantics are toggle buttons in a labelled group rather than a radio group: a
 * radio group is arguably the better match for single-select, but it is only
 * correct with a roving tabindex and arrow-key handling, and a half-built radio
 * group behaves worse under a screen reader than three plain buttons that are
 * each Tab-reachable and activate on Enter or Space.
 */
const CONTROLS: Record<ThemePreference, { Icon: typeof Monitor; label: string }> = {
	system: { Icon: Monitor, label: 'Follow the system theme' },
	light: { Icon: Sun, label: 'Light theme' },
	dark: { Icon: Moon, label: 'Dark theme' },
};

export function ThemeToggle() {
	const { preference, systemTheme, setPreference } = useTheme();

	return (
		<div role="group" aria-label="Theme" className="flex gap-1 rounded-lg bg-hover p-0.5">
			{THEME_PREFERENCES.map((option) => {
				const { Icon, label } = CONTROLS[option];
				// `system` names what the OS currently asks for -- deliberately the
				// system's own answer, not the applied theme, or picking dark would make
				// this button claim the system wants dark too.
				const description = option === 'system' ? `${label} (currently ${systemTheme})` : label;
				// Pressed tracks the PREFERENCE, never the resolved theme: with `system`
				// chosen on a dark OS it is `system` that is pressed, not `dark`.
				const selected = preference === option;

				return (
					<button
						key={option}
						type="button"
						onClick={() => setPreference(option)}
						aria-pressed={selected}
						aria-label={description}
						title={description}
						className={cn(
							'rounded-md p-1.5 transition-colors',
							selected ? 'bg-active text-fg' : 'text-fg-soft hover:text-fg',
						)}
					>
						{/* Decorative: the accessible name is on the button. */}
						<Icon className="size-4" aria-hidden="true" />
					</button>
				);
			})}
		</div>
	);
}
