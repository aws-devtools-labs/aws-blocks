// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

'use client';

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { use } from 'react';
import { useEnvironment } from '@/components/environment-context';
import { GuidedEmpty } from '@/components/guided-empty';
import { RequestError } from '@/components/request-error';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import type { DeploymentDetailResponse, DeploymentStatus } from '@/contract/v1';
import { deploymentExplanation } from '@/deployments/detail-explanation';
import { deploymentStageNote } from '@/env/environment';
import { ApiRequestError, apiGet } from '@/lib/api-client';

const STATUS_VARIANT: Record<DeploymentStatus, 'success' | 'destructive' | 'warning' | 'outline'> = {
	SUCCEEDED: 'success',
	FAILED: 'destructive',
	ROLLED_BACK: 'warning',
	IN_PROGRESS: 'warning',
	UNKNOWN: 'outline',
};

export default function DeploymentDetailPage({ params }: { params: Promise<{ id: string }> }) {
	const { id } = use(params);
	const { cloudStage, ready } = useEnvironment();
	const { data, isLoading, error, refetch } = useQuery({
		// Keyed on the id alone, unlike every other page: this read is not
		// stage-scoped — the server finds the record across the whole history and
		// the response carries the stage it went to. Adding the stage to the key
		// would refetch byte-identical data on every environment switch.
		queryKey: ['deployment', id],
		queryFn: () => apiGet<DeploymentDetailResponse>(`/api/v1/deployments/${encodeURIComponent(id)}`),
		enabled: ready && cloudStage !== undefined,
	});

	const backLink = (
		<div className="flex items-center gap-3">
			<Link href="/deployments" className="text-sm text-fg-soft hover:text-fg">
				← Deployments
			</Link>
		</div>
	);

	// A local run is not a deployment (D77), so a local run has no deployment
	// detail either. This route is reachable directly even though the list links
	// nowhere in local: a bookmark, a shared URL, or a reload with `local`
	// selected all land here. Unguarded it issued a cloud read — and this route's
	// backfill path calls DescribeStackEvents for EVERY stage — then rendered the
	// raw failure, telling the reader the deployment could not be read when the
	// truth is that there is none to read.
	if (cloudStage === undefined) {
		return (
			<div className="space-y-6">
				{backLink}
				<h1 className="text-lg font-semibold tracking-tight">Deployment</h1>
				<GuidedEmpty screen={{ kind: 'local-pillar', pillar: 'deployments' }} />
			</div>
		);
	}

	// A 404 is a COMPLETED request with a definite answer — this id is in neither
	// the history file nor the CloudFormation backfill — so it must not be
	// reported as "the request did not complete". Pruned history and a URL from
	// another machine both land here.
	const notFound = error instanceof ApiRequestError && error.status === 404;
	const stageNote = data ? deploymentStageNote(cloudStage, data.deployment.stage) : undefined;
	// Total rather than optional: with no response there is nothing to explain, and
	// "say nothing" is exactly what both flags false means. That keeps the JSX below
	// free of optional access on a value the enclosing `data &&` already implies.
	const explanation = data
		? deploymentExplanation({
				status: data.deployment.status,
				errorSummary: data.deployment.errorSummary,
				eventsSource: data.eventsSource,
				hasRootCause: Boolean(data.rootCause),
				failureEventCount: data.failureEvents.length,
			})
		: { showRecordedError: false, showEmptyEventsNote: false };

	return (
		<div className="space-y-6">
			{backLink}
			{isLoading && <p className="text-sm text-fg-soft">Loading deployment…</p>}
			{notFound ? (
				<Card>
					<CardHeader>
						<CardTitle>No such deployment</CardTitle>
						<CardDescription>
							Nothing with id <code>{id}</code> is in <code>.blocks/deploy-history.jsonl</code> or in the
							CloudFormation events this dashboard can reconstruct deployments from. The record may have been
							pruned, or written on another machine.
						</CardDescription>
					</CardHeader>
				</Card>
			) : (
				<RequestError error={error} what="this deployment" />
			)}
			{data && (
				<>
					<div className="flex items-center gap-3">
						<h1 className="text-lg font-semibold tracking-tight">Deployment to {data.deployment.stage}</h1>
						<Badge variant={STATUS_VARIANT[data.deployment.status]}>{data.deployment.status}</Badge>
					</div>
					{stageNote && (
						<Card>
							<CardHeader>
								<CardTitle className="text-base">Another stage’s deployment</CardTitle>
								<CardDescription>{stageNote}</CardDescription>
							</CardHeader>
						</Card>
					)}
					<Card>
						<CardHeader>
							<CardTitle className="text-base">Summary</CardTitle>
						</CardHeader>
						<CardContent className="grid grid-cols-2 gap-x-8 gap-y-2 text-sm md:grid-cols-4">
							<div>
								<div className="text-fg-soft">Started</div>
								<div>{new Date(data.deployment.startedAt).toLocaleString()}</div>
							</div>
							<div>
								<div className="text-fg-soft">Finished</div>
								<div>{data.deployment.finishedAt ? new Date(data.deployment.finishedAt).toLocaleString() : '—'}</div>
							</div>
							<div>
								<div className="text-fg-soft">Commit</div>
								<div className="font-mono">{data.deployment.gitSha?.slice(0, 12) ?? '—'}</div>
							</div>
							<div>
								<div className="text-fg-soft">Stack</div>
								<div className="font-mono">{data.stackName ?? '—'}</div>
							</div>
						</CardContent>
					</Card>

					{data.rootCause && (
						<Card className="border-danger/30">
							<CardHeader>
								<CardTitle className="text-base text-danger-fg">Root cause</CardTitle>
								<CardDescription>
									First non-cancelled failure — later failures and cancellations are consequences of this one.
								</CardDescription>
							</CardHeader>
							<CardContent className="space-y-2 text-sm">
								<div className="flex flex-wrap items-center gap-2">
									<Badge variant="destructive">{data.rootCause.resourceStatus}</Badge>
									<span className="font-mono font-medium">{data.rootCause.logicalResourceId}</span>
									<span className="text-fg-soft">{data.rootCause.resourceType}</span>
									<span className="ml-auto text-xs text-fg-dim">
										{new Date(data.rootCause.timestamp).toLocaleString()}
									</span>
								</div>
								{data.rootCause.statusReason && (
									<p className="rounded-md bg-danger/10 p-3 font-mono text-xs leading-relaxed text-danger-fg-loud">
										{data.rootCause.statusReason}
									</p>
								)}
							</CardContent>
						</Card>
					)}

					{data.eventsSource === 'unavailable' && (
						<Card className={data.eventsErrorCode === 'CREDENTIALS_EXPIRED' ? 'border-warn/30' : ''}>
							<CardHeader>
								<CardTitle className="text-base">
									{data.eventsErrorCode === 'CREDENTIALS_EXPIRED' && 'AWS credentials expired'}
									{data.eventsErrorCode === 'CREDENTIALS_MISSING' && 'No AWS credentials found'}
									{data.eventsErrorCode === 'STACK_NOT_FOUND' && 'Stack not found'}
									{(data.eventsErrorCode === 'UNKNOWN' || !data.eventsErrorCode) && 'Failure events unavailable'}
								</CardTitle>
								<CardDescription>{data.eventsError}</CardDescription>
							</CardHeader>
							<CardContent className="space-y-3 text-sm">
								{data.awsContext && (
									<p className="font-mono text-xs text-fg-soft">
										server resolved: profile {data.awsContext.profile ?? '(default chain)'} · region{' '}
										{data.awsContext.region ?? '(sdk default)'} ({data.awsContext.regionSource})
									</p>
								)}
								{data.eventsErrorCode === 'CREDENTIALS_EXPIRED' && (
									<p>
										Refresh the credentials for that profile in any terminal (e.g.{' '}
										<code>aws sso login</code>, or whatever your organisation uses), then retry — the dashboard
										re-reads credentials on every request, no restart needed.
									</p>
								)}
								{data.eventsErrorCode === 'CREDENTIALS_MISSING' && (
									<p>
										The dashboard server found no usable AWS credentials. Configure the profile it runs with (or set{' '}
										<code>AWS_PROFILE</code> before <code>npm run dashboard</code>), then retry.
									</p>
								)}
								{data.eventsErrorCode === 'STACK_NOT_FOUND' && (
									<p>
										The stack was not found in the queried region — often a region mismatch. This deployment predates
										region recording, so the server used ambient config; restart the dashboard with{' '}
										<code>AWS_REGION=&lt;deploy region&gt;</code> or redeploy so the region is recorded.
									</p>
								)}
								<button
									type="button"
									onClick={() => refetch()}
									className="rounded-md border border-line bg-panel px-3 py-1.5 text-sm font-medium hover:bg-hover"
								>
									Retry
								</button>
							</CardContent>
						</Card>
					)}

					{explanation.showRecordedError && data.deployment.errorSummary && (
						<Card>
							<CardHeader>
								<CardTitle className="text-base">Recorded error</CardTitle>
								<CardDescription className="font-mono">{data.deployment.errorSummary}</CardDescription>
							</CardHeader>
						</Card>
					)}

					{explanation.showEmptyEventsNote && (
						<Card>
							<CardHeader>
								<CardTitle className="text-base">No failure events in the deploy window</CardTitle>
								<CardDescription>
									The stack’s events were read successfully, and none with a failure status fall between this
									deployment’s start and finish. CloudFormation keeps events for a limited time, so an older
									deployment’s events may simply have aged out.
								</CardDescription>
							</CardHeader>
						</Card>
					)}

					{data.failureEvents.length > 0 && (
						<Card>
							<CardHeader>
								<CardTitle className="text-base">Failure events ({data.failureEvents.length})</CardTitle>
								<CardDescription>All failure-status stack events in the deploy window, newest first.</CardDescription>
							</CardHeader>
							<CardContent className="p-0">
								<Table>
									<TableHeader>
										<TableRow>
											<TableHead>Time</TableHead>
											<TableHead>Resource</TableHead>
											<TableHead>Status</TableHead>
											<TableHead>Reason</TableHead>
										</TableRow>
									</TableHeader>
									<TableBody>
										{data.failureEvents.map((event) => (
											<TableRow
												key={`${event.timestamp}-${event.logicalResourceId}`}
												className={event.cancelled ? 'text-fg-dim' : ''}
											>
												<TableCell className="whitespace-nowrap">
													{new Date(event.timestamp).toLocaleTimeString()}
												</TableCell>
												<TableCell>
													<span className="font-mono">{event.logicalResourceId}</span>
													<div className="text-xs text-fg-dim">{event.resourceType}</div>
												</TableCell>
												<TableCell>
													<Badge variant={event.cancelled ? 'outline' : 'destructive'}>{event.resourceStatus}</Badge>
												</TableCell>
												<TableCell className="max-w-xl font-mono text-xs">{event.statusReason ?? ''}</TableCell>
											</TableRow>
										))}
									</TableBody>
								</Table>
							</CardContent>
						</Card>
					)}
				</>
			)}
		</div>
	);
}
