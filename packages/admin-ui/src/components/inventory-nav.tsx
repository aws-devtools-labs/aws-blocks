// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

'use client';

import { useQuery } from '@tanstack/react-query';
import { ChevronDown, ChevronRight, Search } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useId, useRef, useState } from 'react';
import { useEnvironment } from '@/components/environment-context';
import { TONE_VARIANT } from '@/components/nav-tone';
import { Badge } from '@/components/ui/badge';
import type { BlocksResponse, ResourcesResponse } from '@/contract/v1';
import { apiGet } from '@/lib/api-client';
import { cn } from '@/lib/utils';
import {
	buildInventoryTree,
	filterTree,
	isCardActive,
	isSectionActive,
	NAV_RESOURCES_NOT_APPLICABLE,
	navStatus,
} from '@/nav/inventory-tree';
import type { NavCard, NavSection, NavStatus, ResourcesState } from '@/nav/inventory-tree';

/**
 * The second-level navigation: every block and every deployed resource group, as
 * cards, so choosing one to inspect does not cost you the list of the others.
 *
 * This component only renders. What the nav CONTAINS — the sections, their
 * order, each card's tags and facts, which cards a filter keeps, and why the nav
 * is empty when it is empty — is decided by `src/nav/inventory-tree.ts`, which
 * unit tests can reach. What belongs here is rendering: a tone becoming a badge
 * variant, an absent description leaving no gap, a card with no href rendering as
 * static text rather than a dead link, and the scroll position.
 */

function CardBody({ card }: { card: NavCard }) {
	return (
		<>
			<div className="flex flex-wrap items-center gap-1.5">
				<span className="font-mono text-[13px] font-medium leading-tight">{card.title}</span>
				{card.tags.map((tag) => (
					<Badge key={`${tag.tone}:${tag.label}`} variant={TONE_VARIANT[tag.tone]} title={tag.title}>
						{tag.label}
					</Badge>
				))}
			</div>
			{/* Each line below is omitted entirely when absent rather than rendered
			    empty: a description-less block should read as deliberate, and a
			    blank line is what makes it read as broken. */}
			{card.subtitle && <p className="truncate font-mono text-[11px] text-fg-dim">{card.subtitle}</p>}
			{card.description && (
				// Clamped for layout, never truncated in the data — the full sentence
				// stays available on hover.
				<p className="line-clamp-2 text-xs leading-snug text-fg-soft" title={card.description}>
					{card.description}
				</p>
			)}
			{card.facts.length > 0 && (
				// Wraps rather than truncates. These are the facts that carry a card
				// with no description, and at this width `partition userId · sort todoId
				// · 2 resources` clips exactly the resource count off the end.
				<p className="font-mono text-[11px] leading-snug text-fg-dim">{card.facts.join(' · ')}</p>
			)}
		</>
	);
}

function NavCardItem({
	card,
	active,
	activeRef,
}: {
	card: NavCard;
	active: boolean;
	activeRef: React.RefObject<HTMLLIElement | null>;
}) {
	// A resting background, not just a hover one. Without it a card is text on the
	// page background and reads as a list entry rather than as something to press;
	// the surface is what says "this is a target".
	const shared = 'block space-y-1 rounded-md border px-2.5 py-2 text-left transition-colors';

	// No href means there is nothing to open. Rendering it as a link anyway would
	// be a control that looks clickable and does nothing — so it deliberately does
	// NOT get the interactive surface below.
	if (!card.href) {
		return (
			<li>
				<div className={cn(shared, 'border-dashed border-line/60 bg-transparent')}>
					<CardBody card={card} />
				</div>
			</li>
		);
	}

	return (
		<li ref={active ? activeRef : undefined}>
			<Link
				href={card.href}
				aria-current={active ? 'page' : undefined}
				className={cn(
					shared,
					active
						? 'border-brand/40 bg-active text-fg shadow-sm'
						: 'border-line/70 bg-panel text-fg-soft hover:border-line hover:bg-hover hover:text-fg',
				)}
			>
				<CardBody card={card} />
			</Link>
		</li>
	);
}

function NavSectionBlock({
	section,
	open,
	onToggle,
	pathname,
	activeRef,
}: {
	section: NavSection;
	open: boolean;
	onToggle: () => void;
	pathname: string;
	activeRef: React.RefObject<HTMLLIElement | null>;
}) {
	const Chevron = open ? ChevronDown : ChevronRight;
	const headingId = `nav-section-${section.id}`;
	/*
	 * Sticky within the nav's own scroll container, so the heading you are reading
	 * under stays visible while a long section scrolls. It needs an opaque
	 * background of its own or the cards scroll through it, and it sticks at the
	 * filter box's height rather than at 0 — with both at top-0 a pinned heading
	 * sat directly behind the filter.
	 */
	const headingClasses =
		'sticky top-8 z-10 flex w-full items-center gap-1.5 rounded-md bg-canvas px-1 py-1 text-left text-[11px] font-semibold uppercase tracking-wide text-fg-soft';

	return (
		<section>
			{section.collapsible ? (
				<button
					type="button"
					onClick={onToggle}
					aria-expanded={open}
					id={headingId}
					className={cn(headingClasses, 'transition-colors hover:text-fg')}
				>
					<Chevron size={13} strokeWidth={2} className="shrink-0 text-fg-dim" aria-hidden="true" />
					<span className="truncate">{section.label}</span>
					<span className="ml-auto shrink-0 font-normal normal-case tracking-normal text-fg-dim">
						{section.summary}
					</span>
				</button>
			) : (
				/*
				 * A plain heading, not a button. Your own block categories are labels:
				 * there is nothing to put away, so a control whose only effect is to
				 * remove content would also be one more Tab stop between you and the
				 * blocks. No chevron either, since nothing here opens or closes.
				 */
				<h2 id={headingId} className={cn(headingClasses, 'pl-2')}>
					<span className="truncate">{section.label}</span>
					<span className="ml-auto shrink-0 font-normal normal-case tracking-normal text-fg-dim">
						{section.summary}
					</span>
				</h2>
			)}
			{open && (
				<>
					{section.description && (
						<p className="px-1 pb-1.5 pt-0.5 text-[11px] leading-snug text-fg-dim">{section.description}</p>
					)}
					<ul aria-labelledby={headingId} className="space-y-1 pt-1">
						{section.cards.map((card) => (
							<NavCardItem key={card.key} card={card} active={isCardActive(card, pathname)} activeRef={activeRef} />
						))}
					</ul>
				</>
			)}
		</section>
	);
}

/** Copy for each reason the nav has nothing to show. The status itself is derived in the model. */
function NavEmptyState({ status }: { status: NavStatus }) {
	if (status.kind === 'loading') return <p className="px-1 text-xs text-fg-dim">Loading blocks…</p>;

	if (status.kind === 'unreachable') {
		return (
			<p className="px-1 text-xs text-warn-fg">
				Could not reach the dashboard API. Start it with <code className="font-mono">npm run dashboard</code> and open
				the URL it prints, so the session token is carried in.
			</p>
		);
	}

	if (status.kind === 'unavailable') {
		return (
			<div className="space-y-1 px-1">
				<p className="text-xs text-warn-fg">
					{status.code === 'NOT_A_BLOCKS_PROJECT'
						? 'Not a Blocks project'
						: status.code === 'PARSE_FAILED'
							? 'Could not parse the block declarations'
							: 'Blocks unavailable'}
				</p>
				{status.message && <p className="text-[11px] leading-snug text-fg-dim">{status.message}</p>}
			</div>
		);
	}

	return (
		<p className="px-1 text-[11px] leading-snug text-fg-dim">
			Nothing is declared in <code className="font-mono">aws-blocks/</code> yet. A block declared in a file outside
			that directory is not scanned.
		</p>
	);
}

export function InventoryNav() {
	const { cloudStage, ready } = useEnvironment();
	const isLocal = cloudStage === undefined;
	const pathname = usePathname();
	const filterId = useId();
	const [query, setQuery] = useState('');
	// Overrides only. An id absent from here takes the section's own default, so a
	// section that appears later (a stage switch adds framework groups) still
	// opens or stays closed as the model intended, and every explicit toggle wins.
	const [overrides, setOverrides] = useState<Record<string, boolean>>({});
	const scrollerRef = useRef<HTMLDivElement | null>(null);
	const activeRef = useRef<HTMLLIElement | null>(null);

	// The SAME query keys the pages use, so React Query serves both from one cache
	// entry and adding this nav costs no extra request.
	const blocks = useQuery({
		queryKey: ['blocks'],
		queryFn: () => apiGet<BlocksResponse>('/api/v1/blocks'),
	});
	const resources = useQuery({
		queryKey: ['resources', cloudStage],
		queryFn: () => {
			// Unreachable in local: `enabled` holds this until a deployed stage is
			// selected. The guard narrows `cloudStage` without a cast.
			if (cloudStage === undefined) throw new Error('resources requested with no stage');
			return apiGet<ResourcesResponse>(`/api/v1/resources?stage=${encodeURIComponent(cloudStage)}`);
		},
		// The resources request is the only cloud-only part of the nav: gated so it
		// never fires in local, where there is no stack to read (D78). The blocks
		// scan above is source-derived and stays ungated so the nav still renders.
		enabled: ready && cloudStage !== undefined,
	});

	// The local environment is its own state, not a pending or failed read: the
	// request was never issued, so the model must not report the resources as
	// unreadable and must not hand every block a deployment verdict it never
	// obtained. Deciding that here and letting `buildInventoryTree` carry it keeps
	// the distinction in the tested model rather than in a tag rewrite.
	const resourcesState: ResourcesState = isLocal
		? { state: 'not-applicable' }
		: resources.isPending
			? { state: 'pending' }
			: resources.isError || !resources.data
				? { state: 'error' }
				: { state: 'loaded', response: resources.data };

	const status = navStatus({ blocks: blocks.data, pending: blocks.isPending, failed: blocks.isError });
	const tree = buildInventoryTree({ blocks: blocks.data, resources: resourcesState });
	const filtered = filterTree(tree.sections, query, pathname);

	/*
	 * Scroll the open card into view inside the NAV's scroller, never the page.
	 * `scrollIntoView` would be shorter but is free to scroll any scrollable
	 * ancestor including the window, which yanks the page you just navigated to.
	 * With four block sections above it a framework card sat ~1700px down a 720px
	 * viewport, so arriving from the nav left the nav showing nothing relevant.
	 *
	 * Measured with rects rather than `offsetTop`. `offsetTop` is relative to the
	 * nearest POSITIONED ancestor, and the layout wraps this nav in a `sticky`
	 * div — so the card's offsetParent is that wrapper, not the scroller, and
	 * subtracting the scroller's own offsetTop left the card 136px above the
	 * visible area while the arithmetic claimed it was in view.
	 */
	useEffect(() => {
		const card = activeRef.current;
		const scroller = scrollerRef.current;
		if (!card || !scroller) return;
		const cardRect = card.getBoundingClientRect();
		const scrollerRect = scroller.getBoundingClientRect();
		const margin = 12;
		if (cardRect.top < scrollerRect.top) {
			scroller.scrollTop -= scrollerRect.top - cardRect.top + margin;
		} else if (cardRect.bottom > scrollerRect.bottom) {
			scroller.scrollTop += cardRect.bottom - scrollerRect.bottom + margin;
		}
	}, [pathname, query, filtered.sections.length]);

	return (
		<div ref={scrollerRef} className="max-h-[calc(100vh-8rem)] overflow-y-auto pb-2">
			<nav aria-label="Blocks and resources" className="space-y-3">
				{status.kind === 'ready' ? (
					<>
						{/*
						 * Sticky, so the way out of a filtered list is never scrolled away.
						 * Its rendered height (32px: a 26px input plus pb-1.5) is the offset
						 * the section headings stick at — with both at top-0 a pinned heading
						 * sat directly behind this box.
						 */}
						<div className="sticky top-0 z-20 bg-canvas pb-1.5">
							<label htmlFor={filterId} className="sr-only">
								Filter blocks and resources
							</label>
							<div className="relative">
								<Search
									size={13}
									strokeWidth={2}
									aria-hidden="true"
									className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-fg-dim"
								/>
								<input
									id={filterId}
									type="search"
									value={query}
									onChange={(event) => setQuery(event.target.value)}
									placeholder="Filter…"
									className="w-full rounded-md border border-line bg-canvas py-1 pl-7 pr-2 text-xs text-fg placeholder:text-fg-dim focus:border-brand/50 focus:outline-none"
								/>
							</div>
						</div>

						{filtered.sections.map((section) => {
							// A non-collapsible section is always open: its heading is a label,
							// so there is no state for an override to hold.
							//
							// For the foldable ones: a section holding the open page is expanded
							// even when it defaults to closed, or following a framework card from
							// this nav lands you on a page the nav has just hidden. An explicit
							// toggle still wins, so you can collapse it again while staying
							// there. While filtering, every surviving section opens — a match
							// hidden inside a collapsed section is a match the filter failed to
							// show.
							const openByDefault =
								query.trim().length > 0 || !section.defaultCollapsed || isSectionActive(section, pathname);
							const open = section.collapsible ? (overrides[section.id] ?? openByDefault) : true;
							return (
								<NavSectionBlock
									key={section.id}
									section={section}
									open={open}
									onToggle={() => setOverrides((current) => ({ ...current, [section.id]: !open }))}
									pathname={pathname}
									activeRef={activeRef}
								/>
							);
						})}

						{query.trim().length > 0 && (
							<p className="px-1 text-[11px] leading-snug text-fg-dim" role="status">
								{filtered.matched === 0
									? `Nothing matches “${query.trim()}”.`
									: `${filtered.hidden} hidden by the filter.`}
								{filtered.keptActive && ' The block you have open is shown regardless.'}
							</p>
						)}

						{tree.unknownCount > 0 && (
							// Not cards: there is no page to open for an unresolved construct,
							// so this is a count that leads to the page which explains them.
							<Link
								href="/blocks"
								className="block px-1 text-[11px] text-fg-dim underline-offset-2 transition-colors hover:text-fg-soft hover:underline"
							>
								{tree.unknownCount} unrecognised construct{tree.unknownCount === 1 ? '' : 's'}
							</Link>
						)}

						{/*
						 * Two different sentences for two different facts, and the model
						 * guarantees at most one is true: nothing was read because nothing
						 * was asked, or a read was attempted and did not answer. Keyed on
						 * the tree rather than on `isLocal` so the copy cannot disagree with
						 * the state the cards were built from.
						 */}
						{tree.resourcesNotApplicable && (
							<p className="px-1 text-[11px] leading-snug text-fg-dim">{NAV_RESOURCES_NOT_APPLICABLE}</p>
						)}
						{tree.resourcesUnavailable && (
							// Said plainly rather than left as an absence: without this, a
							// missing framework section and missing resource counts look like
							// a stack with nothing in it.
							<p className="px-1 text-[11px] leading-snug text-fg-dim">
								Deployed resources for <span className="text-fg-soft">{cloudStage}</span> could not be read, so
								resource counts and the framework sections are missing rather than empty.
							</p>
						)}
					</>
				) : (
					<NavEmptyState status={status} />
				)}
			</nav>
		</div>
	);
}
