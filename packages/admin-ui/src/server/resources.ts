// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import type { DiscoveredBlock, ResourceGroup, ResourceInfo } from '../contract/v1.js';
import { awsClientConfig } from './aws-config.js';
import { consoleLink, friendlyType } from './console-links.js';
import type { RawStackResource } from './log-groups.js';

/**
 * Resource inventory (M3): CloudFormation knows WHAT deployed; the CDK
 * construct paths in the template's `aws:cdk:path` metadata know WHY —
 * which block owns each resource. Joining the two gives a block-grouped
 * inventory with zero core changes and zero naming heuristics on ids.
 *
 * Grouping heuristic on the path's first segment (after the stack name):
 * - the app scope (contains further segments like `my-app/auth/users`)
 *   → grouped per BLOCK path (first two segments), category 'app'
 * - platform constructs (KitStack internals: Kit*, API, Handler, Stack*)
 *   → grouped per construct, category 'platform'
 * - CDK bookkeeping (Custom::*, CDKMetadata) → category 'cdk'
 */

/** Extended raw resource including status (ListStackResources has it). */
export interface RawStackResourceWithStatus extends RawStackResource {
	ResourceStatus?: string;
}

/**
 * The deployed CloudFormation template, as the parts of this package that read
 * it consume them.
 *
 * One shape for one document, deliberately, even though no single caller reads
 * every field: this module reads `Metadata['aws:cdk:path']` for construct
 * grouping, and `metric-targets.ts` reads `Type` and `Properties.Name` to
 * resolve a REST API's metric dimension. Two narrower interfaces were tried and
 * are a trap, because a value of the Metadata-only shape is NOT assignable to
 * the richer one. The two connect only through TypeScript's weak-type rule
 * (they happen to share `Metadata`), so the compiler accepts some conversions
 * and rejects others for reasons that have nothing to do with the template.
 */
export interface RawTemplate {
	Resources?: Record<
		string,
		{
			Type?: string;
			/** Unknown-valued: a property is a literal or a CloudFormation intrinsic. */
			Properties?: Record<string, unknown>;
			Metadata?: Record<string, unknown>;
		}
	>;
}

const CDK_BOOKKEEPING = /^(Custom::|CDKMetadata)/;

/** Top-level constructs the foundation itself owns, so never the app scope. */
const PLATFORM_CONSTRUCT = /^(Kit|Blocks|API$|Handler$|Stack)/;

/** Extracts logicalId → cdk path (stack-name segment stripped) from a template. */
export function templateCdkPaths(template: RawTemplate): Map<string, string> {
	const paths = new Map<string, string>();
	for (const [logicalId, resource] of Object.entries(template.Resources ?? {})) {
		const path = resource.Metadata?.['aws:cdk:path'];
		if (typeof path === 'string' && path.length > 0) {
			paths.set(logicalId, path.split('/').slice(1).join('/'));
		}
	}
	return paths;
}

/** Optional enrichment inputs for {@link groupResources}. */
export interface GroupResourcesOptions {
	/** Foundation root construct id, whose children are the user's blocks. */
	appScope?: string;
	/** Deployed stack name — the fallback console target for types with no page of their own. */
	stackName?: string;
	/** Region the stack actually lives in. Omit when it could not be resolved. */
	region?: string;
	/** Source-discovered blocks, used ONLY to label groups (see the attribution rule below). */
	blocks?: DiscoveredBlock[];
}

/**
 * Joins stack resources with their cdk paths and groups them by owning
 * construct. `options.appScope` is the foundation's root construct id (the
 * Scope name, e.g. "my-app") — its children are the user's blocks.
 *
 * THE ATTRIBUTION RULE: grouping comes from the DEPLOYED template's CDK
 * construct paths, and nothing else. `options.blocks` (discovered by parsing
 * the app's source) only supplies the LABEL for a group that the template
 * already produced. A block is never allowed to create a group, because
 * declared is not deployed: a block written as
 * `if (!sandboxMode) new Hosting(scope, 'site', …)` exists in the source of
 * every stage, but must not appear in a sandbox stage's resource list.
 */
export function groupResources(
	resources: RawStackResourceWithStatus[],
	cdkPaths: Map<string, string>,
	options: GroupResourcesOptions = {},
): ResourceGroup[] {
	const { appScope, stackName, region, blocks } = options;
	const groups = new Map<string, ResourceGroup>();

	for (const raw of resources) {
		if (!raw.LogicalResourceId || !raw.ResourceType) continue;
		const cdkPath = cdkPaths.get(raw.LogicalResourceId);
		// A console URL is only correct in the region the resource is in. With no
		// region resolved we emit NO link rather than guessing: the wrong region
		// opens a console page that renders empty, which reads as "the resource is
		// gone" — the confident-link-to-nothing failure console-links exists to
		// avoid. No link at all is honest; a wrong link is a bug report.
		const link = region ? consoleLink(raw.ResourceType, raw.PhysicalResourceId, stackName, region) : undefined;
		const info: ResourceInfo = {
			logicalResourceId: raw.LogicalResourceId,
			resourceType: raw.ResourceType,
			...(raw.PhysicalResourceId ? { physicalResourceId: raw.PhysicalResourceId } : {}),
			...(raw.ResourceStatus ? { resourceStatus: raw.ResourceStatus } : {}),
			...(cdkPath ? { cdkPath } : {}),
			typeLabel: friendlyType(raw.ResourceType),
			...(link ? { consoleUrl: link.url, directLink: link.direct } : {}),
		};

		const { id, category } = classify(cdkPath, raw.LogicalResourceId, appScope);
		const group = groups.get(id) ?? { id, category, resources: [] };
		group.resources.push(info);
		groups.set(id, group);
	}

	// Labelling pass. It runs over groups that already exist — it can only add
	// two fields to a deployed group, never add a group.
	if (blocks && blocks.length > 0) {
		for (const group of groups.values()) {
			const block = matchBlock(group, blocks);
			if (!block) continue;
			group.blockFullId = block.fullId;
			group.blockType = block.type;
		}
	}

	// App blocks first, then platform, then cdk bookkeeping; alphabetical within.
	const order: Record<ResourceGroup['category'], number> = { app: 0, platform: 1, cdk: 2 };
	return [...groups.values()].sort((a, b) => order[a.category] - order[b.category] || a.id.localeCompare(b.id));
}

/**
 * Finds the discovered block a group's construct path names, or undefined.
 *
 * Only 'app' groups are considered. A block is by construction a child of the
 * app scope, so an app group is the only group a block can own — and matching
 * platform groups too would actively mislabel: an `ApiNamespace` block with id
 * `api` would otherwise claim the Blocks-owned `API` construct group.
 */
function matchBlock(group: ResourceGroup, blocks: DiscoveredBlock[]): DiscoveredBlock | undefined {
	if (group.category !== 'app') return undefined;
	const segments = group.id.split('/').map((segment) => segment.toLowerCase());
	return blocks.find((block) =>
		[block.id, block.fullId]
			.filter((candidate): candidate is string => typeof candidate === 'string' && candidate.length > 0)
			.some((candidate) => segments.includes(candidate.toLowerCase())),
	);
}

function classify(
	cdkPath: string | undefined,
	logicalId: string,
	appScope?: string,
): { id: string; category: ResourceGroup['category'] } {
	if (!cdkPath) {
		return CDK_BOOKKEEPING.test(logicalId)
			? { id: 'CDK internals', category: 'cdk' }
			: { id: '(no construct path)', category: 'platform' };
	}
	const segments = cdkPath.split('/');
	const top = segments[0];
	if (CDK_BOOKKEEPING.test(top)) return { id: 'CDK internals', category: 'cdk' };
	if (appScope && top === appScope) {
		// Block path: scope + block id (e.g. "my-app/auth"). Deeper nesting
		// stays with its block.
		return { id: segments.slice(0, 2).join('/'), category: 'app' };
	}
	return { id: top, category: 'platform' };
}

/**
 * The app scope: the top-level construct whose children are the user's blocks.
 *
 * Source discovery NAMES the scope — `new Scope(this, 'rota')` is parsed out of
 * `aws-blocks/` and reported as `ScopeInfo` — so when that name is present
 * among the deployed template's top-level constructs, it IS the scope and no
 * inference is needed. {@link inferAppScope} is the fallback for the two cases
 * discovery cannot answer: it failed, or it names a scope this stack does not
 * contain (the scope was renamed since the stack was deployed).
 *
 * Preferring the named scope is what makes a production stack group correctly.
 * The heuristic requires the app to be the ONLY top-level construct nesting
 * three deep, and `Hosting` breaks that tie in every production stack, which
 * silently dropped every block group to 'platform' and left the data view
 * reporting deployed blocks as absent.
 *
 * This does not weaken the attribution rule on {@link groupResources}: the scope
 * only says WHERE the block boundary in a path is, and every group still comes
 * from the deployed template alone. A block that is declared but not deployed
 * still cannot produce a group.
 */
export function resolveAppScope(cdkPaths: Map<string, string>, discoveredScopeId?: string): string | undefined {
	if (discoveredScopeId && hasTopLevelConstruct(cdkPaths, discoveredScopeId)) return discoveredScopeId;
	return inferAppScope(cdkPaths);
}

/** Whether `id` is a top-level construct with children in the deployed template. */
function hasTopLevelConstruct(cdkPaths: Map<string, string>, id: string): boolean {
	for (const path of cdkPaths.values()) {
		const segments = path.split('/');
		if (segments.length >= 2 && segments[0] === id) return true;
	}
	return false;
}

/**
 * Guesses the app scope from construct paths alone: the top-level construct that
 * has nested descendants more than two levels deep and is not a known platform
 * prefix. With one candidate that's the scope; otherwise undefined.
 *
 * Undefined is not a soft failure. Grouping still renders, but every block
 * resource collapses into one 'platform' group keyed on the first path segment,
 * and because `matchBlock` only labels 'app' groups, no group is attributed to a
 * block at all. Prefer {@link resolveAppScope}, which only reaches this when
 * discovery cannot name the scope.
 *
 * Platform prefixes cover both current (`Blocks*`) and legacy (`Kit*`)
 * construct names — stacks deployed with pre-rename packages are still
 * out there and must group identically.
 */
export function inferAppScope(cdkPaths: Map<string, string>): string | undefined {
	const candidates = new Set<string>();
	for (const path of cdkPaths.values()) {
		const segments = path.split('/');
		if (segments.length >= 4 && !CDK_BOOKKEEPING.test(segments[0]) && !PLATFORM_CONSTRUCT.test(segments[0])) {
			candidates.add(segments[0]);
		}
	}
	return candidates.size === 1 ? [...candidates][0] : undefined;
}

/** Fetches and parses the deployed stack template. Throws on AWS errors. */
export async function fetchStackTemplate(stackName: string, region?: string): Promise<RawTemplate> {
	const { CloudFormationClient, GetTemplateCommand } = await import('@aws-sdk/client-cloudformation');
	const client = new CloudFormationClient(awsClientConfig(region));
	const result = await client.send(new GetTemplateCommand({ StackName: stackName }));
	return result.TemplateBody ? (JSON.parse(result.TemplateBody) as RawTemplate) : {};
}
