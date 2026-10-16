// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

'use client';

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { use } from 'react';
import { RequestError } from '@/components/request-error';
import { ConsoleLinkNote, ResourceTable } from '@/components/resource-table';
import { useEnvironment } from '@/components/environment-context';
import { GuidedEmpty } from '@/components/guided-empty';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import type { ResourcesResponse } from '@/contract/v1';
import { apiGet } from '@/lib/api-client';
import { RESOURCE_CATEGORY_LABEL, blockHref, findGroupById } from '@/nav/inventory-tree';

/**
 * One deployed resource group.
 *
 * This is where a framework group opens from the nav. The framework's own
 * resources — the shared API, the handler, CDK's custom-resource providers — are
 * attributed to no block by design, so without a page of their own they would be
 * reachable only from the Resources index. The group's own construct path is the
 * id, which is why the route param has to be matched decoded as well as encoded.
 */
export default function ResourceGroupPage({ params }: { params: Promise<{ groupId: string }> }) {
	const { groupId } = use(params);
	const { cloudStage, ready } = useEnvironment();
	const isLocal = cloudStage === undefined;

	const { data, isPending, error } = useQuery({
		// Same key as the nav, the Blocks page and the block detail page.
		queryKey: ['resources', cloudStage],
		queryFn: () => {
			// Unreachable in local: `enabled` holds this until a deployed stage is
			// selected. The guard narrows `cloudStage` without a cast.
			if (cloudStage === undefined) throw new Error('resources requested with no stage');
			return apiGet<ResourcesResponse>(`/api/v1/resources?stage=${encodeURIComponent(cloudStage)}`);
		},
		// This whole page is cloud-only — a group exists only in a deployed stack —
		// so the request is gated and never fires in local.
		enabled: ready && cloudStage !== undefined,
	});

	const group = data ? findGroupById(data.groups, groupId) : undefined;
	const readable = data?.resourcesSource === 'cloudformation';
	const hasConsoleLinks = group?.resources.some((resource) => resource.consoleUrl) ?? false;

	return (
		<div className="space-y-6">
			<div className="flex items-center gap-3">
				<Link href="/resources" className="text-sm text-fg-soft hover:text-fg">
					← Resources
				</Link>
			</div>

			<div className="flex flex-wrap items-center gap-3">
				<h1 className="font-mono text-lg font-semibold tracking-tight">{group?.id ?? decodeParam(groupId)}</h1>
				{group && <Badge variant="outline">{RESOURCE_CATEGORY_LABEL[group.category]}</Badge>}
				{group && (
					<Badge variant="outline">
						{group.resources.length} resource{group.resources.length === 1 ? '' : 's'}
					</Badge>
				)}
			</div>

			{isLocal && (
				// A resource group lives only in a deployed stack; local has none, so
				// there is nothing to read. Saying so with a way out beats sitting on
				// "Reading the deployed stack…" forever — an affirmative empty-state
				// that would imply a read is in progress.
				//
				// The Blocks link this used to hand-roll now belongs to the `resources`
				// pillar, which is why the resources index offers it as well: it
				// printed the same sentence naming Blocks with no way to follow it.
				<GuidedEmpty screen={{ kind: 'local-pillar', pillar: 'resources' }} />
			)}

			{!isLocal && isPending && <p className="text-sm text-fg-soft">Reading the deployed stack…</p>}
			<RequestError error={error} what="the deployed resources" />

			{/*
			 * "Could not read the stack" and "this stack has no such group" are
			 * different answers and must not share one sentence: the first is a
			 * problem with the request, the second is a fact about the deployment.
			 */}
			{data && !readable && (
				<Card>
					<CardHeader>
						<CardTitle className="text-base">
							{data.resourcesErrorCode === 'CREDENTIALS_EXPIRED' ? 'AWS credentials expired' : 'Resources unavailable'}
						</CardTitle>
						<CardDescription>{data.resourcesError}</CardDescription>
					</CardHeader>
				</Card>
			)}

			{data && readable && !group && (
				<Card>
					<CardHeader>
						<CardTitle className="text-base">No such resource group</CardTitle>
						<CardDescription>
							The deployed <span className="font-medium text-fg-soft">{cloudStage}</span> stack
							{data.stackName && (
								<>
									{' '}
									<code className="font-mono text-xs">{data.stackName}</code>
								</>
							)}{' '}
							has no group called <code className="font-mono text-xs">{decodeParam(groupId)}</code>. It holds{' '}
							{data.groups.length} group{data.groups.length === 1 ? '' : 's'} — a group appears once its resources
							are deployed, so a name from another stage or an older deploy will not be here.
						</CardDescription>
					</CardHeader>
					<CardContent>
						<Link href="/resources" className="text-[13px] text-fg-soft hover:text-fg hover:underline">
							See the groups this stack does have →
						</Link>
					</CardContent>
				</Card>
			)}

			{group && (
				<Card>
					<CardHeader className="py-4">
						<CardTitle className="text-base">Deployed resources</CardTitle>
						<CardDescription>
							Attributed to the construct path <code className="font-mono text-xs">{group.id}</code> in the deployed{' '}
							<span className="font-medium text-fg-soft">{cloudStage}</span> stack.
							{group.blockFullId ? (
								<>
									{' '}
									This group belongs to a block you declared —{' '}
									<Link href={blockHref(group.blockFullId)} className="text-fg-soft hover:text-fg hover:underline">
										open <code className="font-mono text-xs">{group.blockFullId}</code>
									</Link>{' '}
									to browse its records too.
								</>
							) : (
								' Created by the framework rather than declared by your app, so it has no block of its own.'
							)}
						</CardDescription>
					</CardHeader>
					{hasConsoleLinks && (
						<CardContent>
							<ConsoleLinkNote region={data?.awsContext?.region} />
						</CardContent>
					)}
					<CardContent className="p-0">
						<ResourceTable resources={group.resources} />
					</CardContent>
				</Card>
			)}
		</div>
	);
}

/** The raw param is what we show when no group matched it. */
function decodeParam(param: string): string {
	try {
		return decodeURIComponent(param);
	} catch {
		return param;
	}
}
