// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

'use client';

import { useQuery } from '@tanstack/react-query';
import { ChevronDown, ChevronRight, Component } from 'lucide-react';
import { useState } from 'react';
import { RequestError } from '@/components/request-error';
import { ConsoleLinkNote, ResourceTable } from '@/components/resource-table';
import { useEnvironment } from '@/components/environment-context';
import { GuidedEmpty } from '@/components/guided-empty';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import type { ResourceGroup, ResourcesResponse } from '@/contract/v1';
import { apiGet } from '@/lib/api-client';
import { RESOURCE_CATEGORY_LABEL } from '@/nav/inventory-tree';

const CATEGORY_BADGE: Record<ResourceGroup['category'], 'default' | 'outline'> = {
	app: 'default',
	platform: 'outline',
	cdk: 'outline',
};

export default function ResourcesPage() {
	const { cloudStage, ready } = useEnvironment();
	const [showInternals, setShowInternals] = useState(false);
	const [platformOpen, setPlatformOpen] = useState(false);

	const { data, isLoading, error } = useQuery({
		queryKey: ['resources', cloudStage],
		queryFn: () => {
			// Unreachable in local: `enabled` holds this until a deployed stage is
			// selected. The guard narrows `cloudStage` without a cast.
			if (cloudStage === undefined) throw new Error('resources requested with no stage');
			return apiGet<ResourcesResponse>(`/api/v1/resources?stage=${encodeURIComponent(cloudStage)}`);
		},
		enabled: ready && cloudStage !== undefined,
	});

	const visibleGroups = (data?.groups ?? []).filter((g) => showInternals || g.category !== 'cdk');
	const categories: ResourceGroup['category'][] = ['app', 'platform', 'cdk'];
	const hasConsoleLinks = visibleGroups.some((g) => g.resources.some((r) => r.consoleUrl));

	// Resources are read from a deployed CloudFormation stack (D76), and a local
	// run creates none. Nothing to query — not-applicable rather than an empty or
	// failed inventory, and the "show CDK internals" control has nothing to act on.
	if (cloudStage === undefined) {
		return (
			<div className="space-y-6">
				<div className="flex items-center gap-4">
					<h1 className="text-lg font-semibold tracking-tight">Resources</h1>
				</div>
				<GuidedEmpty screen={{ kind: 'local-pillar', pillar: 'resources' }} />
			</div>
		);
	}

	return (
		<div className="space-y-6">
			<div className="flex items-center gap-4">
				<h1 className="text-lg font-semibold tracking-tight">Resources</h1>
				{data?.resourcesSource === 'cloudformation' && (
					<span className="text-sm text-fg-soft">
						{data.totalResources} resources · stack <code className="font-mono text-xs">{data.stackName}</code>
					</span>
				)}
				<label className="ml-auto flex items-center gap-2 text-sm text-fg-soft">
					<input type="checkbox" checked={showInternals} onChange={(e) => setShowInternals(e.target.checked)} />
					show CDK internals
				</label>
			</div>

			{isLoading && <p className="text-sm text-fg-soft">Loading resources…</p>}
			<RequestError error={error} what="the deployed resources" />

			{hasConsoleLinks && <ConsoleLinkNote region={data?.awsContext?.region} />}

			{data?.resourcesSource === 'unavailable' && (
				<Card>
					<CardHeader>
						<CardTitle className="text-base">
							{data.resourcesErrorCode === 'CREDENTIALS_EXPIRED' ? 'AWS credentials expired' : 'Resources unavailable'}
						</CardTitle>
						<CardDescription>{data.resourcesError}</CardDescription>
					</CardHeader>
					{data.awsContext && (
						<CardContent>
							<p className="font-mono text-xs text-fg-soft">
								server resolved: profile {data.awsContext.profile ?? '(default chain)'} · region{' '}
								{data.awsContext.region ?? '(sdk default)'} ({data.awsContext.regionSource})
							</p>
						</CardContent>
					)}
				</Card>
			)}

			{categories.map((category) => {
				const groups = visibleGroups.filter((g) => g.category === category);
				if (groups.length === 0) return null;
				const collapsible = category === 'platform';
				const open = !collapsible || platformOpen;
				const resourceCount = groups.reduce((n, g) => n + g.resources.length, 0);
				const Chevron = open ? ChevronDown : ChevronRight;
				return (
					<section key={category} className="space-y-3">
						{collapsible ? (
							<button
								type="button"
								onClick={() => setPlatformOpen((o) => !o)}
								aria-expanded={open}
								className="flex items-center gap-1.5 text-sm font-medium uppercase tracking-wide text-fg-soft transition-colors hover:text-fg"
							>
								<Chevron size={14} strokeWidth={2} className="text-fg-dim" />
								{RESOURCE_CATEGORY_LABEL[category]}
								<span className="ml-1 font-normal normal-case tracking-normal text-fg-dim">
									{groups.length} block{groups.length === 1 ? '' : 's'} · {resourceCount} resource
									{resourceCount === 1 ? '' : 's'}
								</span>
							</button>
						) : (
							<h2 className="text-sm font-medium uppercase tracking-wide text-fg-soft">{RESOURCE_CATEGORY_LABEL[category]}</h2>
						)}
						{open &&
							groups.map((group) => (
							<Card key={group.id}>
								<CardHeader className="py-4">
									<div className="flex flex-wrap items-center gap-3">
										{group.blockFullId ? (
											<>
												<CardTitle className="flex items-center gap-1.5 font-mono text-sm">
													<Component size={14} strokeWidth={1.8} className="text-brand" aria-hidden="true" />
													<span className="sr-only">block </span>
													{group.blockFullId}
												</CardTitle>
												{group.blockType && (
													<Badge variant="outline" title="Block type declared in aws-blocks/">
														{group.blockType}
													</Badge>
												)}
												<span
													className="font-mono text-xs text-fg-dim"
													title="Construct path these resources were attributed to"
												>
													{group.id}
												</span>
											</>
										) : (
											<CardTitle className="font-mono text-sm">{group.id}</CardTitle>
										)}
										<Badge variant={CATEGORY_BADGE[group.category]}>
											{group.resources.length} resource{group.resources.length === 1 ? '' : 's'}
										</Badge>
									</div>
								</CardHeader>
								<CardContent className="p-0">
									<ResourceTable resources={group.resources} />
								</CardContent>
							</Card>
						))}
					</section>
				);
			})}
		</div>
	);
}
