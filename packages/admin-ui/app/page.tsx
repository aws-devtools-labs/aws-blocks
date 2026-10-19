// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

'use client';

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useEnvironment } from '@/components/environment-context';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import type {
	DeploymentRecord,
	DeploymentStatus,
	DeploymentsResponse,
	EnvironmentInfo,
	EnvironmentsResponse,
	MetaResponse,
	ResourceGroup,
	ResourcesResponse,
} from '@/contract/v1';
import {
	CLOUD_ONLY_PILLARS,
	driftVariant,
	type EnvironmentCard as EnvironmentCardModel,
	type EnvironmentId,
	environmentCards,
	isLocalEnvironment,
	resourceSummaryState,
	selectedCard,
} from '@/env/environment';
import { apiGet } from '@/lib/api-client';

const DEPLOY_STATUS_VARIANT: Record<DeploymentStatus, 'success' | 'destructive' | 'warning' | 'outline'> = {
	SUCCEEDED: 'success',
	FAILED: 'destructive',
	ROLLED_BACK: 'warning',
	IN_PROGRESS: 'warning',
	UNKNOWN: 'outline',
};

function blocksSummary(groups: ResourceGroup[], category: ResourceGroup['category']): string {
	const matching = groups.filter((g) => g.category === category);
	const resources = matching.reduce((n, g) => n + g.resources.length, 0);
	return `${matching.length} block${matching.length === 1 ? '' : 's'} · ${resources} resource${resources === 1 ? '' : 's'}`;
}

/**
 * One environment, as a control.
 *
 * A `<button>` rather than a card with a button in it: the whole surface is the
 * target, and the same surface convention as the second-level nav (D68) is what
 * makes it read as tappable. An unselectable environment is `disabled` and
 * carries its reason, exactly as the header's pill does — a control that refuses
 * a click without saying why reads as broken.
 */
function EnvironmentChoice({ card, onSelect }: { card: EnvironmentCardModel; onSelect: (id: EnvironmentId) => void }) {
	const { status, info, selected, badge } = card;
	const selectable = status.selectable;
	return (
		<button
			type="button"
			onClick={() => onSelect(status.id)}
			disabled={!selectable}
			title={status.detail}
			aria-current={selected ? 'true' : undefined}
			className={`rounded-lg border p-4 text-left transition-colors ${
				selected ? 'border-brand/40 bg-active' : 'border-line bg-panel'
			} ${selectable ? 'hover:bg-hover' : 'cursor-not-allowed opacity-60'}`}
		>
			<div className="flex items-center gap-2">
				<span className="text-sm font-medium">{status.id}</span>
				<Badge variant={badge.variant}>{badge.label}</Badge>
				{selected && <span className="ml-auto text-xs text-fg-soft">selected</span>}
			</div>
			{/*
			 * A deployed stage has no `detail` — nothing is unresolved about it — so
			 * it shows what it is instead: the stack this dashboard would read.
			 */}
			<p className="mt-2 text-xs text-fg-soft">
				{status.detail ?? (
					<span className="font-mono">{info?.stackName ?? 'Deployed stack'}</span>
				)}
			</p>
		</button>
	);
}

/** What the local environment can and cannot answer, stated rather than implied. */
function LocalDetail({ detail, projectRoot }: { detail?: string; projectRoot?: string }) {
	return (
		<Card>
			<CardHeader>
				<CardTitle>local</CardTitle>
				{projectRoot && <CardDescription className="font-mono text-xs">{projectRoot}</CardDescription>}
			</CardHeader>
			<CardContent className="space-y-3 text-sm">
				{detail && <p className="text-fg-soft">{detail}</p>}
				<div className="flex flex-wrap gap-x-6 gap-y-2">
					<Link href="/blocks" className="hover:text-fg hover:underline">
						Browse local data →
					</Link>
					<Link href="/playground" className="hover:text-fg hover:underline">
						Call the dev server →
					</Link>
				</div>
				{/*
				 * Named here as well as on each page, because this is the page where the
				 * choice is made: a reader selecting local should learn what it costs
				 * before they land on four pages explaining themselves.
				 */}
				<p className="text-xs text-fg-dim">
					Not applicable in this environment: {CLOUD_ONLY_PILLARS.join(' · ')}. Each of those reads a deployed stack,
					which a local run does not create.
				</p>
			</CardContent>
		</Card>
	);
}

/**
 * The selected stage's stack.
 *
 * The state badge lives on the selector card above rather than being repeated
 * here; this panel is the detail the selection buys.
 */
function StageDetail({
	env,
	detail,
	projectRoot,
	latestDeploy,
	resourceGroups,
	resourcesFailure,
}: {
	env?: EnvironmentInfo;
	detail?: string;
	projectRoot?: string;
	latestDeploy?: DeploymentRecord;
	resourceGroups?: ResourceGroup[];
	/** Why there is no block summary, when the read FAILED rather than found none. */
	resourcesFailure?: string;
}) {
	const description = [env?.stackName, projectRoot].filter(Boolean).join(' / ');
	return (
		<Card>
			<CardHeader>
				<div className="flex items-center gap-3">
					<CardTitle>{env?.stage ?? 'Environment'}</CardTitle>
					{env?.consoleUrl && (
						<a
							href={env.consoleUrl}
							target="_blank"
							rel="noreferrer"
							className="ml-auto text-sm text-fg-soft hover:text-fg hover:underline"
						>
							AWS console ↗
						</a>
					)}
				</div>
				{description && <CardDescription className="font-mono text-xs">{description}</CardDescription>}
			</CardHeader>
			<CardContent className="space-y-3 text-sm">
				{/*
				 * The model's sentence, not a second copy of it. The old page wrote its
				 * own "No stack found. Deploy with npm run …" beside the model's
				 * `notDeployedDetail`, which is the duplication D81 exists to prevent.
				 */}
				{detail && <p className="text-fg-soft">{detail}</p>}
				{env?.error && <p className="text-danger-fg">{env.error}</p>}
				{env?.state === 'deployed' && (
					<>
						<div className="grid grid-cols-2 gap-x-8 gap-y-3 md:grid-cols-4">
							<div>
								<div className="text-fg-soft">Region</div>
								<div className="font-mono text-xs">{env.region ?? '—'}</div>
							</div>
							<div>
								<div className="text-fg-soft">Last updated</div>
								<div className="flex items-center gap-2">
									<span>{env.lastUpdated ? new Date(env.lastUpdated).toLocaleString() : '—'}</span>
									{latestDeploy && (
										<Link href="/deployments" title="Open deployments">
											<Badge variant={DEPLOY_STATUS_VARIANT[latestDeploy.status]}>{latestDeploy.status}</Badge>
										</Link>
									)}
								</div>
							</div>
							<div>
								<div className="text-fg-soft">Drift</div>
								<div className="flex items-center gap-2">
									<Badge variant={driftVariant(env.driftStatus)}>{env.driftStatus ?? 'NOT_CHECKED'}</Badge>
									{env.driftCheckedAt && (
										<span className="text-xs text-fg-dim">{new Date(env.driftCheckedAt).toLocaleDateString()}</span>
									)}
								</div>
							</div>
						</div>
						{/*
						 * A FAILED resources read is said, not rendered as an absent
						 * summary: "no blocks" and "we could not read the blocks" are
						 * different statements, which is the conflation D93 fixed one
						 * page over.
						 */}
						{resourcesFailure && <p className="text-xs text-warn-fg">{resourcesFailure}</p>}
						{resourceGroups && (
							<div className="grid grid-cols-2 gap-x-8 gap-y-3 md:grid-cols-4">
								<div>
									<div className="text-fg-soft">Your blocks</div>
									<Link href="/resources" className="hover:text-fg hover:underline">
										{blocksSummary(resourceGroups, 'app')}
									</Link>
								</div>
								<div>
									<div className="text-fg-soft">Platform blocks</div>
									<Link href="/resources" className="hover:text-fg hover:underline">
										{blocksSummary(resourceGroups, 'platform')}
									</Link>
								</div>
							</div>
						)}
					</>
				)}
				{env?.outputs && (
					<div className="space-y-1">
						{Object.entries(env.outputs).map(([key, value]) => (
							<div key={key} className="flex gap-2 text-xs">
								<span className="w-32 shrink-0 text-fg-soft">{key}</span>
								<span className="truncate font-mono">{value}</span>
							</div>
						))}
					</div>
				)}
				<p className="text-xs text-fg-dim">
					Read-only stack state. Drift shows the last known result — the dashboard never triggers drift detection
					itself.
				</p>
			</CardContent>
		</Card>
	);
}

export default function OverviewPage() {
	const { environment, setEnvironment, cloudStage, ready, statuses, status } = useEnvironment();
	const {
		data: meta,
		isLoading,
		error,
	} = useQuery({
		queryKey: ['meta'],
		queryFn: () => apiGet<MetaResponse>('/api/v1/meta'),
	});
	// Shared key with the provider and the header, so the three read one cached
	// response. It is additive and stage-independent: one call describes every
	// environment, which is what makes a selector affordable at all.
	const { data: envData, isLoading: envLoading } = useQuery({
		queryKey: ['environments'],
		queryFn: () => apiGet<EnvironmentsResponse>('/api/v1/environments'),
		refetchInterval: 30_000,
	});
	const { data: deployData } = useQuery({
		queryKey: ['deployments', cloudStage],
		queryFn: () => {
			// Unreachable in local: `enabled` holds this until a deployed stage is
			// selected. The guard narrows `cloudStage` without a cast.
			if (cloudStage === undefined) throw new Error('deployments requested with no stage');
			return apiGet<DeploymentsResponse>(`/api/v1/deployments?stage=${encodeURIComponent(cloudStage)}`);
		},
		enabled: ready && cloudStage !== undefined,
	});
	const { data: resourceData } = useQuery({
		queryKey: ['resources', cloudStage],
		queryFn: () => {
			if (cloudStage === undefined) throw new Error('resources requested with no stage');
			return apiGet<ResourcesResponse>(`/api/v1/resources?stage=${encodeURIComponent(cloudStage)}`);
		},
		enabled: ready && cloudStage !== undefined,
	});

	const cards = environmentCards(statuses, environment, envData?.environments);
	// The selected card's own stack, not a second `.find` over the same response:
	// pairing a stage with a stack is one tested decision (`environmentCards`), and
	// doing it again here is how the detail panel and the card above it drift apart.
	const selectedEnv = selectedCard(cards)?.info;
	const latestDeploy = deployData?.deployments[0];
	const resources = resourceSummaryState(resourceData?.resourcesSource, resourceData?.resourcesError);
	const resourceGroups = resources.state === 'ok' ? resourceData?.groups : undefined;

	return (
		<div className="space-y-6">
			<div>
				<h1 className="text-lg font-semibold tracking-tight">Overview</h1>
				<p className="mt-1 text-sm text-fg-soft">
					The environment every page reads from. Selecting one here is the same choice as the switch in the header.
				</p>
			</div>
			{error && (
				<Card>
					<CardHeader>
						<CardTitle>Cannot reach the Dashboard API</CardTitle>
						<CardDescription>
							Start the dashboard via <code>npm run dashboard</code> so the session token is set. ({String(error)})
						</CardDescription>
					</CardHeader>
				</Card>
			)}
			{/*
			 * Rendered from `statuses`, which is the header's own model — so the two
			 * controls cannot disagree about what is on offer. Empty only before
			 * `/api/v1/meta` lands, since local alone needs no request.
			 */}
			{cards.length > 0 && (
				<section aria-label="Environments" className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
					{cards.map((card) => (
						<EnvironmentChoice key={card.status.id} card={card} onSelect={setEnvironment} />
					))}
				</section>
			)}
			{(isLoading || envLoading) && <p className="text-sm text-fg-soft">Loading environment…</p>}
			{isLocalEnvironment(environment) ? (
				<LocalDetail detail={status?.detail} projectRoot={meta?.projectRoot} />
			) : (
				<StageDetail
					env={selectedEnv}
					detail={status?.detail}
					resourcesFailure={resources.state === 'failed' ? resources.detail : undefined}
					projectRoot={meta?.projectRoot}
					latestDeploy={latestDeploy}
					resourceGroups={resourceGroups}
				/>
			)}
		</div>
	);
}
