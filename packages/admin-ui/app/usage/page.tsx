// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

'use client';

import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useEnvironment } from '@/components/environment-context';
import { RequestError } from '@/components/request-error';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import type { DeploymentsResponse, UsageResponse } from '@/contract/v1';
import { GuidedEmpty } from '@/components/guided-empty';
import { apiGet } from '@/lib/api-client';
import {
	KIND_LABEL,
	KIND_ORDER,
	RANGE_PRESETS,
	buildChart,
	chartEmptyReason,
	compactNumber,
	deployCaption,
	deployMarkers,
	formatDuration,
	groupByResource,
	sparklinePoints,
	usageUnavailableTitle,
} from '@/usage/usage-view';

/**
 * Usage: per-stage CloudWatch metrics, behind a cost gate.
 *
 * THE GATE IS THE PAGE'S FIRST STATE, not a dialog over a loaded view. The
 * unconfirmed request is free (the server discovers and prices without calling
 * GetMetricData), so the page can show exactly what a refresh would cost and
 * what it would read before anything is billed.
 *
 * Consent is held PER STAGE in component state, not globally and not on the
 * server. Switching to another stage re-gates, because that is a different
 * stack, a different query set and a different charge. A reload re-gates too:
 * consent is a property of a request, so it cannot outlive the page that
 * obtained it.
 */
export default function UsagePage() {
	const { cloudStage, ready } = useEnvironment();
	const [rangeMinutes, setRangeMinutes] = useState<number>(7 * 24 * 60);
	/** Stages the reader has accepted the charge for, this page load only. */
	const [consented, setConsented] = useState<ReadonlySet<string>>(new Set());
	/** Bumped to force a refetch, since the query is deliberately never polled. */
	const [refreshNonce, setRefreshNonce] = useState(0);

	const confirmed = cloudStage !== undefined && consented.has(cloudStage);

	const { data, isLoading, isFetching, error } = useQuery({
		queryKey: ['usage', cloudStage, rangeMinutes, confirmed, refreshNonce],
		queryFn: () => {
			// Unreachable: `enabled` holds this until a deployed stage is selected.
			// The guard narrows `cloudStage` without a cast.
			if (cloudStage === undefined) throw new Error('usage requested with no stage');
			const params = new URLSearchParams({
				stage: cloudStage,
				rangeMinutes: String(rangeMinutes),
				...(confirmed ? { confirm: 'true' } : {}),
			});
			return apiGet<UsageResponse>(`/api/v1/usage?${params.toString()}`);
		},
		// Never poll and never refetch on focus: a confirmed request is billed
		// every time, so every fetch must be one the reader asked for.
		refetchOnWindowFocus: false,
		refetchOnMount: false,
		staleTime: Number.POSITIVE_INFINITY,
		enabled: ready && cloudStage !== undefined,
	});

	// Deploy markers come from the local history file, so this costs nothing and
	// can load alongside the gate.
	const { data: deployData } = useQuery({
		queryKey: ['usage-deployments', cloudStage],
		queryFn: () => {
			if (cloudStage === undefined) throw new Error('deployments requested with no stage');
			return apiGet<DeploymentsResponse>(`/api/v1/deployments?stage=${encodeURIComponent(cloudStage)}`);
		},
		enabled: ready && cloudStage !== undefined,
	});

	if (cloudStage === undefined) {
		return (
			<div className="space-y-6">
				<h1 className="text-lg font-semibold tracking-tight">Usage</h1>
				<GuidedEmpty screen={{ kind: 'local-pillar', pillar: 'usage' }} />
			</div>
		);
	}

	const series = data?.series ?? [];
	const rows = groupByResource(series);
	const chart = buildChart(series);
	/*
	 * Markers are positioned against the CHART's own first and last bucket, not
	 * against the requested window. `buildChart` spans only where CloudWatch
	 * actually returned data (a gap stays a gap), so those two ranges differ
	 * whenever the window is wider than the data: a marker placed at a fraction
	 * of the window would then sit at the wrong point on the line it annotates,
	 * which is the misalignment that makes someone blame the wrong release.
	 */
	const markers = deployMarkers(
		deployData?.deployments ?? [],
		cloudStage,
		chart[0]?.timestamp ?? data?.start,
		chart[chart.length - 1]?.timestamp ?? data?.end,
	);
	/* Deploys inside the REQUESTED range, used only to caption the absence of a
	 * marker honestly: one can fall in the range the reader asked for and still
	 * sit outside the span CloudWatch returned data for. */
	const deploysInRange = deployMarkers(deployData?.deployments ?? [], cloudStage, data?.start, data?.end);
	const sharedTarget = data?.targets.find((t) => t.sharedDimensions);

	const consent = () => setConsented((previous) => new Set(previous).add(cloudStage));

	return (
		<div className="space-y-6">
			<div className="flex flex-wrap items-center gap-3">
				<h1 className="text-lg font-semibold tracking-tight">Usage</h1>
				<Badge variant="outline">{cloudStage}</Badge>
				<div className="ml-auto flex items-center gap-1">
					{RANGE_PRESETS.map((preset) => (
						<button
							key={preset.label}
							type="button"
							onClick={() => setRangeMinutes(preset.minutes)}
							aria-pressed={rangeMinutes === preset.minutes}
							className={
								rangeMinutes === preset.minutes
									? 'rounded-md bg-active px-2 py-1 text-xs text-fg'
									: 'rounded-md px-2 py-1 text-xs text-fg-soft transition-colors hover:bg-hover hover:text-fg'
							}
						>
							{preset.label}
						</button>
					))}
				</div>
			</div>

			{isLoading && <p className="text-sm text-fg-soft">Reading what this stage would report…</p>}
			<RequestError error={error} what="usage data" />

			{data?.usageSource === 'unavailable' &&
				// Only ACCESS_DENIED is guided here: it has one concrete thing to ask
				// for. The other codes (expired or missing credentials, a stack that
				// is not there) each need a different action, and giving them this
				// card's "add an IAM permission" next step would send the reader after
				// the wrong fix.
				(data.usageErrorCode === 'ACCESS_DENIED' ? (
					<GuidedEmpty
						screen={{
							kind: 'access-denied',
							permission: 'cloudwatch:GetMetricData',
							// The distinction worth keeping: a blank chart from a refused
							// read looks exactly like a blank chart from an idle app.
							detail: `${data.usageError} The charts are blank because the dashboard was not allowed to look, which is not the same as your app having no traffic.`,
						}}
					/>
				) : (
					<Card>
						<CardHeader>
							<CardTitle className="text-base">{usageUnavailableTitle(data.usageErrorCode)}</CardTitle>
							<CardDescription>{data.usageError}</CardDescription>
						</CardHeader>
					</Card>
				))}

			{/* THE GATE. Nothing has been billed to render this. */}
			{data?.usageSource === 'gated' && (
				<Card className="border-warn/40">
					<CardHeader>
						<CardTitle className="text-base">Reading these metrics costs money</CardTitle>
						<CardDescription>
							CloudWatch bills <strong>{data.estimate.usdFormatted}</strong> for this refresh:{' '}
							{data.estimate.metricsRequested} metrics requested at ${data.estimate.usdPer1000Metrics} per 1,000, in{' '}
							{data.estimate.apiCalls} {data.estimate.apiCalls === 1 ? 'call' : 'calls'}. GetMetricData is excluded
							from the CloudWatch free tier, so there is no allowance this falls inside.
						</CardDescription>
					</CardHeader>
					<CardContent className="space-y-4">
						<div className="rounded-md border border-line bg-hover p-3 text-sm">
							<p className="mb-2 text-fg-soft">
								It would read {data.targets.length} {data.targets.length === 1 ? 'resource' : 'resources'} in{' '}
								<code>{data.stackName}</code>:
							</p>
							<ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-fg-soft">
								{KIND_ORDER.filter((kind) => data.targets.some((t) => t.kind === kind)).map((kind) => {
									const of = data.targets.filter((t) => t.kind === kind);
									const metrics = of.reduce((sum, t) => sum + t.metricCount, 0);
									return (
										<li key={kind}>
											<span className="text-fg">{of.length}</span>{' '}
											{of.length === 1 ? KIND_LABEL[kind].one.toLowerCase() : KIND_LABEL[kind].many.toLowerCase()}{' '}
											<span className="text-fg-dim">({metrics} metrics)</span>
										</li>
									);
								})}
							</ul>
						</div>
						<div className="flex flex-wrap items-center gap-3">
							<button
								type="button"
								onClick={consent}
								className="rounded-md bg-brand px-3 py-1.5 text-sm font-medium text-on-brand transition-opacity hover:opacity-90"
							>
								Read metrics for {data.estimate.usdFormatted}
							</button>
							<span className="text-xs text-fg-dim">
								Nothing has been charged yet. Each refresh bills again, and switching stage asks again.
							</span>
						</div>
					</CardContent>
				</Card>
			)}

			{data?.usageSource === 'cloudwatch' && (
				<>
					<div className="flex flex-wrap items-center gap-3 text-xs text-fg-dim">
						<span>
							charged {data.estimate.usdFormatted} · {data.estimate.metricsRequested} metrics ·{' '}
							{data.fetchedAt ? new Date(data.fetchedAt).toLocaleTimeString() : ''}
						</span>
						<span>
							{data.periodSeconds >= 3600
								? `${data.periodSeconds / 3600}h buckets`
								: `${data.periodSeconds / 60}m buckets`}
						</span>
						<button
							type="button"
							onClick={() => setRefreshNonce((n) => n + 1)}
							disabled={isFetching}
							className="rounded-md border border-line px-2 py-0.5 text-fg-soft transition-colors hover:bg-active hover:text-fg disabled:opacity-50"
						>
							{isFetching ? 'reading…' : `refresh (${data.estimate.usdFormatted})`}
						</button>
					</div>

					{sharedTarget && (
						<Card className="border-warn/30">
							<CardContent className="flex flex-wrap items-start gap-3 pt-6 text-sm">
								<Badge variant="warning">spans every stage</Badge>
								{/*
								 * The server's reason is shown FIRST and the resource named
								 * after it. Interpolating the label ahead of the sentence
								 * collided with its opening words ("Blocks API API Gateway
								 * REST metrics are…"), which read as a typo.
								 */}
								<p className="flex-1 text-fg-soft">
									{sharedTarget.sharedReason} Affected here: <code>{sharedTarget.label}</code>. Its row below, and
									any total including it, covers every stage rather than just {cloudStage}.
								</p>
							</CardContent>
						</Card>
					)}

					<div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
						<Card>
							<CardHeader className="pb-2">
								<CardDescription>Requests</CardDescription>
								<CardTitle className="text-3xl">{compactNumber(data.totals?.invocations ?? 0)}</CardTitle>
							</CardHeader>
							{data.totals?.includesSharedDimensions && (
								<CardContent className="pt-0 text-xs text-warn-fg">includes all stages</CardContent>
							)}
						</Card>
						<Card>
							<CardHeader className="pb-2">
								<CardDescription>Errors</CardDescription>
								<CardTitle className={`text-3xl ${(data.totals?.errors ?? 0) > 0 ? 'text-danger-fg' : ''}`}>
									{compactNumber(data.totals?.errors ?? 0)}
								</CardTitle>
							</CardHeader>
						</Card>
						<Card>
							<CardHeader className="pb-2">
								<CardDescription>Resources measured</CardDescription>
								<CardTitle className="text-3xl">{rows.filter((r) => !r.allEmpty).length}</CardTitle>
							</CardHeader>
							<CardContent className="pt-0 text-xs text-fg-dim">of {rows.length} deployed</CardContent>
						</Card>
						<Card>
							<CardHeader className="pb-2">
								<CardDescription>Region</CardDescription>
								<CardTitle className="text-xl">{data.awsContext?.region ?? '—'}</CardTitle>
							</CardHeader>
							<CardContent className="pt-0 text-xs text-fg-dim">
								from {data.awsContext?.regionSource ?? 'none'}
							</CardContent>
						</Card>
					</div>

					<Card>
						<CardHeader className="pb-2">
							<CardTitle className="text-base">Requests over time</CardTitle>
							<CardDescription>{deployCaption(markers.length, deploysInRange.length)}</CardDescription>
						</CardHeader>
						<CardContent>
							{chartEmptyReason(series, chart.length) ? (
								<p className="text-sm text-fg-soft">{chartEmptyReason(series, chart.length)}</p>
							) : (
								<TrafficChart chart={chart} markers={markers} />
							)}
						</CardContent>
					</Card>

					{KIND_ORDER.filter((kind) => rows.some((r) => r.kind === kind)).map((kind) => (
						<ResourceTable key={kind} kind={kind} rows={rows.filter((r) => r.kind === kind)} />
					))}
				</>
			)}
		</div>
	);
}

/** Requests over time, with errors beneath and deploys marked. */
function TrafficChart({
	chart,
	markers,
}: {
	chart: ReturnType<typeof buildChart>;
	markers: ReturnType<typeof deployMarkers>;
}) {
	const invocations = sparklinePoints(chart.map((p) => p.invocations));
	const errors = sparklinePoints(chart.map((p) => p.errors));
	const peak = Math.max(...chart.map((p) => p.invocations), 0);

	return (
		<div>
			<div className="relative h-32">
				{/*
				 * `preserveAspectRatio="none"` so the 0..100 box stretches to the
				 * card's width; stroke width is therefore given in the box's units
				 * and `vector-effect` keeps it from stretching with it.
				 */}
				<svg
					viewBox="0 0 100 100"
					preserveAspectRatio="none"
					className="h-full w-full overflow-visible"
					role="img"
					aria-label={`Requests over time, peak ${peak} per bucket`}
				>
					{invocations && (
						<polyline
							points={invocations}
							fill="none"
							stroke="var(--color-brand)"
							strokeWidth={1.5}
							vectorEffect="non-scaling-stroke"
						/>
					)}
					{errors && (
						<polyline
							points={errors}
							fill="none"
							stroke="var(--color-danger)"
							strokeWidth={1.5}
							vectorEffect="non-scaling-stroke"
						/>
					)}
				</svg>
				{markers.map((marker) => (
					<div
						key={marker.id}
						title={`${marker.status} deploy at ${new Date(marker.at).toLocaleString()}`}
						style={{ left: `${(marker.position * 100).toFixed(2)}%` }}
						className={`absolute top-0 bottom-0 w-px ${
							marker.status === 'SUCCEEDED' ? 'bg-ok' : 'bg-danger'
						} opacity-70`}
					>
						<span
							className={`absolute -top-1 -left-[3px] h-[7px] w-[7px] rounded-full ${
								marker.status === 'SUCCEEDED' ? 'bg-ok' : 'bg-danger'
							}`}
						/>
					</div>
				))}
			</div>
			<div className="mt-2 flex items-center justify-between text-xs text-fg-dim">
				<span>{new Date(chart[0].timestamp).toLocaleString()}</span>
				<span className="flex items-center gap-3">
					<span className="flex items-center gap-1">
						<span className="h-px w-3 bg-brand" /> requests
					</span>
					<span className="flex items-center gap-1">
						<span className="h-px w-3 bg-danger" /> errors
					</span>
					<span>peak {compactNumber(peak)}</span>
				</span>
				<span>{new Date(chart[chart.length - 1].timestamp).toLocaleString()}</span>
			</div>
		</div>
	);
}

/** One kind's resources, busiest first. */
function ResourceTable({
	kind,
	rows,
}: {
	kind: keyof typeof KIND_LABEL;
	rows: ReturnType<typeof groupByResource>;
}) {
	const showLatency = kind === 'api' || kind === 'function';
	const showCapacity = kind === 'table';

	return (
		<Card>
			<CardHeader>
				<CardTitle className="text-base">{KIND_LABEL[kind].many}</CardTitle>
			</CardHeader>
			<CardContent className="p-0">
				<Table>
					<TableHeader>
						<TableRow>
							<TableHead>{KIND_LABEL[kind].one}</TableHead>
							<TableHead className="text-right">{showCapacity ? 'Read units' : 'Requests'}</TableHead>
							<TableHead className="text-right">{showCapacity ? 'Write units' : 'Errors'}</TableHead>
							{showLatency && <TableHead className="text-right">Avg latency</TableHead>}
							<TableHead className="w-24 text-right">Trend</TableHead>
						</TableRow>
					</TableHeader>
					<TableBody>
						{rows.map((row) => {
							const read = row.series.find((s) => s.metricName === 'ConsumedReadCapacityUnits');
							const write = row.series.find((s) => s.metricName === 'ConsumedWriteCapacityUnits');
							const trendSeries = showCapacity
								? read
								: row.series.find((s) => !s.empty && s.points.length > 1 && s.total > 0);
							const trend = sparklinePoints(trendSeries?.points.map((p) => p.value) ?? []);
							return (
								<TableRow key={row.targetKey}>
									<TableCell className="font-mono text-xs">
										<span className={row.allEmpty ? 'text-fg-dim' : ''}>{row.label}</span>
										{row.sharedDimensions && (
											<Badge variant="warning" className="ml-2">
												all stages
											</Badge>
										)}
										{row.allEmpty && <span className="ml-2 text-xs text-fg-dim">no datapoints</span>}
									</TableCell>
									<TableCell className="text-right font-mono text-xs">
										{showCapacity ? compactNumber(read?.total ?? 0) : compactNumber(row.invocations ?? 0)}
									</TableCell>
									<TableCell
										className={`text-right font-mono text-xs ${
											!showCapacity && (row.errors ?? 0) > 0 ? 'text-danger-fg' : ''
										}`}
									>
										{showCapacity ? compactNumber(write?.total ?? 0) : compactNumber(row.errors ?? 0)}
									</TableCell>
									{showLatency && (
										<TableCell className="text-right font-mono text-xs">{formatDuration(row.latencyMs)}</TableCell>
									)}
									<TableCell className="text-right">
										{trend ? (
											<svg
												viewBox="0 0 100 100"
												preserveAspectRatio="none"
												className="h-5 w-20"
												role="img"
												aria-label={`Trend for ${row.label}`}
											>
												<polyline
													points={trend}
													fill="none"
													stroke="var(--color-brand)"
													strokeWidth={1.5}
													vectorEffect="non-scaling-stroke"
												/>
											</svg>
										) : (
											<span className="text-xs text-fg-dim">—</span>
										)}
									</TableCell>
								</TableRow>
							);
						})}
					</TableBody>
				</Table>
			</CardContent>
		</Card>
	);
}
