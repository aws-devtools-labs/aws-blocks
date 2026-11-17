// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

'use client';

import Link from 'next/link';
import { useState } from 'react';
import { useEnvironment } from '@/components/environment-context';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { type EmptyScreen, type GuidedAction, guidedEmpty } from '@/env/empty-state';
import { localNotApplicableReason } from '@/env/environment';
import { deployCommandFor } from '@/lib/commands';

/**
 * The one empty screen in this dashboard.
 *
 * Deliberately thin: every rule about what to say and what to offer lives in
 * `@/env/empty-state` where unit tests reach it, and this file is the markup and
 * the clipboard. The package has no component tests (D81), so copy decided here
 * would be copy nothing can check — which is how nine screens came to say
 * "select a deployed stage" next to no way of selecting one.
 *
 * Nine call sites collapse to one line each, so the pillar pages cannot drift
 * apart again: `<GuidedEmpty screen={{ kind: 'local-pillar', pillar: 'logs' }} />`.
 */
export function GuidedEmpty({
	screen,
	variant = 'card',
	alert = false,
}: {
	screen: EmptyScreen;
	/**
	 * `inline` drops the Card chrome for a screen whose guidance belongs INSIDE
	 * an existing card beside other content.
	 *
	 * The two developer pages (Playground, block detail) show their blocked
	 * state as a compact strip next to a sibling note that stays relevant, so a
	 * full card there would be a card inside a card. Both variants render the
	 * same model through the same controls, which is the point of having one
	 * component rather than a second one that reimplements the action row.
	 */
	variant?: 'card' | 'inline';
	/**
	 * Announce immediately. Only for a screen reached by a FAILED request (the
	 * 401), preserving the `role="alert"` that card already carried: an empty
	 * state you navigated to deliberately is not an alert, and marking it one
	 * would interrupt a reader for something they went looking for.
	 */
	alert?: boolean;
}) {
	const { statuses, environment, setEnvironment } = useEnvironment();

	// Both collaborators are passed in because the model is bundled into the
	// client and cannot value-import them. See the module comment there.
	const guided = guidedEmpty(screen, statuses, environment, deployCommandFor, localNotApplicableReason);

	const actions = guided.actions.length > 0 && (
		<div className="flex flex-wrap items-center gap-2">
			{guided.actions.map((action, index) => (
				<Action
					key={actionKey(action)}
					action={action}
					// The model orders by usefulness, so the first one leads. One
					// filled control per card: two would be a choice rather than a
					// recommendation, which is what the passive copy already was.
					primary={index === 0}
					onSwitch={setEnvironment}
				/>
			))}
		</div>
	);
	const noAction = guided.noActionReason && <p className="text-[13px] text-fg-soft">{guided.noActionReason}</p>;
	const detail = guided.detail && <p className="text-[13px] text-fg-dim">{guided.detail}</p>;

	if (variant === 'inline') {
		return (
			<div
				className="space-y-2 rounded-md border border-warn/25 bg-warn/5 px-3 py-2"
				{...(alert ? { role: 'alert' } : {})}
			>
				<div className="flex flex-wrap items-baseline gap-2">
					<Badge variant="warning">unavailable</Badge>
					<span className="text-[13px] font-medium text-fg">{guided.headline}</span>
				</div>
				<p className="text-[13px] text-fg">{guided.nextStep}</p>
				{actions}
				{noAction}
				{detail}
			</div>
		);
	}

	return (
		<Card {...(alert ? { role: 'alert' } : {})}>
			<CardHeader>
				<CardTitle className="text-base">{guided.headline}</CardTitle>
				{/*
				 * The next step is the reason this component exists, so it is body
				 * text rather than `CardDescription`'s small print. The mechanism
				 * sentence that used to occupy this slot now sits below the actions.
				 */}
				<CardDescription className="text-sm text-fg">{guided.nextStep}</CardDescription>
			</CardHeader>
			<CardContent className="space-y-3">
				{actions}
				{noAction}
				{detail}
			</CardContent>
		</Card>
	);
}

/** Stable per action, so React keeps the copy button's state with its own command. */
function actionKey(action: GuidedAction): string {
	switch (action.type) {
		case 'switch':
			return `switch:${action.environment}`;
		case 'command':
			return `command:${action.command}`;
		case 'link':
			return `link:${action.href}`;
	}
}

function Action({
	action,
	primary,
	onSwitch,
}: {
	action: GuidedAction;
	primary: boolean;
	onSwitch: (id: string) => void;
}) {
	if (action.type === 'switch') {
		return (
			<button
				type="button"
				onClick={() => onSwitch(action.environment)}
				// The reason travels with the control, as the header's row already
				// does: an environment offered without saying what is unresolved
				// about it reads as a promise this card cannot make.
				title={action.hint}
				className={buttonClass(primary)}
			>
				{action.label}
			</button>
		);
	}
	if (action.type === 'link') {
		return (
			<Link href={action.href} className={buttonClass(primary)}>
				{action.label} →
			</Link>
		);
	}
	return <CopyableCommand command={action.command} label={action.label} primary={primary} />;
}

/**
 * Theme tokens only, both tones set together.
 *
 * A background without its matching foreground is the half-set pair that renders
 * unreadable when the theme flips, so `bg-brand` always carries `text-on-brand`.
 */
function buttonClass(primary: boolean): string {
	const base =
		'rounded-md px-3 py-1.5 text-[13px] font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-brand/40';
	return primary
		? `${base} bg-brand text-on-brand hover:bg-brand-dark`
		: `${base} border border-line bg-panel text-fg hover:bg-hover`;
}

/**
 * A command, shown in full beside a button that copies it.
 *
 * The text is ALWAYS present and selectable rather than hidden behind the
 * button, because `navigator.clipboard` is not reachable everywhere: an insecure
 * context has no `clipboard` at all, and a permissions policy can refuse the
 * write. A card whose only copy of the command is inside a button that failed
 * leaves the reader with nothing, which is the dead end this whole change
 * removes.
 *
 * So a failure says so. Reporting "Copied" on a rejected write would be the one
 * lie that costs the reader real time: they paste the wrong thing, or nothing,
 * and have no reason to doubt the card.
 */
function CopyableCommand({ command, label, primary }: { command: string; label: string; primary: boolean }) {
	const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');

	async function copy() {
		try {
			// Throws rather than returning false when `clipboard` is absent, so the
			// missing-API and refused-write cases land in the same branch.
			await navigator.clipboard.writeText(command);
			setState('copied');
		} catch {
			setState('failed');
		}
	}

	return (
		<span className="inline-flex flex-wrap items-center gap-2">
			<span className="text-[13px] text-fg-soft">{label}:</span>
			<code className="rounded-md border border-line bg-canvas px-2 py-1 font-mono text-[13px] text-fg">
				{command}
			</code>
			<button type="button" onClick={copy} className={buttonClass(primary)}>
				{state === 'copied' ? 'Copied' : state === 'failed' ? 'Copy failed' : 'Copy'}
			</button>
			{/*
			 * Announced rather than only coloured, so the outcome reaches a reader
			 * who cannot see the label change. `failed` names the recovery, since
			 * the command above is still selectable by hand.
			 */}
			<span aria-live="polite" className="sr-only">
				{state === 'copied' ? `Copied ${command}` : state === 'failed' ? 'Copy failed, select the command by hand' : ''}
			</span>
		</span>
	);
}
