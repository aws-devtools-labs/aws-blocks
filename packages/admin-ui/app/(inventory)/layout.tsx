// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { InventoryNav } from '@/components/inventory-nav';

/**
 * Shared shell for the block and resource views.
 *
 * `(inventory)` is a route GROUP: it does not appear in any URL, so every path
 * under it is unchanged. It exists so ONE layout renders the second-level nav
 * across `/blocks`, `/blocks/[fullId]` and `/resources` — and because an App
 * Router layout persists across navigation within its subtree, the nav is not
 * unmounted and its queries are not refetched when you move between blocks.
 *
 * The alternative was a `layout.tsx` under each of `blocks/` and `resources/`,
 * which is two copies of the same shell and two nav instances that remount as
 * you cross between them.
 */
export default function InventoryLayout({ children }: { children: React.ReactNode }) {
	return (
		/*
		 * `min-h-full` so the row is at least as tall as the main column, which makes
		 * the aside — a stretched flex item — full height rather than as tall as the
		 * nav happens to be. Without it the divider stopped wherever the shorter of
		 * nav and content ended, leaving a line that trails off mid-page.
		 */
		<div className="flex min-h-full gap-6">
			{/*
			 * `-my-6 py-6` cancels the parent main's `p-6` on the vertical axis, so the
			 * divider runs edge to edge instead of stopping 24px short at the top and
			 * bottom. It has to sit on the `aside`, since that is the element carrying
			 * the border — extending an inner wrapper would move nothing.
			 */}
			<aside className="-my-6 w-72 shrink-0 border-r border-line py-6 pr-4">
				{/*
				 * Sticky so the list stays put while a long block page scrolls — the
				 * point of a second-level nav is switching without going back. The
				 * offset keeps it aligned with the content's own top padding. The nav
				 * owns its scroll container, because it also has to scroll the open card
				 * into view.
				 */}
				<div className="sticky top-6">
					<InventoryNav />
				</div>
			</aside>
			<div className="min-w-0 flex-1">{children}</div>
		</div>
	);
}
