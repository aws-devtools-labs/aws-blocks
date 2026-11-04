// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The second-level navigation model: everything the block/resource nav shows,
 * derived from the two API responses and nothing else.
 *
 * WHY THIS IS NOT IN A COMPONENT
 *
 * The test runner is `node --test dist/**\/*.test.js`, and `dist` is built from
 * `tsconfig.server.json`. Anything under `app/` or in a `.tsx` file is therefore
 * unreachable by a unit test — the gap that left the unlock gate's only
 * enforcement point unverified. This module decides what the nav says; the
 * component only renders it.
 *
 * WHY THE TREE IS BUILT FROM BLOCKS AND ONLY DECORATED BY RESOURCES
 *
 * `GET /api/v1/blocks` is a source scan: no credentials, works with nothing
 * deployed, which is what keeps the Blocks page and the doctor usable offline.
 * `GET /api/v1/resources` needs CloudFormation and fails whenever a credential
 * expires. If the tree were the join of the two, an expired credential would
 * blank the navigation itself. So blocks produce the nodes and resources only
 * add counts and the framework sections — losing resources costs you detail,
 * never your way around.
 */

import type {
	BlockCategory,
	BlocksResponse,
	DiscoveredBlock,
	ResourceGroup,
	ResourcesResponse,
} from '../contract/v1.js';

/**
 * Fixed category order, shared by the nav and the index page so the two cannot
 * disagree about where a group belongs. Deliberately not object-key or
 * first-seen order: the groups must land in the same place for every project.
 * `unknown` sorts last because it is a discovery affordance rather than part of
 * the inventory.
 */
export const CATEGORY_ORDER: readonly BlockCategory[] = [
	'core',
	'auth',
	'data',
	'storage',
	'messaging',
	'compute',
	'ai',
	'config',
	'observability',
	'hosting',
	'unknown',
];

export const CATEGORY_LABEL: Record<BlockCategory, string> = {
	core: 'Core',
	auth: 'Authentication',
	data: 'Data',
	storage: 'Storage',
	messaging: 'Messaging',
	compute: 'Compute',
	ai: 'AI',
	config: 'Configuration',
	observability: 'Observability',
	hosting: 'Hosting',
	unknown: 'Unrecognised type',
};

/**
 * Why a block is not shown as deployed. The four cases are genuinely different
 * and were once collapsed into one sentence that always blamed an undeployed
 * stage — which reads as a lie on a stage that IS deployed.
 *
 * - `not-deployed`: nothing is deployed for this stage, so "declared only" is
 *   the expected, unremarkable state.
 * - `unmatched`: the stage IS deployed and this block has no resource group in
 *   it. Worth noticing — usually the block was added since the last deploy.
 * - `no-own-resources`: the block owns no resources of its own by design, so it
 *   is never matched however healthy the deploy is.
 * - `unknown`: the deployed resources could not be read. We do not know, and
 *   saying any of the above would be a guess.
 */
export type UnmatchedReason = 'not-deployed' | 'unmatched' | 'no-own-resources' | 'unknown' | 'not-applicable';

/** Tooltip per reason. Kept beside {@link UnmatchedReason} so the two cannot drift. */
/**
 * What is missing FROM THE NAV in the local environment, and why.
 *
 * Deliberately not `localNotApplicableReason('resources')`, which the nav footer
 * used to borrow: that sentence is the Resources PILLAR's, and it ends "…or open
 * Blocks to see what your app declares" — an instruction the nav renders on the
 * Blocks page itself, telling the reader to open the page they are already on.
 * This one is scoped to what the nav actually lost, matching the shape of the
 * `resourcesUnavailable` sentence beside it: name the missing parts, and do not
 * let their absence read as a stack with nothing in it.
 */
export const NAV_RESOURCES_NOT_APPLICABLE =
	'Resource counts and the framework sections come from a deployed stack, which a local run does not create, so they are absent here rather than empty. Select a deployed environment to see them.';

export const UNMATCHED_BADGE_TITLE: Record<UnmatchedReason, string> = {
	'not-deployed': 'Declared in source. Nothing is deployed for this stage, so there is nothing to match it to.',
	unmatched:
		'Declared in source but absent from the deployed stack for this stage — usually added since the last deploy.',
	'no-own-resources':
		'This block owns no resources of its own — it is served by the shared Blocks API — so it is never matched to a block-specific resource group.',
	unknown: 'Declared in source. The deployed resources could not be read, so its deployment state is unknown.',
	'not-applicable':
		'Declared in source. The local environment has no deployed stack, so its deployment state was never looked up — this is not a claim that nothing is deployed.',
};

/**
 * Block types that own no CloudFormation resources, so being unmatched is their
 * normal state rather than a finding. Verified against each construct:
 *
 * - `ApiNamespace`, `RawRoute` — served by the shared platform API group, which
 *   the attribution rule deliberately does not hand to the block.
 * - `Metrics` — extends Scope and creates nothing; EMF goes out via stdout.
 * - `Tracer` — sets tracing on the SHARED handler and adds a policy statement.
 * - `EmailClient` — adds a role policy and warns; no construct of its own.
 * - `Logger` — creates a log group ONLY when `retention` is set, so it owns
 *   nothing in the common configuration. It is included because this set governs
 *   only the explanation for an already-unmatched block: a `Logger` that did
 *   create a group is matched, and so never reaches this text at all.
 */
export const TYPES_WITHOUT_OWN_RESOURCES: ReadonlySet<string> = new Set([
	'ApiNamespace',
	'RawRoute',
	'Metrics',
	'Tracer',
	'EmailClient',
	'Logger',
]);

/**
 * The resources request as the nav sees it. Modelled explicitly rather than as
 * `ResourcesResponse | undefined` because "still loading" and "failed" must not
 * collapse into "nothing deployed" — that collapse is the defect the five-way
 * {@link UnmatchedReason} exists to prevent.
 *
 * `not-applicable` is the local environment: there is no stack, so the request is
 * never issued (D78). It is a state of its own rather than `pending` or `error`
 * because both of those describe an attempt — and a disabled query reported as
 * `pending` made every block read "the deployed resources could not be read",
 * which is false when nothing ever tried to read them.
 */
export type ResourcesState =
	| { state: 'pending' }
	| { state: 'error' }
	| { state: 'not-applicable' }
	| { state: 'loaded'; response: ResourcesResponse };

/** A colour role, resolved to a concrete badge variant by the component. */
export type NavTone = 'neutral' | 'ok' | 'warn' | 'danger';

export interface NavTag {
	label: string;
	tone: NavTone;
	/** Hover text. An icon-free badge still needs to explain itself. */
	title?: string;
}

/** One card in the nav. */
export interface NavCard {
	/** Stable React key. Not the href: two declarations can share a `fullId`. */
	key: string;
	/**
	 * Where the card navigates. Absent for a card that has nothing to open, which
	 * the component must render as static text rather than as a dead link.
	 */
	href?: string;
	/** Primary heading — the block class, or the construct path for a framework group. */
	title: string;
	/** Secondary mono line: the block's scope-qualified id. */
	subtitle?: string;
	/** What this block TYPE does, from the generated catalog. Often absent. */
	description?: string;
	/**
	 * Facts about THIS instance, true by construction (key schema, method count,
	 * resource count). These carry the card when `description` is absent.
	 */
	facts: string[];
	tags: NavTag[];
	/** Set for a block card, so the component can mark the active route. */
	fullId?: string;
}

export type NavSectionKind = 'blocks' | 'unattributed' | 'platform' | 'cdk';

export interface NavSection {
	id: string;
	label: string;
	kind: NavSectionKind;
	/** e.g. '3 blocks' or '12 groups · 40 resources'. */
	summary: string;
	/**
	 * How many items the section holds unfiltered, and what to call one. A heading
	 * reading "13 blocks" above two filtered cards is a false statement, and the
	 * summary string alone cannot be narrowed without re-deriving the noun.
	 */
	count: number;
	itemNoun: 'block' | 'group';
	/** Explains a section whose contents are not self-evident. */
	description?: string;
	/**
	 * Whether the reader may fold this section away at all.
	 *
	 * False for your own blocks: their category headings are labels, not controls.
	 * A category is not a container you put things away into — every block you
	 * declared is something you might navigate to, so there is nothing to gain by
	 * hiding `Data` and nothing to explain when its chevron does nothing useful.
	 * Rendering a heading as a button that only ever removes content is a control
	 * whose best outcome is the state it started in.
	 *
	 * True for the deployed groups: framework and CDK internals are reference
	 * material you scroll past, and there are 16 of them against a handful of
	 * blocks.
	 */
	collapsible: boolean;
	/** Only meaningful when `collapsible`. Framework internals start closed. */
	defaultCollapsed: boolean;
	cards: NavCard[];
}

export interface InventoryTree {
	sections: NavSection[];
	/**
	 * Constructs that look like a block but could not be resolved. They are NOT
	 * cards: there is no page to open for one, and a nav item that cannot be
	 * clicked is worse than a count with a link to the index that explains them.
	 */
	unknownCount: number;
	/** Blocks declared in source, however many are deployed. */
	totalBlocks: number;
	/** True when the deployed side could not be read, so counts are missing rather than zero. */
	resourcesUnavailable: boolean;
	/**
	 * True when there was nothing to read: the local environment has no stack, so
	 * the request was never issued.
	 *
	 * Separate from {@link resourcesUnavailable} because they call for different
	 * sentences — "could not be read" invites a fix (credentials, a region) that
	 * does not apply here, and it is a claim about an attempt that never happened.
	 * Exactly one of the two is ever true.
	 */
	resourcesNotApplicable: boolean;
}

export interface BuildInventoryTreeInput {
	/** The blocks response, or undefined while it is loading or after it failed. */
	blocks: BlocksResponse | undefined;
	resources: ResourcesState;
}

function plural(count: number, noun: string): string {
	return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

export function blockHref(fullId: string): string {
	return `/blocks/${encodeURIComponent(fullId)}`;
}

export function resourceGroupHref(groupId: string): string {
	return `/resources/${encodeURIComponent(groupId)}`;
}

/** The route prefixes a card can point at. Both take one encoded segment. */
const CARD_PATH_PREFIXES = ['/blocks/', '/resources/'] as const;

/**
 * Whether a card names the page currently open.
 *
 * Not plain string equality against the href, because a group id contains
 * slashes by construction (`my-app/todos`) and a block id may contain anything:
 * the href always carries that segment percent-encoded, while a pathname handed
 * to us may be either form. Comparing one spelling against the other loses the
 * selected state silently — the nav simply stops highlighting anything, with no
 * error to notice. So the encoded form is checked first, then the last segment is
 * re-encoded and checked again.
 */
export function isCardActive(card: NavCard, pathname: string): boolean {
	if (!card.href) return false;
	if (card.href === pathname) return true;
	for (const prefix of CARD_PATH_PREFIXES) {
		if (!pathname.startsWith(prefix)) continue;
		return card.href === `${prefix}${encodeURIComponent(pathname.slice(prefix.length))}`;
	}
	return false;
}

/**
 * The stage-level answer to "why is nothing matched", before any per-block
 * override. Mirrors the doctor's three-way stack probe: a lookup that never
 * succeeded must not be reported as "nothing deployed".
 *
 * With one exception, which the original three-way form got wrong.
 * `STACK_NOT_FOUND` is not an unreadable stack — it is the provider positively
 * reporting that no such stack exists, which is exactly "this stage is not
 * deployed". Routing it to `unknown` made the `not-deployed` branch nearly
 * unreachable in practice (it otherwise needs a stack that exists and holds zero
 * resources) and told someone whose stage was simply never deployed that we
 * could not read it. The provider raises that code only for `does not exist` /
 * `StackNotFound`, so it carries no other meaning.
 */
export function stageUnmatchedReason(resources: ResourcesState): UnmatchedReason {
	// Checked before `pending`/`error`: not-applicable is the absence of an
	// attempt, and reporting it as `unknown` would say the read failed.
	if (resources.state === 'not-applicable') return 'not-applicable';
	if (resources.state !== 'loaded') return 'unknown';
	const { response } = resources;
	if (response.resourcesSource !== 'cloudformation') {
		return response.resourcesErrorCode === 'STACK_NOT_FOUND' ? 'not-deployed' : 'unknown';
	}
	return response.groups.length === 0 ? 'not-deployed' : 'unmatched';
}

/**
 * The per-block reason. The type override applies ONLY to a genuine miss against
 * a stack we actually read: for `not-deployed` and `unknown` the stage-level
 * truth is both correct and more useful, and overriding it would tell someone
 * whose stage is not deployed that the type owns nothing — a different claim,
 * and for a conditional type like `Logger` a false one.
 */
export function reasonForBlock(blockType: string, stageReason: UnmatchedReason): UnmatchedReason {
	return stageReason === 'unmatched' && TYPES_WITHOUT_OWN_RESOURCES.has(blockType) ? 'no-own-resources' : stageReason;
}

/** fullId → the deployed groups carrying that block's label. */
export function groupsByBlock(groups: readonly ResourceGroup[]): Map<string, ResourceGroup[]> {
	const byBlock = new Map<string, ResourceGroup[]>();
	for (const group of groups) {
		if (!group.blockFullId) continue;
		const existing = byBlock.get(group.blockFullId);
		if (existing) existing.push(group);
		else byBlock.set(group.blockFullId, [group]);
	}
	return byBlock;
}

/** Up to three resource type labels, so a framework card says what is in it. */
export function typeSummary(group: ResourceGroup, limit = 3): string[] {
	const labels: string[] = [];
	for (const resource of group.resources) {
		const label = resource.typeLabel ?? resource.resourceType;
		if (!labels.includes(label)) labels.push(label);
	}
	if (labels.length <= limit) return labels;
	return [...labels.slice(0, limit), `+${labels.length - limit} more`];
}

/**
 * Facts derived from the block itself plus its matched groups. Every one is read
 * off data we already have, so none of them can be stale or wrong in the way a
 * hand-written summary could.
 */
export function blockFacts(block: DiscoveredBlock, matched: readonly ResourceGroup[]): string[] {
	const facts: string[] = [];
	if (block.keySchema) {
		facts.push(`partition ${block.keySchema.partitionKey}`);
		if (block.keySchema.sortKey) facts.push(`sort ${block.keySchema.sortKey}`);
	}
	if (block.methods && block.methods.length > 0) facts.push(plural(block.methods.length, 'method'));
	const resourceCount = matched.reduce((total, group) => total + group.resources.length, 0);
	if (resourceCount > 0) facts.push(plural(resourceCount, 'resource'));
	return facts;
}

/**
 * The deployment badge a block carries, on the nav AND on the Blocks index page.
 *
 * Exported because both surfaces render it. The Blocks page used to hand-write
 * its own copy and the two drifted: the page gave every non-deployed block a
 * neutral badge, losing the `warn` colour that makes `unmatched` — the one case
 * worth noticing — stand out, and it titled the `not-applicable` badge with the
 * pillar-level `localNotApplicableReason('resources')` sentence, which ends
 * "…or open Blocks to see what your app declares" and so told the reader to open
 * the page they were already on. One definition, reached by a test, prevents both.
 */
export function deploymentTag(deployed: boolean, reason: UnmatchedReason, groupIds: readonly string[]): NavTag {
	if (deployed) {
		return {
			label: 'deployed',
			tone: 'ok',
			title: `Matched to deployed resource group${groupIds.length === 1 ? '' : 's'}: ${groupIds.join(', ')}`,
		};
	}
	return {
		// "declared only" is a verdict reached by comparing against a stack we read.
		// With no stack read there is no verdict, so the label says so rather than
		// borrowing one — the tone stays neutral because nothing is wrong.
		label: reason === 'not-applicable' ? 'not applicable' : 'declared only',
		// `unmatched` is the one case worth noticing; the rest are expected states,
		// so only that one gets a colour that draws the eye.
		tone: reason === 'unmatched' ? 'warn' : 'neutral',
		title: UNMATCHED_BADGE_TITLE[reason],
	};
}

export function blockCard(
	block: DiscoveredBlock,
	matched: readonly ResourceGroup[],
	stageReason: UnmatchedReason,
): NavCard {
	const reason = reasonForBlock(block.type, stageReason);
	const groupIds = matched.map((group) => group.id);
	const card: NavCard = {
		// A duplicate `fullId` is a real user error that the blocks response emits
		// twice rather than deduping, so file:line is what keeps the keys distinct.
		key: `${block.file}:${block.line}:${block.fullId}`,
		href: blockHref(block.fullId),
		title: block.type,
		subtitle: block.fullId,
		facts: blockFacts(block, matched),
		tags: [
			{ label: block.id, tone: 'neutral', title: 'Block id as declared in your source' },
			deploymentTag(groupIds.length > 0, reason, groupIds),
		],
		fullId: block.fullId,
	};
	if (block.description) card.description = block.description;
	return card;
}

function groupCard(group: ResourceGroup): NavCard {
	const card: NavCard = {
		key: `group:${group.id}`,
		href: resourceGroupHref(group.id),
		title: group.id,
		facts: typeSummary(group),
		tags: [{ label: plural(group.resources.length, 'resource'), tone: 'neutral' }],
	};
	if (group.blockType) card.subtitle = group.blockType;
	return card;
}

/**
 * App groups the labelling pass could not attribute to a declared block.
 *
 * These must be reachable. Once Resources stops being its own destination, a
 * group that reaches no block reaches nothing at all — its resources would
 * silently vanish from the dashboard, which is the failure mode of merging two
 * views into one. The label depends on whether the block scan succeeded: with no
 * scan, EVERY app group is unmatched, and calling those "not declared" would be
 * a statement about source we never read.
 */
function unattributedSection(groups: readonly ResourceGroup[], blocksScanned: boolean): NavSection | undefined {
	const orphans = groups.filter((group) => group.category === 'app' && !group.blockFullId);
	if (orphans.length === 0) return undefined;
	return {
		id: 'unattributed',
		kind: 'unattributed',
		label: blocksScanned ? 'Deployed but not declared' : 'Deployed resources',
		summary: plural(orphans.length, 'group'),
		count: orphans.length,
		itemNoun: 'group',
		collapsible: true,
		description: blocksScanned
			? 'Attributed to an app block that is not declared in your source — usually a block that was removed without a deploy.'
			: 'The block declarations could not be read, so these deployed groups could not be matched to a block.',
		defaultCollapsed: false,
		cards: orphans.map(groupCard),
	};
}

/**
 * Labels for a deployed group's category, shared by the nav, the Resources page
 * and the group detail page. The platform and CDK strings were already written
 * out twice, in the nav model and on the Resources page, before a third view
 * needed them.
 */
export const RESOURCE_CATEGORY_LABEL: Record<ResourceGroup['category'], string> = {
	app: 'Your blocks',
	platform: 'Blocks platform',
	cdk: 'CDK internals',
};

/** Total resources across several groups. */
export function countResources(groups: readonly ResourceGroup[]): number {
	return groups.reduce((total, group) => total + group.resources.length, 0);
}

/**
 * The group a `/resources/[groupId]` route param names.
 *
 * A group id contains slashes by construction (`my-app/todos`), so the param is
 * percent-encoded in the href — but Next hands a dynamic segment to a page
 * already decoded, and a segment that reached the server by another route may
 * not be. Matching on one spelling only would 404 a group that exists, so both
 * are tried. Returns undefined when no group matches, which the page must
 * present as "no such group" rather than as an error.
 */
export function findGroupById(groups: readonly ResourceGroup[], param: string): ResourceGroup | undefined {
	const direct = groups.find((group) => group.id === param);
	if (direct) return direct;
	let decoded: string;
	try {
		decoded = decodeURIComponent(param);
	} catch {
		// A malformed escape sequence is not a group id; the raw compare above
		// already had its chance.
		return undefined;
	}
	return groups.find((group) => group.id === decoded);
}

/**
 * Why the nav has nothing to show, when it has nothing to show.
 *
 * Kept out of the component because these are five different situations and the
 * component's job is to phrase them, not to work out which one holds. Getting it
 * wrong is the same class of error as the four-way `UnmatchedReason`: "no blocks
 * here" and "we could not read your source" look identical in an empty list.
 */
export type NavStatus =
	/** The source scan has not answered yet. */
	| { kind: 'loading' }
	/** The request itself failed — the dashboard API is unreachable or refused us. */
	| { kind: 'unreachable' }
	/** The server answered, and the answer is that it could not scan. */
	| { kind: 'unavailable'; code?: BlocksResponse['blocksErrorCode']; message?: string }
	/** Scanned successfully and this project declares nothing. */
	| { kind: 'empty' }
	| { kind: 'ready' };

export interface NavStatusInput {
	blocks: BlocksResponse | undefined;
	pending: boolean;
	failed: boolean;
}

export function navStatus({ blocks, pending, failed }: NavStatusInput): NavStatus {
	if (failed) return { kind: 'unreachable' };
	if (pending || !blocks) return { kind: 'loading' };
	if (blocks.blocksSource !== 'source-scan') {
		const status: NavStatus = { kind: 'unavailable' };
		if (blocks.blocksErrorCode) status.code = blocks.blocksErrorCode;
		if (blocks.blocksError) status.message = blocks.blocksError;
		return status;
	}
	// Unknown constructs count as content: a project whose only block is one the
	// scanner could not resolve is not an empty project, and saying so would hide
	// the one thing worth looking at.
	if (blocks.blocks.length === 0 && blocks.unknownConstructs.length === 0) return { kind: 'empty' };
	return { kind: 'ready' };
}

/** What a filter did, so the nav can explain a short list. */
export interface FilteredTree {
	sections: NavSection[];
	/** Cards the query removed. */
	hidden: number;
	/**
	 * Cards that matched the query on their own merit. Counted separately from
	 * what is shown, because the card for the open page is retained whether it
	 * matched or not — so "shown" alone cannot tell "one hit" from "no hits, and
	 * here is where you are".
	 */
	matched: number;
	/**
	 * True when the card for the page you have open did not match but is shown
	 * anyway. Dropping it would make the nav lose the page you are on — the same
	 * defect as a collapsed section hiding it.
	 */
	keptActive: boolean;
}

/** Everything a card can be found by. Lowercased once per card, not per term. */
function cardHaystack(card: NavCard): string {
	return [card.title, card.subtitle, card.description, ...card.facts, ...card.tags.map((tag) => tag.label)]
		.filter((part): part is string => typeof part === 'string')
		.join(' ')
		.toLowerCase();
}

/**
 * Narrows the tree to cards matching every whitespace-separated term.
 *
 * All terms must match (`auth cognito` means both), because with a long
 * inventory an OR search returns almost everything and is no help. Matching is a
 * plain case-insensitive substring: a nav filter is for finding `todos` when you
 * can see it in the list, not for expressing a query language.
 *
 * A section that loses every card is dropped rather than rendered empty, and a
 * blank query returns the tree untouched.
 */
export function filterTree(sections: readonly NavSection[], query: string, pathname: string): FilteredTree {
	const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
	if (terms.length === 0) {
		return { sections: [...sections], hidden: 0, matched: 0, keptActive: false };
	}

	let hidden = 0;
	let matched = 0;
	let keptActive = false;
	const filtered: NavSection[] = [];

	for (const section of sections) {
		const cards = section.cards.filter((card) => {
			const haystack = cardHaystack(card);
			if (terms.every((term) => haystack.includes(term))) {
				matched += 1;
				return true;
			}
			if (isCardActive(card, pathname)) {
				keptActive = true;
				return true;
			}
			hidden += 1;
			return false;
		});
		if (cards.length === 0) continue;
		filtered.push({
			...section,
			cards,
			// A heading must describe the list under it, not the list it would have
			// shown unfiltered.
			summary:
				cards.length === section.count
					? section.summary
					: `${cards.length} of ${plural(section.count, section.itemNoun)}`,
		});
	}

	return { sections: filtered, hidden, matched, keptActive };
}

/**
 * Whether this section holds the page currently open.
 *
 * A collapsed section must not hide the very thing you are looking at: opening a
 * framework group from the nav lands you on a page whose card sits inside a
 * section that is closed by default, so without this the nav silently loses your
 * place at the moment you use it.
 */
export function isSectionActive(section: NavSection, pathname: string): boolean {
	return section.cards.some((card) => isCardActive(card, pathname));
}

function frameworkSection(
	groups: readonly ResourceGroup[],
	kind: 'platform' | 'cdk',
	label: string,
	description: string,
): NavSection | undefined {
	const matching = groups.filter((group) => group.category === kind);
	if (matching.length === 0) return undefined;
	return {
		id: kind,
		kind,
		label,
		// Both counts, because neither answers the question alone: 15 groups says
		// nothing about size, and 69 resources says nothing about how far the list
		// expands. The Resources page showed the same pair.
		summary: `${plural(matching.length, 'group')} · ${plural(countResources(matching), 'resource')}`,
		count: matching.length,
		itemNoun: 'group',
		collapsible: true,
		description,
		// Framework internals are reference material, not where the work is.
		defaultCollapsed: true,
		cards: matching.map(groupCard),
	};
}

/**
 * Builds the whole nav from the two responses.
 *
 * Blocks come first, in fixed category order, then anything deployed that no
 * block claims, then the framework's own resources. A section with no cards is
 * omitted rather than rendered empty.
 */
export function buildInventoryTree({ blocks, resources }: BuildInventoryTreeInput): InventoryTree {
	const blocksScanned = blocks?.blocksSource === 'source-scan';
	const declared = blocks?.blocks ?? [];
	const loaded = resources.state === 'loaded' ? resources.response : undefined;
	const groups = loaded?.groups ?? [];
	const matchedByBlock = groupsByBlock(groups);
	const stageReason = stageUnmatchedReason(resources);

	const sections: NavSection[] = [];

	for (const category of CATEGORY_ORDER) {
		const inCategory = declared.filter((block) => block.category === category);
		if (inCategory.length === 0) continue;
		sections.push({
			id: category,
			kind: 'blocks',
			label: CATEGORY_LABEL[category],
			summary: plural(inCategory.length, 'block'),
			count: inCategory.length,
			itemNoun: 'block',
			// A category heading is a label. See `collapsible`.
			collapsible: false,
			defaultCollapsed: false,
			cards: inCategory.map((block) => blockCard(block, matchedByBlock.get(block.fullId) ?? [], stageReason)),
		});
	}

	const unattributed = unattributedSection(groups, blocksScanned);
	if (unattributed) sections.push(unattributed);

	const platform = frameworkSection(
		groups,
		'platform',
		RESOURCE_CATEGORY_LABEL.platform,
		'Created by the Blocks framework itself — the API, the shared handler, the stack internals. Not declared by your app.',
	);
	if (platform) sections.push(platform);

	const cdk = frameworkSection(
		groups,
		'cdk',
		RESOURCE_CATEGORY_LABEL.cdk,
		'CDK bookkeeping: custom-resource providers and metadata. Present in every CDK stack.',
	);
	if (cdk) sections.push(cdk);

	const notApplicable = resources.state === 'not-applicable';

	return {
		sections,
		unknownCount: blocks?.unknownConstructs.length ?? 0,
		totalBlocks: declared.length,
		// Not `!loaded`: a response that arrived saying `resourcesSource:
		// 'unavailable'` is exactly as unreadable as a failed request. Excludes the
		// local case, where nothing was read because nothing was asked.
		resourcesUnavailable: !notApplicable && loaded?.resourcesSource !== 'cloudformation',
		resourcesNotApplicable: notApplicable,
	};
}
