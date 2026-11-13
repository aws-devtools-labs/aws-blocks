// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

'use client';

import { useQuery } from '@tanstack/react-query';
import { ChevronDown, ChevronRight } from 'lucide-react';
import Link from 'next/link';
import { Fragment, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useEnvironment } from '@/components/environment-context';
import { TONE_VARIANT } from '@/components/nav-tone';
import type { ApiMethod, BlocksResponse, DiscoveredBlock, ResourcesResponse, UnknownConstruct } from '@/contract/v1';
import { apiGet } from '@/lib/api-client';
import {
	CATEGORY_LABEL,
	CATEGORY_ORDER,
	UNMATCHED_BADGE_TITLE,
	deploymentTag,
	groupsByBlock,
	reasonForBlock,
	resourceGroupHref,
	stageUnmatchedReason,
} from '@/nav/inventory-tree';
import type { ResourcesState, UnmatchedReason } from '@/nav/inventory-tree';

const UNKNOWN_REASON_LABEL: Record<UnknownConstruct['reason'], string> = {
	'unknown-type': 'not a block type the dashboard knows',
	'non-literal-id': 'id is not a string literal, so it cannot be resolved statically',
	'aliased-import': 'imported under an alias the scanner could not follow',
};

/** `name(param, param)` — types, when known, ride along as the title attribute. */
function methodSignature(method: ApiMethod): string {
	const params = method.params.map((param) => `${param.name}${param.optional ? '?' : ''}`).join(', ');
	return `${method.name}(${params})`;
}

function methodTypes(method: ApiMethod): string {
	const params = method.params
		.map((param) => `${param.name}${param.optional ? '?' : ''}${param.type ? `: ${param.type}` : ''}`)
		.join(', ');
	return `${method.name}(${params})`;
}

/*
 * The category order and labels, the four-way `UnmatchedReason`, its badge
 * titles and `TYPES_WITHOUT_OWN_RESOURCES` all used to be declared here. They
 * now live in `src/nav/inventory-tree.ts` and are imported above, because the
 * second-level nav needs exactly the same answers: a second copy is how this
 * page and the nav would end up disagreeing about whether a block is deployed.
 * The move also puts them somewhere the test runner can reach — nothing under
 * `app/` is compiled into `dist`, so none of this was unit-testable here.
 */

function BlockCard({
	block,
	deployedIn,
	unmatchedReason,
	stage,
}: {
	block: DiscoveredBlock;
	deployedIn: string[];
	unmatchedReason: UnmatchedReason;
	/**
	 * The deployed stage, or `undefined` in the local environment.
	 *
	 * Every sentence below that interpolates it sits behind a reason only a real
	 * read can produce (`not-deployed`, `unmatched`, `no-own-resources`), so it is
	 * never rendered while undefined — the local case is caught first, off the
	 * reason itself rather than off this prop.
	 */
	stage: string | undefined;
}) {
	const [configOpen, setConfigOpen] = useState(false);
	const deployed = deployedIn.length > 0;
	const reason: UnmatchedReason = reasonForBlock(block.type, unmatchedReason);
	// One source of truth for "we never looked": the reason the shared model
	// derived, not a second inference from the stage being absent.
	const notApplicable = reason === 'not-applicable';
	const deployTag = deploymentTag(deployed, reason, deployedIn);
	const Chevron = configOpen ? ChevronDown : ChevronRight;
	const detailHref = `/blocks/${encodeURIComponent(block.fullId)}`;

	return (
		<Card>
			<CardHeader className="py-4">
				<div className="flex flex-wrap items-center gap-3">
					<CardTitle className="font-mono text-sm">
						<Link href={detailHref} className="transition-colors hover:text-brand hover:underline">
							{block.type}
						</Link>
					</CardTitle>
					<Badge variant="outline">{block.id}</Badge>
					{/*
					 * The model's tag, not a second copy of it. This page previously
					 * hand-wrote all three cases and drifted from the nav on two of
					 * them — a neutral badge where the nav showed `warn`, and the
					 * pillar-level local sentence in place of the per-block one.
					 */}
					<Badge variant={TONE_VARIANT[deployTag.tone]} title={deployTag.title}>
						{deployTag.label}
					</Badge>
					<Link
						href={detailHref}
						title={`Open ${block.fullId} — browse its records, stores and key schema`}
						className="ml-auto whitespace-nowrap text-xs text-fg-soft transition-colors hover:text-fg hover:underline"
					>
						Browse data →
					</Link>
				</div>
				<CardDescription className="font-mono text-xs">
					{block.fullId} · {block.file}:{block.line}
				</CardDescription>
			</CardHeader>
			<CardContent className="space-y-3 text-[13px]">
				{block.keySchema && (
					<div className="flex flex-wrap items-baseline gap-x-6 gap-y-1">
						<span className="text-fg-soft">Key schema</span>
						<span className="font-mono text-xs">
							partition <span className="text-fg">{block.keySchema.partitionKey}</span>
							{block.keySchema.sortKey ? (
								<>
									{' · '}sort <span className="text-fg">{block.keySchema.sortKey}</span>
								</>
							) : (
								<span className="text-fg-dim"> · no sort key</span>
							)}
						</span>
					</div>
				)}

				{block.methods && block.methods.length > 0 && (
					<div className="space-y-1">
						<span className="text-fg-soft">
							{block.methods.length} method{block.methods.length === 1 ? '' : 's'}
						</span>
						<div className="flex flex-wrap gap-1.5">
							{block.methods.map((method) => (
								<code
									key={method.name}
									title={methodTypes(method)}
									className="rounded border border-line bg-hover px-1.5 py-0.5 font-mono text-xs"
								>
									{methodSignature(method)}
								</code>
							))}
						</div>
					</div>
				)}

				{notApplicable ? (
					// The PER-BLOCK sentence, not the pillar-level one. This card is
					// about one block's attribution, and the pillar sentence ends
					// "…or open Blocks to see what your app declares" — an instruction
					// to open the page the reader is already on.
					<p className="text-xs text-fg-dim">{UNMATCHED_BADGE_TITLE['not-applicable']}</p>
				) : deployed ? (
					<p className="text-xs text-fg-soft">
						Deployed as{' '}
						{/* Each group now has a page of its own, so the name links to the
						    group rather than to the whole-stack list. */}
						{deployedIn.map((groupId, index) => (
							<Fragment key={groupId}>
								{index > 0 && ', '}
								<Link href={resourceGroupHref(groupId)} className="font-mono hover:text-fg hover:underline">
									{groupId}
								</Link>
							</Fragment>
						))}{' '}
						in the selected stage.
					</p>
				) : (
					<p className={reason === 'unmatched' ? 'text-xs text-warn-fg' : 'text-xs text-fg-dim'}>
						{reason === 'no-own-resources' &&
							`An ${block.type} owns no resources of its own — its methods are served by the shared Blocks API group, so it is never matched to a block-specific group. This says nothing about whether ${stage} is deployed.`}
						{reason === 'not-deployed' &&
							`Declared in source. Nothing is deployed for ${stage}, so there is no resource group to match it to yet.`}
						{reason === 'unmatched' &&
							`Declared in source but NOT present in the deployed ${stage} stack — most often a block added since the last deploy. Deploy ${stage} to create its resources.`}
						{reason === 'unknown' &&
							'Declared in source. The deployed resources could not be read, so whether this block is deployed is unknown.'}
					</p>
				)}

				{block.configPreview && (
					<div className="space-y-1.5">
						<button
							type="button"
							onClick={() => setConfigOpen((open) => !open)}
							aria-expanded={configOpen}
							className="flex items-center gap-1.5 text-xs text-fg-soft transition-colors hover:text-fg"
						>
							<Chevron size={13} strokeWidth={2} className="text-fg-dim" />
							config
						</button>
						{configOpen && (
							<>
								<pre className="overflow-x-auto rounded-md border border-line bg-hover p-3 font-mono text-xs leading-relaxed text-fg-soft">
									{block.configPreview}
								</pre>
								<p className="text-xs text-fg-dim">
									Truncated source text copied verbatim from {block.file} — not necessarily valid TypeScript on its own.
								</p>
							</>
						)}
					</div>
				)}
			</CardContent>
		</Card>
	);
}

export default function BlocksPage() {
	const { cloudStage, ready } = useEnvironment();
	const isLocal = cloudStage === undefined;
	const { data, isLoading, error } = useQuery({
		queryKey: ['blocks'],
		queryFn: () => apiGet<BlocksResponse>('/api/v1/blocks'),
	});

	/**
	 * The deployed side of the picture, fetched separately and on purpose.
	 *
	 * `GET /api/v1/blocks` is a pure source scan: it needs no credentials and
	 * works with nothing deployed, which is what lets this page and the doctor
	 * function offline. Attribution to deployed resources lives in
	 * `GET /api/v1/resources`, which reads the deployed template — so the
	 * correlation happens HERE rather than by making the blocks endpoint depend
	 * on CloudFormation, where an expired credential would blank the whole
	 * inventory instead of just the deployment column.
	 */
	const resources = useQuery({
		queryKey: ['resources', cloudStage],
		queryFn: () => {
			// Unreachable in local: `enabled` holds this until a deployed stage is
			// selected. The guard narrows `cloudStage` without a cast.
			if (cloudStage === undefined) throw new Error('resources requested with no stage');
			return apiGet<ResourcesResponse>(`/api/v1/resources?stage=${encodeURIComponent(cloudStage)}`);
		},
		retry: false,
		// Cloud-only: never fetched in local, where there is no stack. The blocks
		// scan above is source-derived and must keep working locally, so only this
		// deployment-attribution request is gated.
		enabled: ready && cloudStage !== undefined,
	});

	const blocks = data?.blocks ?? [];
	const scanned = data?.blocksSource === 'source-scan';
	const unknownConstructs = data?.unknownConstructs ?? [];

	/** fullId → the deployed resource-group ids that carry that block's label. */
	const groupIdsByBlock = new Map<string, string[]>();
	for (const [fullId, matched] of groupsByBlock(resources.data?.groups ?? [])) {
		groupIdsByBlock.set(
			fullId,
			matched.map((group) => group.id),
		);
	}

	// Modelled explicitly so "still loading" and "failed" cannot collapse into
	// "nothing deployed" — the collapse the four-way reason exists to prevent.
	const resourcesState: ResourcesState = isLocal
		? // Never issued, so neither pending nor failed: the model turns this into a
			// `not-applicable` reason, which is what stops every card claiming a
			// deployment verdict that no read produced.
			{ state: 'not-applicable' }
		: resources.isPending
			? { state: 'pending' }
			: resources.isError || !resources.data
				? { state: 'error' }
				: { state: 'loaded', response: resources.data };
	const unmatchedReason: UnmatchedReason = stageUnmatchedReason(resourcesState);

	return (
		<div className="space-y-6">
			<div className="flex flex-wrap items-center gap-4">
				<h1 className="text-lg font-semibold tracking-tight">Blocks</h1>
				{scanned && (
					<span className="text-sm text-fg-soft">
						{blocks.length} block{blocks.length === 1 ? '' : 's'} declared in{' '}
						<code className="font-mono text-xs">{data?.projectName}</code>
						{data?.scope && (
							<>
								{' · scope '}
								<code className="font-mono text-xs">{data.scope.id}</code>
							</>
						)}
					</span>
				)}
			</div>

			{scanned && data?.scope && (
				<p className="text-xs text-fg-dim">
					Scope <code className="font-mono">{data.scope.id}</code> is declared at{' '}
					<code className="font-mono">
						{data.scope.file}:{data.scope.line}
					</code>
					. Every block id below is prefixed with it to form the <code className="font-mono">fullId</code>, which is how
					the deployed physical resources are named.
				</p>
			)}

			{isLoading && <p className="text-sm text-fg-soft">Loading blocks…</p>}

			{error && (
				<Card>
					<CardHeader>
						<CardTitle className="text-base">Cannot reach the Dashboard API</CardTitle>
						<CardDescription>
							Start the dashboard via <code>npm run dashboard</code> so the session token is set. ({String(error)})
						</CardDescription>
					</CardHeader>
				</Card>
			)}

			{data?.blocksSource === 'unavailable' && (
				<Card>
					<CardHeader>
						<CardTitle className="text-base">
							{data.blocksErrorCode === 'NOT_A_BLOCKS_PROJECT'
								? 'Not a Blocks project'
								: data.blocksErrorCode === 'PARSE_FAILED'
									? 'Could not parse the block declarations'
									: 'Blocks unavailable'}
						</CardTitle>
						<CardDescription>{data.blocksError}</CardDescription>
					</CardHeader>
					{data.blocksErrorCode === 'NOT_A_BLOCKS_PROJECT' && (
						<CardContent>
							<p className="text-[13px] text-fg-soft">
								The dashboard found no <code className="font-mono">aws-blocks/index.ts</code> under the project it was
								started from, so there is no declaration source to scan. Start the dashboard from your app directory, or
								pass the project root explicitly.
							</p>
						</CardContent>
					)}
				</Card>
			)}

			{scanned && blocks.length === 0 && (
				<Card>
					<CardHeader>
						<CardTitle className="text-base">No blocks found</CardTitle>
						<CardDescription>
							Nothing was declared in <code className="font-mono">aws-blocks/</code>.{' '}
							{data?.scannedFiles ?? 0} file{(data?.scannedFiles ?? 0) === 1 ? '' : 's'} parsed — a{' '}
							<code className="font-mono">new</code> block in a file outside{' '}
							<code className="font-mono">aws-blocks/</code> is not scanned.
						</CardDescription>
					</CardHeader>
				</Card>
			)}

			{CATEGORY_ORDER.map((category) => {
				const inCategory = blocks.filter((block) => block.category === category);
				if (inCategory.length === 0) return null;
				return (
					<section key={category} className="space-y-3">
						<h2 className="text-sm font-medium uppercase tracking-wide text-fg-soft">
							{CATEGORY_LABEL[category]}
							<span className="ml-2 font-normal normal-case tracking-normal text-fg-dim">
								{inCategory.length} block{inCategory.length === 1 ? '' : 's'}
							</span>
						</h2>
						{inCategory.map((block) => (
							<BlockCard
								key={`${block.file}:${block.line}:${block.fullId}`}
								block={block}
								deployedIn={groupIdsByBlock.get(block.fullId) ?? []}
								unmatchedReason={unmatchedReason}
								stage={cloudStage}
							/>
						))}
					</section>
				);
			})}

			{unknownConstructs.length > 0 && (
				<section className="space-y-3">
					<h2 className="text-sm font-medium uppercase tracking-wide text-fg-soft">
						Not recognised
						<span className="ml-2 font-normal normal-case tracking-normal text-fg-dim">
							{unknownConstructs.length} construct{unknownConstructs.length === 1 ? '' : 's'}
						</span>
					</h2>
					<Card>
						<CardHeader className="py-4">
							<CardTitle className="text-base">Constructs that look like blocks</CardTitle>
							<CardDescription>
								These are reported rather than skipped: each one is a{' '}
								<code className="font-mono">new X(scope, &apos;id&apos;)</code> in{' '}
								<code className="font-mono">aws-blocks/</code> that the dashboard could not resolve to a block it knows.
								A newly-added or third-party block type shows up here instead of vanishing.
							</CardDescription>
						</CardHeader>
						<CardContent className="p-0">
							<Table>
								<TableHeader>
									<TableRow>
										<TableHead scope="col">Construct</TableHead>
										<TableHead scope="col">Location</TableHead>
										<TableHead scope="col">Why</TableHead>
									</TableRow>
								</TableHeader>
								<TableBody>
									{unknownConstructs.map((construct) => (
										<TableRow key={`${construct.file}:${construct.line}:${construct.text}`}>
											<TableCell className="whitespace-nowrap font-mono text-xs">{construct.text}</TableCell>
											<TableCell className="font-mono text-xs text-fg-soft">
												{construct.file}:{construct.line}
											</TableCell>
											<TableCell className="text-xs">
												<Badge variant="outline">{construct.reason}</Badge>
												<span className="ml-2 text-fg-soft">{UNKNOWN_REASON_LABEL[construct.reason]}</span>
											</TableCell>
										</TableRow>
									))}
								</TableBody>
							</Table>
						</CardContent>
					</Card>
				</section>
			)}
		</div>
	);
}
