// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

'use client';

import { PanelLeftClose, PanelLeftOpen } from 'lucide-react';
import { useEffect, useState } from 'react';
import { SidebarNav } from '@/components/sidebar-nav';
import {
	DEFAULT_SIDEBAR_STATE,
	SIDEBAR_ATTRIBUTE,
	SIDEBAR_STORAGE_KEY,
	parseSidebarState,
	readStoredSidebarState,
	sidebarToggleLabel,
	toggleSidebarState,
	writeStoredSidebarState,
} from '@/nav/sidebar-preference';
import type { SidebarState } from '@/nav/sidebar-preference';

/**
 * The first-level navigation rail, and the control that narrows it to icons.
 *
 * The WIDTH is driven from `data-sidebar` on `<html>` in `globals.css`, not from
 * this component's state, for the same reason the theme is: an inline `<head>`
 * script applies the stored value before first paint, so a collapsed rail never
 * renders 208px wide and then snaps shut. React reads that same attribute on
 * mount so its own state agrees with what is already on screen, and writes the
 * attribute plus storage on every toggle — one source of truth, applied twice.
 *
 * Collapsed, the rail stays 56px wide in the layout while the panel INSIDE it
 * overlays the content on hover. Widening the rail itself would reflow the whole
 * page under the pointer, which is a worse cost than the overlay's shadow.
 */
export function PrimarySidebar() {
	const [state, setState] = useState<SidebarState>(DEFAULT_SIDEBAR_STATE);

	// Adopt what the boot script already applied, rather than imposing a default
	// over it. Reading the attribute (not storage) keeps this in step with what the
	// reader can actually see, even if storage was refused a moment ago.
	useEffect(() => {
		const applied = document.documentElement.getAttribute(SIDEBAR_ATTRIBUTE);
		setState(
			applied
				? parseSidebarState(applied)
				: readStoredSidebarState(() => window.localStorage.getItem(SIDEBAR_STORAGE_KEY)),
		);
	}, []);

	const toggle = () => {
		const next = toggleSidebarState(state);
		setState(next);
		document.documentElement.setAttribute(SIDEBAR_ATTRIBUTE, next);
		writeStoredSidebarState((value) => window.localStorage.setItem(SIDEBAR_STORAGE_KEY, value), next);
	};

	const collapsed = state === 'collapsed';
	const label = sidebarToggleLabel(state);
	const Icon = collapsed ? PanelLeftOpen : PanelLeftClose;

	return (
		<aside className="primary-rail relative w-52 shrink-0 border-r border-line bg-panel">
			{/*
			 * The panel is absolutely positioned when collapsed so its hover width
			 * overlays the content instead of pushing it. `inset-y-0` makes it full
			 * height either way, so the rail's own border stays the full-height one.
			 */}
			<div className="primary-rail-panel h-full">
				{/*
				 * Sticky and viewport-tall (less the 3rem header), so the toggle pinned
				 * to the bottom of this column is pinned to the bottom of the SCREEN.
				 * With `mt-auto` alone it sat at the bottom of a full-height rail, which
				 * on a long page meant scrolling to the end of the document to find the
				 * control that expands the navigation again.
				 */}
				<div className="sticky top-0 flex h-[calc(100vh-3rem)] flex-col pt-3">
					<SidebarNav />
					<div className="mt-auto p-2">
						<button
							type="button"
							onClick={toggle}
							aria-expanded={!collapsed}
							aria-label={label}
							title={label}
							/*
							 * Deliberately NOT centred when collapsed. The label is hidden with
							 * `opacity`, which leaves it occupying layout — so `justify-center`
							 * centred icon-plus-label as a group and pushed the icon off the
							 * left edge of a 56px rail (measured at x=-3). Left-aligned with the
							 * same padding as the nav links, its icon lands on the same 26px
							 * centre line as theirs.
							 */
							className="flex w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-[13px] text-fg-dim transition-colors hover:bg-hover hover:text-fg"
						>
							<Icon size={15} strokeWidth={1.8} aria-hidden="true" className="shrink-0" />
							{/* Kept in the DOM and hidden by CSS, so the hover-expanded rail can
							    show it without a second render — and so the accessible name of
							    the control never depends on the collapsed state. */}
							<span className="primary-rail-label">Collapse</span>
						</button>
					</div>
				</div>
			</div>
		</aside>
	);
}
