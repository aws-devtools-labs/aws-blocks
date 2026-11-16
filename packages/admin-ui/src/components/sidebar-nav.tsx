// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

'use client';

import {
	ChartLine,
	CircleDollarSign,
	Component,
	Gauge,
	Rocket,
	ScrollText,
	SlidersHorizontal,
	Terminal,
} from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@/lib/utils';

/*
 * `Resources` is deliberately NOT here any more.
 *
 * Deployed resources now reach you two ways that are both closer to the thing you
 * were looking at: a block's own resources are on the block, and the framework's
 * are cards in the second-level nav under `Blocks`. A top-level entry as well
 * would be a third route to the same inventory, and the one place it led — the
 * whole-stack list — is still reachable at `/resources`, linked from Overview and
 * from the Blocks page.
 */
const NAV = [
	{ href: '/', label: 'Overview', icon: Gauge },
	// Declared before deployed: what the app says it has comes before what CFN shipped.
	{ href: '/blocks', label: 'Blocks', icon: Component },
	// Next to Blocks: the playground calls the methods those blocks declare.
	{ href: '/playground', label: 'Playground', icon: Terminal },
	{ href: '/deployments', label: 'Deployments', icon: Rocket },
	{ href: '/logs', label: 'Logs', icon: ScrollText },
	// Between Logs and Cost deliberately: all three read the deployed stage, and
	// this is the one that says how much the app is being used before Cost says
	// what that used cost.
	{ href: '/usage', label: 'Usage', icon: ChartLine },
	{ href: '/cost', label: 'Cost', icon: CircleDollarSign },
	// Last, and after Cost on purpose: it is the only entry that WRITES, so it
	// sits apart from the five read-only views rather than among them.
	{ href: '/settings', label: 'Settings', icon: SlidersHorizontal },
];

export function SidebarNav() {
	const pathname = usePathname();

	return (
		<nav className="flex flex-col gap-0.5 px-2">
			{NAV.map((item) => {
				const active = item.href === '/' ? pathname === '/' : pathname.startsWith(item.href);
				const Icon = item.icon;
				return (
					<Link
						key={item.href}
						href={item.href}
						title={item.label}
						className={cn(
							'flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-[13px] transition-colors',
							active ? 'bg-active text-fg' : 'text-fg-soft hover:bg-hover hover:text-fg',
						)}
					>
						<Icon size={15} strokeWidth={1.8} className={cn('shrink-0', active ? 'text-brand' : 'text-fg-dim')} />
						{/*
						 * The label stays in the DOM when the rail is collapsed and is hidden
						 * by CSS instead: the hover-expanded rail then needs no re-render, and
						 * the link's accessible name never depends on the collapsed state. The
						 * `title` covers the collapsed rail's tooltip.
						 */}
						<span className="primary-rail-label">{item.label}</span>
					</Link>
				);
			})}
		</nav>
	);
}
