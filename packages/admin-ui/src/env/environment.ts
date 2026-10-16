// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The environment axis — the rules, with no React, `window` or `document` in
 * sight.
 *
 * The dashboard used to carry TWO selectors: a global `stage` in the header, and
 * a per-page `local | cloud` switch on the two developer pages. They were never
 * independent (D75). In cloud mode the stage picks the stack; in local mode the
 * server ignores the stage outright — the local read path and the local writer
 * context are handed no stage at all, and `rpc-endpoint` resolves a localhost
 * port from the project. So the 2x2 had only three reachable meanings, and this
 * module models exactly those three as one value:
 *
 *     local            → the dev server and `.bb-data` on this machine
 *     sandbox          → the per-developer deployed stack
 *     production       → the shared deployed stack
 *
 * `local` lives here on the client and never becomes a stage on the wire (D74):
 * every stage-to-stack path in the server is closed over the two real stages, so
 * publishing a third pseudo-stage would push an unmappable value through
 * CloudFormation, Logs, Cost and RPC alike. Selecting `local` sends the
 * `mode=local` that already exists.
 *
 * Everything lives in a plain module because the package has no component tests
 * at all (D81): the rules this replaces — a duplicated `cloudBlockedReason`, a
 * mode `useState` and the effect that forced it back — were untestable where
 * they sat.
 */

import type { DataMode, EnvironmentInfo } from '../contract/v1.js';

/**
 * The one environment that is not a deployed stage.
 *
 * A plain id rather than a wrapper type so it can be a storage value, a React
 * Query key and a URL parameter without conversion at every boundary.
 */
export const LOCAL_ENVIRONMENT = 'local';

/**
 * An environment id: {@link LOCAL_ENVIRONMENT}, or the name of a deployed stage.
 *
 * Deliberately not a closed union. The deployed stages arrive at runtime from
 * `MetaResponse.stages`, and a union would force a cast at exactly the point the
 * value stops being known — which is how a "stage" that no longer exists ends up
 * silently selected.
 */
export type EnvironmentId = string;

/**
 * `sandbox`, preserving the stage selector's own default.
 *
 * The per-page data switches defaulted to `local` while the header defaulted to
 * `sandbox`; under one axis they must agree, and the ops pillars (Overview,
 * Deployments, Logs, Cost, Resources) are the dashboard's reason for existing —
 * defaulting to `local` would open five of seven pages on "not applicable here".
 * The consequence is deliberate and bounded: a block page now reads the deployed
 * table rather than `.bb-data` on first load, which is a read; nothing is
 * invoked or written without an explicit action, cloud writes stay behind the
 * unlock gate, and an RPC call still names its target before it runs.
 */
export const DEFAULT_ENVIRONMENT: EnvironmentId = 'sandbox';

/**
 * `sessionStorage`, per tab — unlike the theme and the sidebar, which are
 * durable preferences about the tool in `localStorage`. Which environment you are
 * inspecting is working context, and holding `local` in one tab while watching
 * production in another is the point rather than a bug.
 *
 * The key keeps its old name on purpose: every value it can already hold
 * (`sandbox`, `production`) is a valid environment id, so an open tab keeps its
 * selection across the upgrade instead of being silently reset.
 */
export const ENVIRONMENT_STORAGE_KEY = 'blocks-dashboard-stage';

export function isLocalEnvironment(id: EnvironmentId): boolean {
	return id === LOCAL_ENVIRONMENT;
}

/**
 * Whether an environment is the loud one.
 *
 * Matches the previous `isProductionStage` (`/prod/i`, so `prod`, `production`
 * and `eu-prod` all count). The local environment is excluded by the pattern
 * rather than by a guard: an explicit `isCloudEnvironment(id) &&` reads as if it
 * were load-bearing, but `local` cannot match `/prod/i`, so the branch would be
 * unreachable and no test could ever kill it.
 */
export function isProductionEnvironment(id: EnvironmentId): boolean {
	return /prod/i.test(id);
}

/**
 * The selectable environments: local first, then the deployed stages.
 *
 * A stage named `local` would collide with the local environment, so it is
 * dropped rather than producing two entries with one id — two pills that look
 * distinct and select the same thing is worse than one missing stage, and
 * `readStages()` cannot produce it today.
 */
export function environmentIdsFor(stages: readonly string[]): EnvironmentId[] {
	const ids: EnvironmentId[] = [LOCAL_ENVIRONMENT];
	for (const stage of stages) {
		if (stage !== LOCAL_ENVIRONMENT && !ids.includes(stage)) ids.push(stage);
	}
	return ids;
}

/**
 * What an environment means to the data, write and RPC endpoints.
 *
 * Discriminated so that `stage` is not merely absent for local but
 * unreachable — the old shape carried a stage through local requests which the
 * server then ignored, and a field that is present and meaningless is a field
 * someone eventually reads.
 */
export type DataTarget = { mode: Extract<DataMode, 'local'> } | { mode: Extract<DataMode, 'cloud'>; stage: string };

export function dataTargetFor(id: EnvironmentId): DataTarget {
	return isLocalEnvironment(id) ? { mode: 'local' } : { mode: 'cloud', stage: id };
}

/**
 * The query string every data/RPC call site needs: `mode` always, `stage` only
 * when there is one.
 *
 * Omitting `stage` rather than sending a placeholder keeps the wire honest — the
 * routes already default a missing stage and ignore it in local mode.
 */
export function environmentSearchParams(id: EnvironmentId, extra: Record<string, string> = {}): URLSearchParams {
	const target = dataTargetFor(id);
	const params = new URLSearchParams({ mode: target.mode });
	if (target.mode === 'cloud') params.set('stage', target.stage);
	for (const [key, value] of Object.entries(extra)) params.set(key, value);
	return params;
}

/**
 * What to put in the `stage` field of a request body when the contract demands
 * one and the environment has not got one.
 *
 * `RecordWriteRequest`, `RecordDeleteRequest` and `RpcInvokeRequest` all type
 * `stage` as required, and the local environment has no stage — so the local path
 * must send something. It sends the EMPTY STRING, which is inert by construction:
 * the routes read `parsed.stage ? parsed.stage : 'sandbox'` and then ignore the
 * result entirely on the local path (the local writer context and the local RPC
 * endpoint are handed no stage at all).
 *
 * Two things this deliberately is not. It is not a plausible stage name — an
 * empty string cannot be mistaken for a target if it ever surfaced in a log or an
 * error. And it is not a reason to make the contract field optional: the routes
 * default a missing stage to `sandbox`, so an optional field would let a CLOUD
 * write be under-specified and silently land on sandbox, which is a worse failure
 * than a placeholder the server provably discards.
 *
 * Prefer {@link environmentSearchParams} wherever the stage travels in a query
 * string: there it can be omitted properly.
 */
export function wireStageFor(target: DataTarget): string {
	return target.mode === 'cloud' ? target.stage : '';
}

/**
 * How an environment stands right now.
 *
 * `unknown` and `unread` are separate members because they are different
 * statements: we looked and could not tell (credentials, an API failure) versus
 * we have not looked yet. Collapsing them would make a page mid-load
 * indistinguishable from a page that failed — the same conflation D50 already
 * fixed for deployed groups.
 */
export type EnvironmentState = 'local' | 'deployed' | 'not-deployed' | 'unknown' | 'unread';

export interface EnvironmentStatus {
	id: EnvironmentId;
	state: EnvironmentState;
	/**
	 * Whether the switcher offers it.
	 *
	 * False for `not-deployed` and nothing else (D79). `unknown` stays
	 * selectable: `listEnvironments` reaches `not-deployed` only with no stack
	 * name to resolve or with CloudFormation itself answering "does not exist",
	 * so every credential and API failure lands in `unknown` — and greying that
	 * out would claim we looked and found nothing when we could not look.
	 */
	selectable: boolean;
	/** Why it is not selectable, or what is unresolved about it. */
	detail?: string;
}

const LOCAL_DETAIL = 'Reads the dev server and the .bb-data store on this machine. Nothing deployed is touched.';

const UNREAD_DETAIL = 'Its deployment state has not been read yet.';

/**
 * How to deploy a stage, supplied by the caller rather than imported.
 *
 * `deployCommandFor` lives in `src/lib/commands.ts`, and a VALUE import of it
 * from here does not build: this module is bundled into the client, where
 * Turbopack cannot resolve the `../lib/commands.js` specifier that the ESM server
 * build requires (the nav modules get away with `.js` only because their imports
 * are type-only and erase). Verified by building with the import in place —
 * `Module not found: Can't resolve '../lib/commands.js'`. Injecting it is also
 * what this module already does for storage access, and it keeps the sentence
 * here where a test can read it instead of in two components.
 */
export type DeployCommandFor = (stage: string) => string;

function notDeployedDetail(stage: string, deployCommand: DeployCommandFor): string {
	return `No deployed stack for "${stage}" yet, so there is nothing to read. Deploy it with ${deployCommand(stage)}, or switch to the local environment.`;
}

function statusForStage(stage: string, deployCommand: DeployCommandFor, info?: EnvironmentInfo): EnvironmentStatus {
	if (!info) return { id: stage, state: 'unread', selectable: true, detail: UNREAD_DETAIL };
	if (info.state === 'deployed') return { id: stage, state: 'deployed', selectable: true };
	if (info.state === 'not-deployed') {
		// The provider's own sentence wins when it has one, because it names the
		// region it looked in and which tier chose that region. The generic
		// sentence below cannot: it asserts nothing is deployed for this stage,
		// which is exactly the claim a lookup in the wrong region used to produce
		// about a CREATE_COMPLETE stack.
		return {
			id: stage,
			state: 'not-deployed',
			selectable: false,
			detail: info.stateReason ?? notDeployedDetail(stage, deployCommand),
		};
	}
	// `unknown` carries the provider's own words when it has them: the message is
	// already written for a reader (`describeStackFailure` deliberately does not
	// pass the SDK's, which leaks an account id and a role ARN).
	return {
		id: stage,
		state: 'unknown',
		selectable: true,
		detail: info.error ?? info.stateReason ?? 'Its deployment state could not be determined.',
	};
}

/**
 * The switcher's model: one status per environment, local first.
 *
 * `environments` is optional because it comes from a request that can be in
 * flight or have failed. Absent, every stage is `unread` and still selectable —
 * disabling stages while their state loads would flicker them out from under a
 * pointer and, worse, briefly assert they are not deployed.
 */
export function environmentStatuses(
	stages: readonly string[],
	deployCommand: DeployCommandFor,
	environments?: readonly EnvironmentInfo[],
): EnvironmentStatus[] {
	return environmentIdsFor(stages).map((id) => {
		if (isLocalEnvironment(id)) {
			// Local needs no stack and no credentials, so it is always offered. A
			// missing dev server or an absent `.bb-data` store is a per-block fact
			// the data pages already state; it is not this environment's existence.
			return { id, state: 'local', selectable: true, detail: LOCAL_DETAIL };
		}
		return statusForStage(
			id,
			deployCommand,
			environments?.find((info) => info.stage === id),
		);
	});
}

export function statusFor(statuses: readonly EnvironmentStatus[], id: EnvironmentId): EnvironmentStatus | undefined {
	return statuses.find((status) => status.id === id);
}

/**
 * The selected environment's card, so a caller that already has the cards never
 * pairs a stage with a stack a second way.
 *
 * `environmentCards` exists to make "which stack belongs to this environment" one
 * tested decision, and the Overview page then defeated it by doing its own
 * `environments.find((e) => e.stage === cloudStage)` for the detail panel below
 * the cards — two pairings on one page, one tested and one not. This is the
 * tested one, and it returns the whole card so the detail panel and the card
 * above it cannot disagree about either the stack or its badge.
 */
export function selectedCard(cards: readonly EnvironmentCard[]): EnvironmentCard | undefined {
	return cards.find((card) => card.selected);
}

/**
 * A badge variant, named as the `Badge` component's prop rather than as a colour.
 *
 * The union is written out instead of imported from the component: this module is
 * the one place with test reach, and importing a `.tsx` into it would drag JSX
 * into the server build for a string literal.
 */
export type BadgeVariant = 'default' | 'success' | 'destructive' | 'warning' | 'outline';

export interface EnvironmentBadge {
	label: string;
	variant: BadgeVariant;
}

/**
 * How a CloudFormation stack status reads as a badge.
 *
 * Moved out of the Overview component so the selector's badge rule can reuse it
 * and a test can reach both. Order matters: `UPDATE_ROLLBACK_FAILED` ends in
 * `FAILED` and also contains `ROLLBACK`, and a failure is the more urgent of the
 * two readings.
 */
export function stackStatusVariant(status?: string): BadgeVariant {
	if (!status) return 'outline';
	if (status.endsWith('FAILED')) return 'destructive';
	if (status.includes('ROLLBACK') || status.endsWith('IN_PROGRESS')) return 'warning';
	return 'success';
}

/**
 * The badge an environment card carries.
 *
 * A deployed stage shows its actual CloudFormation status rather than the word
 * "deployed": `UPDATE_ROLLBACK_COMPLETE` is deployed and is not the same news as
 * `CREATE_COMPLETE`, and the reader is here to find that out.
 *
 * The invariant worth pinning is that `not-deployed` and `unknown` never render
 * the same badge (D79). They are the two states the whole selector exists to keep
 * apart: one says nothing is there, the other says we could not look.
 */
export function environmentBadgeFor(state: EnvironmentState, stackStatus?: string): EnvironmentBadge {
	switch (state) {
		case 'local':
			// Not "available": every environment in the list is available. What is
			// worth saying is that this one needs no deploy to become so.
			return { label: 'no deploy needed', variant: 'default' };
		case 'deployed':
			return stackStatus
				? { label: stackStatus, variant: stackStatusVariant(stackStatus) }
				: { label: 'deployed', variant: 'success' };
		case 'not-deployed':
			return { label: 'not deployed', variant: 'outline' };
		case 'unknown':
			return { label: 'unknown', variant: 'warning' };
		case 'unread':
			return { label: 'checking…', variant: 'outline' };
	}
}

/**
 * How a stack's drift status reads as a badge.
 *
 * In the model beside {@link stackStatusVariant} for the same reason: it is a
 * status-string-to-variant rule, not presentation, and nothing under `app/` is
 * compiled into `dist` where a test can reach it.
 */
export function driftVariant(drift?: string): BadgeVariant {
	if (drift === 'DRIFTED') return 'destructive';
	if (drift === 'IN_SYNC') return 'success';
	return 'outline';
}

/**
 * One environment as the Overview selector needs it: its availability, the stack
 * detail behind it when there is one, whether it is the current selection, and
 * the badge that follows from the two.
 */
export interface EnvironmentCard {
	status: EnvironmentStatus;
	/**
	 * The stack behind it — absent for local, and for a stage whose state has not
	 * been read yet.
	 *
	 * Local has no `EnvironmentInfo` and never will: `listEnvironments` describes
	 * CloudFormation stacks, and the local environment is the absence of one
	 * (D74). Pairing here rather than in the component means the local card cannot
	 * accidentally be handed another environment's stack by a loose `.find`.
	 */
	info?: EnvironmentInfo;
	selected: boolean;
	badge: EnvironmentBadge;
}

/**
 * The Overview selector's model: one card per environment, local first, in the
 * same order and with the same availability as the header's row.
 *
 * Both controls read this shape via {@link environmentStatuses}, so the page
 * cannot drift into offering an environment the header refuses — which is the
 * failure a second selector invites.
 *
 * `selected` is not guaranteed to be true anywhere: a persisted environment that
 * is no longer offered leaves every card unselected, and that is the honest
 * rendering. Marking an arbitrary card instead would tell the reader they are
 * looking at an environment they are not.
 */
export function environmentCards(
	statuses: readonly EnvironmentStatus[],
	selected: EnvironmentId,
	environments?: readonly EnvironmentInfo[],
): EnvironmentCard[] {
	return statuses.map((status) => {
		const info = isLocalEnvironment(status.id)
			? undefined
			: environments?.find((candidate) => candidate.stage === status.id);
		return {
			status,
			info,
			selected: status.id === selected,
			badge: environmentBadgeFor(status.state, info?.stackStatus),
		};
	});
}

/**
 * Why the selected environment cannot serve a request, if it cannot.
 *
 * The D79 invariant in one place: blocked if and only if not selectable. An
 * environment whose state is `unknown` is NOT blocked — the page issues its
 * request and reports what actually comes back, which is more informative than a
 * guess made before asking.
 */
export function blockedReasonFor(status: EnvironmentStatus | undefined): string | undefined {
	if (!status || status.selectable) return undefined;
	return status.detail;
}

/**
 * Whether a resources response can be summarised, and what to say if not.
 *
 * `resourcesSource === 'cloudformation'` is the only source whose groups describe
 * a real stack, so the summary needs it — but the Overview page used to express
 * that as `source === 'cloudformation' ? groups : undefined` and then render
 * nothing, so a resources read that FAILED looked exactly like a stack with no
 * blocks. That is the silence defect D93 fixed one page over. Absent groups and a
 * failed read are different statements and this returns both.
 */
export function resourceSummaryState(
	source: string | undefined,
	error: string | undefined,
): { state: 'unread' } | { state: 'ok' } | { state: 'failed'; detail: string } {
	if (source === 'cloudformation') return { state: 'ok' };
	if (source === undefined) return { state: 'unread' };
	return {
		state: 'failed',
		detail: error ?? 'The deployed resources could not be read, so there is no block summary for this stack.',
	};
}

/** Pillars that exist only in a deployed stage (D76, D77, D78). */
export const CLOUD_ONLY_PILLARS = ['logs', 'deployments', 'resources', 'cost', 'usage'] as const;

export type CloudOnlyPillar = (typeof CLOUD_ONLY_PILLARS)[number];

/**
 * Why a cloud-only pillar has nothing to show in the local environment.
 *
 * Each sentence names the actual mechanism rather than saying "unavailable",
 * because the reason is the useful part: a reader who knows logs go to the dev
 * server's own stdout knows where to look instead. These are the findings
 * recorded as D76-D78, and the pages that show them never issue the request at
 * all — a Logs Insights query and a Cost Explorer query are both billed.
 */
export function localNotApplicableReason(pillar: CloudOnlyPillar): string {
	switch (pillar) {
		case 'logs':
			return 'A local run writes its logs to the dev server\u2019s own stdout, which no CloudWatch group receives and this dashboard cannot read. Look in the terminal running the dev server, or select a deployed stage.';
		case 'deployments':
			return 'A local run is not a deployment: deploy history is written only by npm run sandbox and npm run deploy. Select a deployed stage to see its history.';
		case 'resources':
			return 'Resources are read from a deployed CloudFormation stack, and a local run creates none. Select a deployed stage, or open Blocks to see what your app declares.';
		case 'cost':
			return 'Running locally is not billed, so there is no cost to attribute. Select a deployed stage to see its spend.';
		case 'usage':
			return 'A local run publishes no CloudWatch metrics: there is no API Gateway, no Lambda and no DynamoDB table behind it to measure. Select a deployed stage to see its traffic.';
	}
}

/**
 * Why the deployment on screen may not belong to the selected environment.
 *
 * A deployment detail is addressed by its own record id, not by a stage: the
 * server finds the record across the whole history and the response carries the
 * stage it went to. So a link, a bookmark or a reload can put a `production`
 * deployment on screen while `sandbox` is selected, and the reader has no way to
 * tell the difference from a heading they did not write.
 *
 * `cloudStage` is REQUIRED rather than `string | undefined` on purpose. In the
 * local environment there is no deployment to show at all (D77), so the caller
 * must have rendered the not-applicable card and returned before it gets here —
 * making that impossible to express is stronger than a comment asking for it,
 * and it is the same reasoning as D88's refusal to loosen the wire's stage field.
 */
export function deploymentStageNote(cloudStage: string, recordStage: string): string | undefined {
	if (cloudStage === recordStage) return undefined;
	return `This deployment went to ${recordStage}, but the selected environment is ${cloudStage}. The link names one specific record, so this page shows that deployment rather than anything from ${cloudStage}.`;
}

/**
 * Storage is user-writable and outlives any stage rename, so an unrecognised
 * value falls back rather than leaving nothing selected.
 *
 * The fallback is total on purpose: the default when it is offered, otherwise the
 * first environment there is, otherwise local — which always exists. Returning
 * an id that is not in `known` would put the switcher in a state with no active
 * entry, which is the failure this function exists to prevent.
 *
 * A known but unselectable id is KEPT. A persisted `production` that has since
 * been torn down stays selected and every page says so, which tells the reader
 * something; silently moving them to another environment tells them nothing and
 * changes what they are looking at.
 */
export function parseEnvironment(raw: string | null | undefined, known: readonly EnvironmentId[]): EnvironmentId {
	if (typeof raw === 'string' && known.includes(raw)) return raw;
	if (known.includes(DEFAULT_ENVIRONMENT)) return DEFAULT_ENVIRONMENT;
	return known[0] ?? LOCAL_ENVIRONMENT;
}

/**
 * Read the stored environment through a caller-supplied getter, defensively —
 * and WITHOUT validating it against the environments on offer.
 *
 * The offer is not known at mount: the stage list arrives from a request. An
 * earlier version took `known` and validated here, which moved a reader whose
 * stored environment was `production` onto something else for as long as that
 * request was in flight — changing what they were looking at because a fetch had
 * not landed yet. Validation belongs at the point the offer becomes known, which
 * is {@link parseEnvironment}; this function's whole job is to survive storage.
 *
 * Storage access can THROW rather than return null — privacy modes and
 * partitioned contexts refuse it outright — and an exception escaping a mount
 * effect was observed blanking the entire dashboard when the theme did exactly
 * this (D45). The failure degrades to the default instead.
 */
export function readStoredEnvironment(read: () => string | null): EnvironmentId {
	try {
		const raw = read();
		return typeof raw === 'string' && raw !== '' ? raw : DEFAULT_ENVIRONMENT;
	} catch {
		return DEFAULT_ENVIRONMENT;
	}
}

/** Persist, defensively: a refused write must not take the switcher down with it. */
export function writeStoredEnvironment(write: (value: string) => void, id: EnvironmentId): void {
	try {
		write(id);
	} catch {
		// Nothing to do: the selection still applies to this page, it just will
		// not survive a reload. Failing the click would be worse.
	}
}
