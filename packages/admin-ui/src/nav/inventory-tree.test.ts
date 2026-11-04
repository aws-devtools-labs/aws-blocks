// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { API_VERSION } from '../contract/v1.js';
import { localNotApplicableReason } from '../env/environment.js';
import type {
	BlocksResponse,
	DiscoveredBlock,
	ResourceGroup,
	ResourceInfo,
	ResourcesResponse,
} from '../contract/v1.js';
import {
	CATEGORY_ORDER,
	NAV_RESOURCES_NOT_APPLICABLE,
	TYPES_WITHOUT_OWN_RESOURCES,
	UNMATCHED_BADGE_TITLE,
	blockCard,
	blockFacts,
	blockHref,
	buildInventoryTree,
	countResources,
	filterTree,
	findGroupById,
	groupsByBlock,
	isCardActive,
	isSectionActive,
	navStatus,
	reasonForBlock,
	resourceGroupHref,
	stageUnmatchedReason,
	typeSummary,
} from './inventory-tree.js';
import type { NavSection, ResourcesState } from './inventory-tree.js';

// ─── Fixtures ────────────────────────────────────────────────────────────────

function block(overrides: Partial<DiscoveredBlock> = {}): DiscoveredBlock {
	return {
		type: 'DistributedTable',
		id: 'todos',
		fullId: 'my-app-todos',
		category: 'data',
		file: 'aws-blocks/index.ts',
		line: 42,
		...overrides,
	};
}

function resource(overrides: Partial<ResourceInfo> = {}): ResourceInfo {
	return { logicalResourceId: 'Table123', resourceType: 'AWS::DynamoDB::Table', ...overrides };
}

function group(overrides: Partial<ResourceGroup> = {}): ResourceGroup {
	return { id: 'my-app/todos', category: 'app', resources: [resource()], ...overrides };
}

function blocksResponse(overrides: Partial<BlocksResponse> = {}): BlocksResponse {
	return {
		apiVersion: API_VERSION,
		blocksSource: 'source-scan',
		projectName: 'my-app',
		blocks: [],
		unknownConstructs: [],
		scannedFiles: 1,
		...overrides,
	};
}

function resourcesResponse(overrides: Partial<ResourcesResponse> = {}): ResourcesResponse {
	return {
		apiVersion: API_VERSION,
		stage: 'sandbox',
		resourcesSource: 'cloudformation',
		groups: [],
		totalResources: 0,
		...overrides,
	};
}

const loaded = (groups: ResourceGroup[]): ResourcesState => ({
	state: 'loaded',
	response: resourcesResponse({ groups, totalResources: groups.reduce((n, g) => n + g.resources.length, 0) }),
});

const section = (tree: ReturnType<typeof buildInventoryTree>, id: string) =>
	tree.sections.find((candidate) => candidate.id === id);

// ─── The four-way reason, which is the whole point of not collapsing states ───

describe('stageUnmatchedReason', () => {
	it('is unknown while the request is in flight', () => {
		assert.equal(stageUnmatchedReason({ state: 'pending' }), 'unknown');
	});

	it('is unknown when the request failed', () => {
		assert.equal(stageUnmatchedReason({ state: 'error' }), 'unknown');
	});

	it('is not-applicable when there was nothing to ask', () => {
		// The local environment has no stack, so the request is never issued. A
		// disabled query reported as `pending` mapped to `unknown`, which told every
		// reader "the deployed resources could not be read" about a read that was
		// never attempted.
		assert.equal(stageUnmatchedReason({ state: 'not-applicable' }), 'not-applicable');
	});

	it('is unknown when the response arrived but could not read CloudFormation', () => {
		// A 200 saying "unavailable" is exactly as uninformative as a failed
		// request, and reporting it as "nothing deployed" is the original defect.
		assert.equal(
			stageUnmatchedReason({
				state: 'loaded',
				response: resourcesResponse({
					resourcesSource: 'unavailable',
					resourcesErrorCode: 'CREDENTIALS_MISSING',
				}),
			}),
			'unknown',
		);
	});

	it('is not-deployed for STACK_NOT_FOUND, which positively says there is no stack', () => {
		// Not an unreadable stack: the provider raises this code only for `does not
		// exist` / `StackNotFound`. Routing it to `unknown` told someone whose stage
		// was simply never deployed that we could not read it, and left the
		// `not-deployed` branch reachable only via a stack holding zero resources.
		assert.equal(
			stageUnmatchedReason({
				state: 'loaded',
				response: resourcesResponse({ resourcesSource: 'unavailable', resourcesErrorCode: 'STACK_NOT_FOUND' }),
			}),
			'not-deployed',
		);
	});

	it('is unknown for an unavailable response with no error code at all', () => {
		assert.equal(
			stageUnmatchedReason({ state: 'loaded', response: resourcesResponse({ resourcesSource: 'unavailable' }) }),
			'unknown',
		);
	});

	it('is not-deployed when the stack was read and holds nothing', () => {
		assert.equal(stageUnmatchedReason(loaded([])), 'not-deployed');
	});

	it('is unmatched when the stack was read and holds groups', () => {
		assert.equal(stageUnmatchedReason(loaded([group()])), 'unmatched');
	});
});

describe('reasonForBlock', () => {
	it('downgrades a genuine miss to no-own-resources for a type that owns nothing', () => {
		assert.equal(reasonForBlock('ApiNamespace', 'unmatched'), 'no-own-resources');
	});

	it('leaves a genuine miss alone for a type that should own resources', () => {
		assert.equal(reasonForBlock('DistributedTable', 'unmatched'), 'unmatched');
	});

	for (const stageReason of ['not-deployed', 'unknown'] as const) {
		it(`does not override ${stageReason}, where the stage-level truth is the useful one`, () => {
			// Telling someone whose stage is not deployed that the type owns nothing
			// is a different claim — and for a conditional type like Logger, false.
			assert.equal(reasonForBlock('Logger', stageReason), stageReason);
		});
	}

	it('covers every type the set names', () => {
		for (const type of TYPES_WITHOUT_OWN_RESOURCES) {
			assert.equal(reasonForBlock(type, 'unmatched'), 'no-own-resources', type);
		}
	});
});

// ─── Correlation ─────────────────────────────────────────────────────────────

describe('groupsByBlock', () => {
	it('ignores a group with no block label', () => {
		assert.equal(groupsByBlock([group({ blockFullId: undefined })]).size, 0);
	});

	it('collects every group a block owns, not just the first', () => {
		const byBlock = groupsByBlock([
			group({ id: 'my-app/auth', blockFullId: 'my-app-auth' }),
			group({ id: 'my-app/auth-extra', blockFullId: 'my-app-auth' }),
		]);
		assert.deepEqual(
			byBlock.get('my-app-auth')?.map((g) => g.id),
			['my-app/auth', 'my-app/auth-extra'],
		);
	});
});

describe('blockFacts', () => {
	it('names both halves of a composite key separately', () => {
		const facts = blockFacts(block({ keySchema: { partitionKey: 'userId', sortKey: 'todoId' } }), []);
		assert.deepEqual(facts, ['partition userId', 'sort todoId']);
	});

	it('omits the sort key when there is none', () => {
		assert.deepEqual(blockFacts(block({ keySchema: { partitionKey: 'userId' } }), []), ['partition userId']);
	});

	it('counts methods and singularises one', () => {
		assert.deepEqual(blockFacts(block({ methods: [{ name: 'a', params: [] }] }), []), ['1 method']);
	});

	it('sums resources across every group the block owns', () => {
		const facts = blockFacts(block(), [
			group({ resources: [resource(), resource({ logicalResourceId: 'B' })] }),
			group({ id: 'other', resources: [resource({ logicalResourceId: 'C' })] }),
		]);
		assert.deepEqual(facts, ['3 resources']);
	});

	it('says nothing about resources when none are matched, rather than "0 resources"', () => {
		assert.deepEqual(blockFacts(block(), []), []);
	});

	it('omits an empty methods array instead of reporting "0 methods"', () => {
		assert.deepEqual(blockFacts(block({ methods: [] }), []), []);
	});
});

describe('typeSummary', () => {
	it('deduplicates repeated types', () => {
		const summary = typeSummary(
			group({
				resources: [
					resource({ typeLabel: 'DynamoDB Table' }),
					resource({ logicalResourceId: 'B', typeLabel: 'DynamoDB Table' }),
				],
			}),
		);
		assert.deepEqual(summary, ['DynamoDB Table']);
	});

	it('falls back to the raw CloudFormation type when there is no label', () => {
		assert.deepEqual(typeSummary(group({ resources: [resource()] })), ['AWS::DynamoDB::Table']);
	});

	it('caps the list and counts the remainder', () => {
		const resources = ['A', 'B', 'C', 'D', 'E'].map((id) => resource({ logicalResourceId: id, typeLabel: id }));
		assert.deepEqual(typeSummary(group({ resources }), 3), ['A', 'B', 'C', '+2 more']);
	});
});

// ─── Cards ───────────────────────────────────────────────────────────────────

describe('blockCard', () => {
	it('carries the catalog description when the block has one', () => {
		const card = blockCard(block({ description: 'Structured data storage.' }), [], 'not-deployed');
		assert.equal(card.description, 'Structured data storage.');
	});

	it('omits description entirely when the block has none, so no blank line renders', () => {
		const card = blockCard(block(), [], 'not-deployed');
		assert.ok(!('description' in card));
	});

	it('tags a matched block as deployed and names the groups in the tooltip', () => {
		const card = blockCard(block(), [group({ id: 'my-app/todos', blockFullId: 'my-app-todos' })], 'unmatched');
		const tag = card.tags.at(-1);
		assert.equal(tag?.label, 'deployed');
		assert.equal(tag?.tone, 'ok');
		assert.match(String(tag?.title), /my-app\/todos/);
	});

	it('draws attention only to a genuine miss, not to an expected one', () => {
		assert.equal(blockCard(block(), [], 'unmatched').tags.at(-1)?.tone, 'warn');
		for (const reason of ['not-deployed', 'unknown', 'no-own-resources', 'not-applicable'] as const) {
			assert.equal(blockCard(block(), [], reason).tags.at(-1)?.tone, 'neutral', reason);
		}
	});

	it('does not say "declared only" about a comparison it never made', () => {
		// "declared only" is a verdict from comparing against a stack that was read.
		// In the local environment none was, so borrowing the label would assert a
		// deployment state nothing ever established.
		const local = blockCard(block(), [], 'not-applicable');
		assert.equal(local.tags.at(-1)?.label, 'not applicable');
		assert.equal(local.tags.at(-1)?.title, UNMATCHED_BADGE_TITLE['not-applicable']);
		assert.match(String(local.tags.at(-1)?.title), /never looked up/);

		// Every other reason keeps the original label.
		for (const reason of ['not-deployed', 'unmatched', 'unknown', 'no-own-resources'] as const) {
			assert.equal(blockCard(block(), [], reason).tags.at(-1)?.label, 'declared only', reason);
		}
	});

	it('explains "declared only" with the reason it actually applies', () => {
		const card = blockCard(block({ type: 'ApiNamespace' }), [], 'unmatched');
		assert.equal(card.tags.at(-1)?.title, UNMATCHED_BADGE_TITLE['no-own-resources']);
	});

	it('keys on file:line as well as fullId, so a duplicate declaration stays visible', () => {
		const a = blockCard(block({ line: 10 }), [], 'unknown');
		const b = blockCard(block({ line: 20 }), [], 'unknown');
		assert.notEqual(a.key, b.key);
	});

	it('percent-encodes an id that would otherwise break the path', () => {
		assert.equal(blockCard(block({ fullId: 'a/b' }), [], 'unknown').href, '/blocks/a%2Fb');
	});
});

describe('hrefs', () => {
	it('encodes a block id', () => assert.equal(blockHref('my app/todos'), '/blocks/my%20app%2Ftodos'));
	it('encodes a group id, which contains slashes by construction', () => {
		assert.equal(resourceGroupHref('my-app/todos'), '/resources/my-app%2Ftodos');
	});
});

describe('findGroupById', () => {
	const groups = [group({ id: 'my-app/todos' }), group({ id: 'API', category: 'platform' })];

	it('finds a group by its exact id, which is how Next hands over a decoded segment', () => {
		assert.equal(findGroupById(groups, 'my-app/todos')?.id, 'my-app/todos');
	});

	it('finds a group by the ENCODED id the href carries', () => {
		// The failure this prevents: `/resources/my-app%2Ftodos` is the link the nav
		// renders, and matching only the raw param would 404 a group that exists.
		assert.equal(findGroupById(groups, 'my-app%2Ftodos')?.id, 'my-app/todos');
	});

	it('returns undefined for a group that is not in this stack', () => {
		assert.equal(findGroupById(groups, 'Nope'), undefined);
	});

	it('returns undefined rather than throwing on a malformed escape', () => {
		// decodeURIComponent throws on a lone '%'; a 500 would be the wrong answer
		// to a bad URL.
		assert.equal(findGroupById(groups, '%E0%A4%A'), undefined);
	});

	it('returns undefined when there are no groups at all', () => {
		assert.equal(findGroupById([], 'API'), undefined);
	});
});

describe('countResources', () => {
	it('sums across groups', () => {
		assert.equal(
			countResources([group({ resources: [resource(), resource({ logicalResourceId: 'B' })] }), group()]),
			3,
		);
	});
	it('is zero for no groups', () => assert.equal(countResources([]), 0));
});

describe('navStatus', () => {
	it('is loading while the scan is in flight', () => {
		assert.deepEqual(navStatus({ blocks: undefined, pending: true, failed: false }), { kind: 'loading' });
	});

	it('is loading when there is no response yet and nothing failed', () => {
		assert.deepEqual(navStatus({ blocks: undefined, pending: false, failed: false }), { kind: 'loading' });
	});

	it('is unreachable when the request itself failed', () => {
		assert.deepEqual(navStatus({ blocks: undefined, pending: false, failed: true }), { kind: 'unreachable' });
	});

	it('prefers unreachable over a stale response', () => {
		// A failed refetch with cached data must not read as a healthy nav.
		assert.deepEqual(navStatus({ blocks: blocksResponse(), pending: false, failed: true }), {
			kind: 'unreachable',
		});
	});

	it('carries the code and message when the server could not scan', () => {
		assert.deepEqual(
			navStatus({
				blocks: blocksResponse({
					blocksSource: 'unavailable',
					blocksErrorCode: 'NOT_A_BLOCKS_PROJECT',
					blocksError: 'No aws-blocks/index.ts found.',
				}),
				pending: false,
				failed: false,
			}),
			{ kind: 'unavailable', code: 'NOT_A_BLOCKS_PROJECT', message: 'No aws-blocks/index.ts found.' },
		);
	});

	it('is empty only when a successful scan found nothing at all', () => {
		assert.deepEqual(navStatus({ blocks: blocksResponse({ blocks: [] }), pending: false, failed: false }), {
			kind: 'empty',
		});
	});

	it('is NOT empty when the only thing found is an unresolved construct', () => {
		// A project whose one block the scanner could not resolve is not an empty
		// project, and calling it empty hides the one thing worth looking at.
		const status = navStatus({
			blocks: blocksResponse({
				blocks: [],
				unknownConstructs: [
					{ text: 'blocks.Mystery', file: 'aws-blocks/index.ts', line: 3, reason: 'unknown-type' },
				],
			}),
			pending: false,
			failed: false,
		});
		assert.deepEqual(status, { kind: 'ready' });
	});

	it('is ready with blocks', () => {
		assert.deepEqual(navStatus({ blocks: blocksResponse({ blocks: [block()] }), pending: false, failed: false }), {
			kind: 'ready',
		});
	});
});

describe('filterTree', () => {
	const tree = buildInventoryTree({
		blocks: blocksResponse({
			blocks: [
				block({ description: 'Structured data storage backed by DynamoDB.' }),
				block({ type: 'AuthBasic', id: 'auth', fullId: 'my-app-auth', category: 'auth' }),
				block({ type: 'KVStore', id: 'cache', fullId: 'my-app-cache', category: 'data' }),
			],
		}),
		resources: loaded([group({ id: 'API', category: 'platform' })]),
	});
	const all = tree.sections;
	const cardTitles = (sections: NavSection[]) => sections.flatMap((s) => s.cards.map((c) => c.title));

	it('returns the tree untouched for a blank query', () => {
		const result = filterTree(all, '   ', '/blocks');
		assert.equal(result.sections.length, all.length);
		assert.equal(result.hidden, 0);
		assert.equal(result.keptActive, false);
	});

	it('matches on the block type', () => {
		assert.deepEqual(cardTitles(filterTree(all, 'kvstore', '/blocks').sections), ['KVStore']);
	});

	it('is case-insensitive', () => {
		assert.deepEqual(cardTitles(filterTree(all, 'KVSTORE', '/blocks').sections), ['KVStore']);
	});

	it('matches on the id tag', () => {
		assert.deepEqual(cardTitles(filterTree(all, 'cache', '/blocks').sections), ['KVStore']);
	});

	it('matches on the description', () => {
		// 'structured' appears only in the block's catalog description. A term like
		// 'dynamodb' would also match the framework group, whose facts name its
		// resource type — correctly, but it would not prove the description is searched.
		assert.deepEqual(cardTitles(filterTree(all, 'structured', '/blocks').sections), ['DistributedTable']);
	});

	it('matches on a fact, such as a group resource type', () => {
		// 'aws::' appears only in the raw CloudFormation type the group's facts carry.
		assert.deepEqual(cardTitles(filterTree(all, 'aws::dynamodb', '/blocks').sections), ['API']);
	});

	it('matches a framework group by its construct path', () => {
		assert.deepEqual(cardTitles(filterTree(all, 'api', '/blocks').sections), ['API']);
	});

	it('requires EVERY term, because an OR search over a long inventory returns everything', () => {
		assert.deepEqual(cardTitles(filterTree(all, 'kvstore cache', '/blocks').sections), ['KVStore']);
		assert.deepEqual(cardTitles(filterTree(all, 'kvstore nothingmatchesthis', '/blocks').sections), []);
	});

	it('narrows a section heading to what it is actually showing', () => {
		// A heading reading "13 blocks" above two filtered cards is a false
		// statement about the list under it.
		const result = filterTree(all, 'kvstore', '/blocks');
		assert.equal(result.sections[0]?.summary, '1 of 2 blocks');
	});

	it('leaves the heading alone when the filter removed nothing from that section', () => {
		const result = filterTree(all, 'my-app', '/blocks');
		const auth = result.sections.find((s) => s.id === 'auth');
		assert.equal(auth?.summary, '1 block');
	});

	it('drops a section that loses every card rather than rendering it empty', () => {
		const result = filterTree(all, 'kvstore', '/blocks');
		assert.deepEqual(
			result.sections.map((s) => s.id),
			['data'],
		);
	});

	it('counts what it hid', () => {
		// 4 cards total, 1 matches.
		assert.equal(filterTree(all, 'kvstore', '/blocks').hidden, 3);
	});

	it('counts matches separately from what is shown', () => {
		// The retained active card is shown but did not match, so "shown" alone
		// cannot tell one hit from no hits — which is the difference between
		// "3 hidden" and "nothing matches".
		const result = filterTree(all, 'zzzznope', '/blocks/my-app-auth');
		assert.equal(result.matched, 0);
		assert.equal(result.keptActive, true);
		assert.equal(result.sections.flatMap((s) => s.cards).length, 1);
	});

	it('counts every card that matched, so a hit is never reported as no hits', () => {
		// Without this, `matched` could be pinned at 0 and the nav would say
		// "Nothing matches" over a list of results — and every other assertion here
		// would still pass. Found by mutation testing.
		assert.equal(filterTree(all, 'kvstore', '/blocks').matched, 1);
		assert.equal(filterTree(all, 'my-app', '/blocks').matched, 3);
	});

	it('reports a blank query as zero matches and zero hidden', () => {
		const result = filterTree(all, '', '/blocks');
		assert.equal(result.matched, 0);
		assert.equal(result.hidden, 0);
	});

	it('KEEPS the card for the page you have open even when it does not match', () => {
		// Dropping it would make the nav lose the page you are on, which is the
		// same defect as a collapsed section hiding it.
		const result = filterTree(all, 'kvstore', '/blocks/my-app-auth');
		assert.deepEqual(cardTitles(result.sections).sort(), ['AuthBasic', 'KVStore']);
		assert.equal(result.keptActive, true);
	});

	it('does not claim to have kept the active card when it matched on its own', () => {
		const result = filterTree(all, 'kvstore', '/blocks/my-app-cache');
		assert.equal(result.keptActive, false);
	});

	it('finds nothing for a query nothing matches, and says so with a count', () => {
		const result = filterTree(all, 'zzzznope', '/blocks');
		assert.deepEqual(result.sections, []);
		assert.equal(result.hidden, 4);
	});

	it('does not mutate the sections it was given', () => {
		const before = all.map((s) => s.cards.length);
		filterTree(all, 'kvstore', '/blocks');
		assert.deepEqual(
			all.map((s) => s.cards.length),
			before,
		);
	});
});

describe('isSectionActive', () => {
	const tree = buildInventoryTree({
		blocks: blocksResponse({ blocks: [block()] }),
		resources: loaded([
			group({ id: 'API', category: 'platform' }),
			group({ id: 'CDK internals', category: 'cdk' }),
		]),
	});
	const platform = section(tree, 'platform');
	const data = section(tree, 'data');

	it('is true for the collapsed section holding the open page', () => {
		assert.ok(platform);
		assert.equal(isSectionActive(platform, '/resources/API'), true);
	});

	it('matches through an encoded id, like the id with a space in it', () => {
		const cdk = section(tree, 'cdk');
		assert.ok(cdk);
		assert.equal(isSectionActive(cdk, '/resources/CDK%20internals'), true);
		assert.equal(isSectionActive(cdk, '/resources/CDK internals'), true);
	});

	it('is false for a section that holds nothing open', () => {
		assert.ok(data);
		assert.equal(isSectionActive(data, '/resources/API'), false);
	});

	it('is false on an index page, where no card is open', () => {
		assert.ok(platform);
		assert.equal(isSectionActive(platform, '/resources'), false);
	});
});

describe('isCardActive', () => {
	const card = blockCard(block(), [], 'unknown');
	const groupNavCard = buildInventoryTree({
		blocks: blocksResponse(),
		resources: loaded([group({ id: 'my-app/orphan' })]),
	}).sections[0]?.cards[0];

	it('matches the encoded pathname a link produces', () => {
		assert.equal(isCardActive(card, '/blocks/my-app-todos'), true);
	});

	it('matches a DECODED pathname for an id that had to be encoded', () => {
		// The failure this prevents: `/resources/my-app%2Forphan` and
		// `/resources/my-app/orphan` are the same page, and comparing one spelling
		// against the other just stops highlighting anything — silently.
		assert.ok(groupNavCard);
		assert.equal(isCardActive(groupNavCard, '/resources/my-app%2Forphan'), true);
		assert.equal(isCardActive(groupNavCard, '/resources/my-app/orphan'), true);
	});

	it('does not match a different block', () => {
		assert.equal(isCardActive(card, '/blocks/my-app-other'), false);
	});

	it('does not match the index page it lives on', () => {
		assert.equal(isCardActive(card, '/blocks'), false);
	});

	it('does not match the same id under the other section', () => {
		assert.equal(isCardActive(card, '/resources/my-app-todos'), false);
	});

	it('is never active for a card with nothing to open', () => {
		assert.equal(isCardActive({ ...card, href: undefined }, '/blocks/my-app-todos'), false);
	});
});

// ─── The tree, and every way the inputs can be missing ───────────────────────

describe('buildInventoryTree — the happy path', () => {
	const tree = buildInventoryTree({
		blocks: blocksResponse({
			blocks: [
				block(),
				block({ type: 'AuthBasic', id: 'auth', fullId: 'my-app-auth', category: 'auth' }),
				block({ type: 'ApiNamespace', id: 'api', fullId: 'my-app-api', category: 'core' }),
			],
		}),
		resources: loaded([
			group({ id: 'my-app/todos', blockFullId: 'my-app-todos', blockType: 'DistributedTable' }),
			group({ id: 'API', category: 'platform', resources: [resource({ typeLabel: 'Lambda Function' })] }),
			group({ id: 'CDK internals', category: 'cdk' }),
		]),
	});

	it('orders sections by the fixed category order, then framework internals last', () => {
		assert.deepEqual(
			tree.sections.map((s) => s.id),
			['core', 'auth', 'data', 'platform', 'cdk'],
		);
	});

	it('opens your own blocks and leaves framework internals closed', () => {
		assert.equal(section(tree, 'data')?.defaultCollapsed, false);
		assert.equal(section(tree, 'platform')?.defaultCollapsed, true);
		assert.equal(section(tree, 'cdk')?.defaultCollapsed, true);
	});

	it('makes only the deployed-group sections foldable', () => {
		// A category heading is a label, not a control: every block you declared is
		// somewhere you might navigate to, so a chevron that only removes content
		// has no useful state to offer.
		assert.equal(section(tree, 'core')?.collapsible, false);
		assert.equal(section(tree, 'auth')?.collapsible, false);
		assert.equal(section(tree, 'data')?.collapsible, false);
		assert.equal(section(tree, 'platform')?.collapsible, true);
		assert.equal(section(tree, 'cdk')?.collapsible, true);
	});

	it('counts each section', () => {
		assert.equal(section(tree, 'data')?.summary, '1 block');
		// Groups AND resources: neither answers the question alone.
		assert.equal(section(tree, 'platform')?.summary, '1 group · 1 resource');
	});

	it('reports the deployed block as deployed and the API namespace as owning nothing', () => {
		assert.equal(section(tree, 'data')?.cards[0]?.tags.at(-1)?.label, 'deployed');
		assert.equal(section(tree, 'core')?.cards[0]?.tags.at(-1)?.title, UNMATCHED_BADGE_TITLE['no-own-resources']);
	});

	it('points a framework card at its own group page', () => {
		assert.equal(section(tree, 'platform')?.cards[0]?.href, '/resources/API');
	});

	it('reports resources as available', () => {
		assert.equal(tree.resourcesUnavailable, false);
		assert.equal(tree.totalBlocks, 3);
	});
});

describe('buildInventoryTree — the local environment has nothing to read, which is not a failure', () => {
	const blocks = blocksResponse({ blocks: [block()] });
	const tree = buildInventoryTree({ blocks, resources: { state: 'not-applicable' } });

	it('still lists every declared block, because the scan is source-derived', () => {
		assert.equal(section(tree, 'data')?.cards.length, 1);
		assert.equal(tree.totalBlocks, 1);
	});

	it('does NOT claim the resources could not be read', () => {
		// The distinction the whole state exists for: "could not be read" invites a
		// fix (credentials, a region) that does not apply, and describes an attempt
		// that never happened.
		assert.equal(tree.resourcesUnavailable, false);
		assert.equal(tree.resourcesNotApplicable, true);
	});

	it('explains the nav\u2019s own absence without sending the reader to the page they are on', () => {
		// The nav footer used to borrow the Resources PILLAR's sentence, which ends
		// "or open Blocks to see what your app declares" -- and the nav renders on
		// the Blocks page, so it instructed the reader to open the page they were
		// already on. This sentence is scoped to what the nav lost.
		assert.doesNotMatch(NAV_RESOURCES_NOT_APPLICABLE, /open Blocks/i);
		assert.notEqual(NAV_RESOURCES_NOT_APPLICABLE, localNotApplicableReason('resources'));
		// It must still name what is missing, or the absence reads as an empty stack.
		assert.match(NAV_RESOURCES_NOT_APPLICABLE, /framework sections/i);
		assert.match(NAV_RESOURCES_NOT_APPLICABLE, /absent here rather than empty/i);
	});

	it('keeps the two flags mutually exclusive across every state', () => {
		const states: ResourcesState[] = [
			{ state: 'pending' },
			{ state: 'error' },
			{ state: 'not-applicable' },
			{ state: 'loaded', response: resourcesResponse({ resourcesSource: 'unavailable' }) },
			{ state: 'loaded', response: resourcesResponse({}) },
		];
		for (const resources of states) {
			const built = buildInventoryTree({ blocks, resources });
			assert.equal(
				built.resourcesUnavailable && built.resourcesNotApplicable,
				false,
				`${resources.state} claimed both`,
			);
		}
	});

	it('tags each block "not applicable" rather than "declared only"', () => {
		const tag = section(tree, 'data')?.cards[0]?.tags.at(-1);
		assert.equal(tag?.label, 'not applicable');
		assert.equal(tag?.title, UNMATCHED_BADGE_TITLE['not-applicable']);
	});

	it('omits the framework sections, which exist only because a stack was read', () => {
		assert.equal(section(tree, 'platform'), undefined);
		assert.equal(section(tree, 'cdk'), undefined);
	});
});

describe('buildInventoryTree — resources unavailable must not cost you the nav', () => {
	const blocks = blocksResponse({ blocks: [block()] });

	for (const [name, resources] of [
		['pending', { state: 'pending' }],
		['failed', { state: 'error' }],
		[
			'a 200 that could not read CloudFormation',
			{ state: 'loaded', response: resourcesResponse({ resourcesSource: 'unavailable' }) },
		],
	] as [string, ResourcesState][]) {
		it(`still lists every block when resources are ${name}`, () => {
			const tree = buildInventoryTree({ blocks, resources });
			assert.equal(section(tree, 'data')?.cards.length, 1);
			assert.equal(tree.totalBlocks, 1);
			assert.equal(tree.resourcesUnavailable, true);
		});

		it(`says the deployment state is unknown rather than guessing, when resources are ${name}`, () => {
			const tree = buildInventoryTree({ blocks, resources });
			assert.equal(section(tree, 'data')?.cards[0]?.tags.at(-1)?.title, UNMATCHED_BADGE_TITLE.unknown);
		});
	}

	it('adds no framework sections when there are no groups to put in them', () => {
		const tree = buildInventoryTree({ blocks, resources: { state: 'error' } });
		assert.deepEqual(
			tree.sections.map((s) => s.id),
			['data'],
		);
	});
});

describe('buildInventoryTree — blocks unavailable', () => {
	it('produces no block sections but still reaches the deployed resources', () => {
		// The inverse degradation: the source scan failed, CloudFormation is fine.
		// Every app group is unmatched, so the nav must not lose them.
		const tree = buildInventoryTree({
			blocks: blocksResponse({
				blocksSource: 'unavailable',
				blocksErrorCode: 'NOT_A_BLOCKS_PROJECT',
				blocks: [],
			}),
			resources: loaded([group({ id: 'my-app/todos' }), group({ id: 'API', category: 'platform' })]),
		});
		assert.deepEqual(
			tree.sections.map((s) => s.id),
			['unattributed', 'platform'],
		);
		assert.equal(tree.totalBlocks, 0);
	});

	it('does not call a group "not declared" when no declarations were read', () => {
		const tree = buildInventoryTree({
			blocks: blocksResponse({ blocksSource: 'unavailable', blocks: [] }),
			resources: loaded([group({ id: 'my-app/todos' })]),
		});
		const unattributed = section(tree, 'unattributed');
		assert.equal(unattributed?.label, 'Deployed resources');
		assert.match(String(unattributed?.description), /could not be read/);
	});

	it('handles the blocks response being absent entirely', () => {
		const tree = buildInventoryTree({ blocks: undefined, resources: { state: 'pending' } });
		assert.deepEqual(tree.sections, []);
		assert.equal(tree.totalBlocks, 0);
		assert.equal(tree.unknownCount, 0);
	});
});

describe('buildInventoryTree — a deployed group that matches no block', () => {
	const tree = buildInventoryTree({
		blocks: blocksResponse({ blocks: [block()] }),
		resources: loaded([
			group({ id: 'my-app/todos', blockFullId: 'my-app-todos' }),
			group({ id: 'my-app/removed' }),
		]),
	});

	it('keeps it reachable instead of dropping it', () => {
		// Once Resources stops being its own page, a group that reaches no block
		// reaches nothing — its resources would silently disappear.
		assert.equal(section(tree, 'unattributed')?.cards[0]?.title, 'my-app/removed');
	});

	it('names the likely cause, since the stack WAS read', () => {
		assert.equal(section(tree, 'unattributed')?.label, 'Deployed but not declared');
		assert.match(String(section(tree, 'unattributed')?.description), /removed without a deploy/);
	});

	it('does not hide it behind a collapsed section, because it is a finding', () => {
		assert.equal(section(tree, 'unattributed')?.defaultCollapsed, false);
	});

	it('is still foldable, being a list of deployed groups rather than your blocks', () => {
		assert.equal(section(tree, 'unattributed')?.collapsible, true);
	});

	it('leaves the matched group out of it', () => {
		assert.equal(section(tree, 'unattributed')?.cards.length, 1);
	});
});

describe('buildInventoryTree — blocks with nothing deployed', () => {
	const tree = buildInventoryTree({ blocks: blocksResponse({ blocks: [block()] }), resources: loaded([]) });

	it('says nothing is deployed rather than that the block is missing from the stack', () => {
		assert.equal(section(tree, 'data')?.cards[0]?.tags.at(-1)?.title, UNMATCHED_BADGE_TITLE['not-deployed']);
	});

	it('reports resources as available, because the stack was read successfully', () => {
		assert.equal(tree.resourcesUnavailable, false);
	});
});

describe('buildInventoryTree — unrecognised things', () => {
	it('places a block whose category is unknown in the last section', () => {
		const tree = buildInventoryTree({
			blocks: blocksResponse({ blocks: [block({ category: 'unknown' }), block()] }),
			resources: { state: 'pending' },
		});
		assert.deepEqual(
			tree.sections.map((s) => s.id),
			['data', 'unknown'],
		);
		assert.equal(section(tree, 'unknown')?.label, 'Unrecognised type');
	});

	it('counts unresolved constructs without making them cards', () => {
		// There is no page to open for one, and a nav item that cannot be clicked
		// is worse than a count beside a link to the index that explains it.
		const tree = buildInventoryTree({
			blocks: blocksResponse({
				blocks: [],
				unknownConstructs: [
					{ text: 'blocks.Mystery', file: 'aws-blocks/index.ts', line: 9, reason: 'unknown-type' },
				],
			}),
			resources: { state: 'pending' },
		});
		assert.equal(tree.unknownCount, 1);
		assert.deepEqual(tree.sections, []);
	});

	it('never invents a section for a category with no blocks', () => {
		const tree = buildInventoryTree({
			blocks: blocksResponse({ blocks: [block()] }),
			resources: { state: 'pending' },
		});
		assert.equal(tree.sections.length, 1);
	});
});

describe('buildInventoryTree — every card is renderable', () => {
	it('gives every card a non-empty title and a unique key', () => {
		const tree = buildInventoryTree({
			blocks: blocksResponse({
				blocks: CATEGORY_ORDER.map((category, index) =>
					block({ category, id: `b${index}`, fullId: `my-app-b${index}`, line: index }),
				),
			}),
			resources: loaded([group({ id: 'API', category: 'platform' }), group({ id: 'orphan' })]),
		});
		const cards = tree.sections.flatMap((s) => s.cards);
		assert.equal(cards.length, CATEGORY_ORDER.length + 2);
		for (const card of cards) assert.ok(card.title.length > 0, JSON.stringify(card));
		assert.equal(new Set(cards.map((card) => card.key)).size, cards.length);
	});
});
