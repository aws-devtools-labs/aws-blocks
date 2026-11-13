// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * What an empty screen tells the reader to DO.
 *
 * Every empty screen in this dashboard was already honest and entirely passive:
 * a title, one sentence naming the mechanism, and no way to act on it. "Select a
 * deployed stage" is accurate advice printed next to nothing that selects one,
 * and "A local run publishes no CloudWatch metrics" explains a situation to
 * somebody who wanted a way out of it.
 *
 * So this module reorders the same information rather than replacing it. The
 * action comes first in plain words, and the mechanism sentence survives as
 * `detail` in small print, because the reason is genuinely useful once you know
 * what to do: a reader who learns logs go to the dev server's own stdout knows
 * which terminal to look in.
 *
 * No React, no `window`, and no copy written inside a component — the same
 * reasoning as `environment.ts` (D81): this package has no component tests at
 * all, so copy and action rules buried in JSX are untestable where they sit.
 *
 * Both collaborators are INJECTED rather than imported, and not for symmetry.
 * This module is bundled into the client, where Turbopack cannot resolve the
 * relative `../x.js` specifiers that the ESM server build requires of a value
 * import. Across every tsc-tested directory in this package there is not one
 * value import of that shape; all of them are type-only and erase. So a module
 * that must be both client-bundled and unit-tested can type-import and nothing
 * else, which is exactly why `environment.ts` already takes
 * {@link DeployCommandFor} as a parameter.
 */

import type { CloudOnlyPillar, DeployCommandFor, EnvironmentId, EnvironmentStatus } from './environment.js';

/**
 * Why a cloud-only pillar is empty here, supplied by the caller.
 *
 * `localNotApplicableReason` from `environment.ts`, injected for the bundler
 * reason in the module comment above. Passing the function rather than the
 * finished sentence is deliberate: the seven pillar screens would otherwise each
 * wire their own detail, which is the duplication that lets one of them drift.
 */
export type NotApplicableReasonFor = (pillar: CloudOnlyPillar) => string;

/**
 * One thing the reader can do, as data rather than a handler.
 *
 * This module has no React, so a `switch` action names the environment and the
 * component maps it onto `setEnvironment`. Keeping it as data is the point: a
 * test can then assert WHICH environments a screen offers, which is precisely
 * what was wrong before — the copy said "select a deployed stage" while the card
 * offered no way to select one, and nothing could catch that.
 */
export type GuidedAction =
	| {
			type: 'switch';
			environment: EnvironmentId;
			label: string;
			/**
			 * What is unresolved about this target, when something is.
			 *
			 * Carries `EnvironmentStatus.detail` so the control explains itself the
			 * way the header's row already does. Present for an environment whose
			 * state could not be read, absent for one known to be deployed.
			 */
			hint?: string;
	  }
	| { type: 'command'; command: string; label: string }
	/**
	 * Somewhere else in the dashboard that answers the same question without
	 * deploying anything.
	 *
	 * An in-app route rather than a URL: these go to a page this dashboard
	 * serves, and typing it as a link keeps the component from needing to know
	 * which pillar has one.
	 */
	| { type: 'link'; href: string; label: string };

/**
 * An empty screen, guided.
 *
 * The field order is the fix. `headline` and `nextStep` are what a reader needs
 * and are written in plain words; `detail` is the sentence that used to be the
 * whole card.
 */
export interface GuidedEmpty {
	/** Plain words for the situation. No error code, no AWS noun, no jargon. */
	headline: string;
	/** One imperative sentence: what to do right now. */
	nextStep: string;
	/** Ordered, most directly useful first. */
	actions: GuidedAction[];
	/**
	 * Why there is no action, when there is none.
	 *
	 * Present if and only if `actions` is empty, which is the invariant
	 * {@link isGuided} pins. Some states genuinely have no button: a screen
	 * waiting for traffic has nothing to run, and an IAM grant cannot be made
	 * from a dashboard. Saying so is honest; rendering a dead card and hoping the
	 * reader infers it is the defect this module exists to remove, so the absence
	 * has to be stated rather than merely happen.
	 */
	noActionReason?: string;
	/** The mechanism, demoted to small print. */
	detail?: string;
}

/** What a "nothing recorded yet" screen is waiting for. */
export type RecordedSubject = 'deployments' | 'traffic';

/**
 * The states that produce an empty screen, enumerated.
 *
 * A closed union rather than a bag of booleans, so a new empty screen cannot be
 * added without deciding what it tells the reader to do. The nine screens map
 * onto five members: seven cloud-only pillar screens are one `local-pillar`
 * each, the two blocked developer pages are `not-deployed`, and the rest are one
 * apiece.
 *
 * A generic failed request is deliberately NOT here. `RequestError` already
 * reports a non-401 failure as what it was and refuses to call it empty, and
 * there is no action to offer for an unknown failure beyond retrying — inventing
 * guidance for it would mean guessing at a cause, which is the one thing that
 * component was written not to do.
 */
export type EmptyScreen =
	| { kind: 'local-pillar'; pillar: CloudOnlyPillar }
	| { kind: 'not-deployed'; stage: string; detail?: string }
	| { kind: 'unauthorized'; detail?: string }
	| { kind: 'nothing-recorded'; subject: RecordedSubject; stage: string; detail?: string }
	| { kind: 'access-denied'; permission: string; detail?: string };

/**
 * The environments worth offering as a switch, best first.
 *
 * `selectable` is reused exactly as the header's row uses it rather than given a
 * stricter reading here. A second notion of "offerable" is how the guided card
 * and the switcher would come to disagree about the same environment, and
 * `environmentStatuses` exists to make that impossible. It already encodes the
 * decision (D79): only `not-deployed` is refused, and an environment whose state
 * could not be READ stays selectable, because greying it out would claim we
 * looked and found nothing.
 *
 * Known-deployed targets sort ahead of unresolved ones. Both are offered, but a
 * reader clicking the first option should land somewhere that works, and `hint`
 * carries the uncertainty for the rest.
 */
export function switchTargets(statuses: readonly EnvironmentStatus[], current: EnvironmentId): EnvironmentStatus[] {
	const offerable = statuses.filter((status) => status.selectable && status.id !== current);
	const certain = offerable.filter((status) => status.state === 'deployed' || status.state === 'local');
	const unresolved = offerable.filter((status) => !certain.includes(status));
	return [...certain, ...unresolved];
}

function switchAction(status: EnvironmentStatus): GuidedAction {
	return {
		type: 'switch',
		environment: status.id,
		label: `Switch to ${status.id}`,
		// Only when something is actually unresolved. A deployed stage's detail is
		// absent anyway, and local's is a description rather than a caveat, so
		// passing either through would turn a hint meant for doubt into noise.
		hint: status.state === 'deployed' || status.state === 'local' ? undefined : status.detail,
	};
}

/**
 * The stage a reader would have to deploy, if there is one.
 *
 * Only `not-deployed` counts. `unread` and `unknown` mean we have not got an
 * answer, and telling somebody to deploy a stage that may already be running is
 * worse than offering no command: they would run it on the strength of our
 * guess. The consequence is that no deploy button appears in the moment before
 * the environments response lands, which is correct — we do not yet know whether
 * one is needed.
 */
function stageAwaitingDeploy(statuses: readonly EnvironmentStatus[]): string | undefined {
	return statuses.find((status) => status.state === 'not-deployed')?.id;
}

/**
 * Plain-language headlines, one per pillar.
 *
 * Deliberately not one shared sentence. "This view is not available" is the
 * passive phrasing being removed, and the useful half of a headline is naming
 * which thing lives in a deployed app, because that is often all a reader needs
 * to understand they are in the wrong environment.
 */
function pillarHeadline(pillar: CloudOnlyPillar): string {
	switch (pillar) {
		case 'logs':
			return 'Logs come from a deployed app';
		case 'deployments':
			return 'A local run is not a deployment';
		case 'resources':
			return 'Resources belong to a deployed app';
		case 'cost':
			return 'Running locally is free';
		case 'usage':
			return 'Usage is measured in a deployed app';
	}
}

/**
 * Where else this question can be answered without deploying anything.
 *
 * Only `resources` has one, and its reason sentence already promises it ("or
 * open Blocks to see what your app declares"). That promise was kept on exactly
 * one of the two resources screens: the group page hand-rolled the link in its
 * own markup, while the resources index printed the same sentence with no way to
 * follow it. Here it belongs to the pillar, so both screens offer it and a test
 * can pin that a sentence naming a route is accompanied by the route.
 */
function alternativeFor(pillar: CloudOnlyPillar): GuidedAction | undefined {
	return pillar === 'resources' ? { type: 'link', href: '/blocks', label: 'See what your app declares' } : undefined;
}

function localPillar(
	pillar: CloudOnlyPillar,
	statuses: readonly EnvironmentStatus[],
	current: EnvironmentId,
	deployCommand: DeployCommandFor,
	reasonFor: NotApplicableReasonFor,
): GuidedEmpty {
	const targets = switchTargets(statuses, current);
	const actions: GuidedAction[] = targets.map(switchAction);

	// The two actions answer different intentions: look at something already
	// running, or get your own running. Offered together, switching first,
	// because it costs nothing and takes effect immediately.
	const toDeploy = stageAwaitingDeploy(statuses);
	if (toDeploy !== undefined) {
		actions.push({ type: 'command', command: deployCommand(toDeploy), label: `Deploy ${toDeploy}` });
	}

	// Last: it answers a neighbouring question rather than this one, so it must
	// not outrank the environment that would answer this one properly.
	const alternative = alternativeFor(pillar);
	if (alternative) actions.push(alternative);

	return {
		headline: pillarHeadline(pillar),
		nextStep: nextStepFor(targets.length > 0, toDeploy !== undefined),
		actions,
		noActionReason:
			actions.length === 0
				? 'Every environment is already selected or unavailable, so there is nothing to switch to and nothing to deploy.'
				: undefined,
		detail: reasonFor(pillar),
	};
}

/**
 * The one sentence, chosen by what is actually on offer.
 *
 * Uniform across the seven pillars on purpose: it is the same situation and the
 * same instruction, and varying the wording per page would read as seven
 * different problems. What it varies on is whether the buttons below it exist,
 * because a sentence naming an action the card does not offer is the original
 * defect in a new place.
 */
function nextStepFor(canSwitch: boolean, canDeploy: boolean): string {
	if (canSwitch && canDeploy) return 'Switch to an environment that is already running, or deploy one now.';
	if (canSwitch) return 'Switch to an environment that is already running.';
	if (canDeploy) return 'Deploy an environment to see this.';
	return 'Deploy an environment, or pick another one in the header.';
}

function notDeployed(
	stage: string,
	detail: string | undefined,
	statuses: readonly EnvironmentStatus[],
	current: EnvironmentId,
	deployCommand: DeployCommandFor,
): GuidedEmpty {
	const targets = switchTargets(statuses, current);
	return {
		headline: `Nothing is deployed to ${stage} yet`,
		nextStep:
			targets.length > 0
				? 'Run the command below to deploy it, or switch to another environment.'
				: 'Run the command below to deploy it.',
		// The command leads here, unlike the local pillars: the reader has already
		// chosen this environment, so deploying it is the direct answer and
		// switching away is the alternative.
		actions: [
			{ type: 'command', command: deployCommand(stage), label: `Deploy ${stage}` },
			...targets.map(switchAction),
		],
		detail,
	};
}

function nothingRecorded(
	subject: RecordedSubject,
	stage: string,
	detail: string | undefined,
	deployCommand: DeployCommandFor,
): GuidedEmpty {
	if (subject === 'deployments') {
		return {
			headline: `Nothing has been deployed to ${stage} yet`,
			nextStep: 'Run the command below to make the first deployment.',
			actions: [{ type: 'command', command: deployCommand(stage), label: `Deploy ${stage}` }],
			detail,
		};
	}
	// Traffic is the one empty screen with nothing to run, and it must not share
	// copy with the access-denied case: "no traffic" and "we were not allowed to
	// look" read identically on a flat chart, and only one of them means the app
	// is idle.
	return {
		headline: 'No traffic recorded yet',
		nextStep: 'Use your app, then refresh this page.',
		actions: [],
		noActionReason: 'There is nothing to run: this fills in on its own once your app gets traffic.',
		detail,
	};
}

/**
 * Assemble the guidance for an empty screen.
 *
 * Pure, and total over {@link EmptyScreen}, so adding a screen is a compile
 * error until its guidance is written.
 */
export function guidedEmpty(
	screen: EmptyScreen,
	statuses: readonly EnvironmentStatus[],
	current: EnvironmentId,
	deployCommand: DeployCommandFor,
	reasonFor: NotApplicableReasonFor,
): GuidedEmpty {
	switch (screen.kind) {
		case 'local-pillar':
			return localPillar(screen.pillar, statuses, current, deployCommand, reasonFor);
		case 'not-deployed':
			return notDeployed(screen.stage, screen.detail, statuses, current, deployCommand);
		case 'nothing-recorded':
			return nothingRecorded(screen.subject, screen.stage, screen.detail, deployCommand);
		case 'unauthorized':
			return {
				headline: 'The dashboard needs a new token',
				nextStep: 'Restart the dashboard from your project folder, then open the URL it prints.',
				actions: [],
				// No command button, and this is the reason the escape hatch above
				// exists rather than a shortcut. `npm run dashboard` is defined by
				// ONE of the eight project templates, so offering it to copy would
				// hand most readers a `command not found` on top of the problem they
				// arrived with. That is the exact mistake `commands.ts` was written
				// to stop, and it is why `START_DASHBOARD_HINT` is phrased as an
				// example rather than a fact.
				noActionReason:
					'The command differs from project to project, so there is nothing safe to copy here. It is whichever script starts your dashboard.',
				detail: screen.detail,
			};
		case 'access-denied':
			return {
				headline: 'Your credentials cannot read this',
				nextStep: `Add ${screen.permission} to the role you are using, then refresh.`,
				actions: [],
				// "An IAM change" would be too narrow and therefore false on one of
				// the two callers: Cost Explorer also has to be enabled once per
				// account in the Billing console, which is not a permission at all.
				noActionReason: 'This needs a change in your AWS account, which cannot be made from the dashboard.',
				detail: screen.detail,
			};
	}
}

/**
 * Whether a screen actually guides: it offers an action, or says why it cannot.
 *
 * The invariant the whole module is for, as a predicate so a test can assert it
 * over every state rather than trusting five constructors to remember. It also
 * pins the exclusivity: listing actions AND a reason there are none is a
 * contradiction on screen, where the reader sees buttons under a sentence
 * claiming there are none.
 */
export function isGuided(guided: GuidedEmpty): boolean {
	const hasActions = guided.actions.length > 0;
	return hasActions !== (guided.noActionReason !== undefined);
}
