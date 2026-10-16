// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import type { DeploymentRecord, UsageSeriesInfo, UsageTargetInfo } from '../contract/v1.js';

/**
 * View logic for the usage page, kept out of the component so it is testable:
 * the chart's shape, the deploy markers' positions and the per-kind grouping
 * are all decisions that can be wrong in ways a rendered page hides.
 */

/** A resource's metrics, gathered from the flat series list. */
export interface UsageResourceRow {
	targetKey: string;
	label: string;
	kind: UsageTargetInfo['kind'];
	/** Requests/invocations, when the kind reports any. */
	invocations?: number;
	/** Failures across this resource's error metrics. */
	errors?: number;
	/** Latency or duration average, in milliseconds. */
	latencyMs?: number;
	/** Every series for this resource, for the row's own sparkline. */
	series: UsageSeriesInfo[];
	/** True when every one of this resource's series came back with no datapoints. */
	allEmpty: boolean;
	sharedDimensions?: true;
}

/** Metric names that count requests. Mirrors the server's own grouping. */
const INVOCATION_METRICS = new Set(['Count', 'Invocations', 'Requests', 'ExecutionsStarted']);

/** Metric names that count failures. */
const ERROR_METRICS = new Set([
	'4XXError',
	'5XXError',
	'Errors',
	'Throttles',
	'ThrottledRequests',
	'ExecutionsFailed',
	'NumberOfNotificationsFailed',
]);

/** Metric names carrying a duration in milliseconds. */
const LATENCY_METRICS = new Set(['Latency', 'Duration']);

/**
 * Groups the flat series list into one row per resource (pure).
 *
 * Sorted by traffic descending, then by label, so the busiest resource is
 * first and the order is stable between refreshes. A resource whose every
 * series is empty sorts last but is still returned: "deployed and never
 * touched" is a finding, and hiding it would make this disagree with the
 * resources view.
 */
export function groupByResource(series: UsageSeriesInfo[]): UsageResourceRow[] {
	const rows = new Map<string, UsageResourceRow>();
	for (const s of series) {
		const existing = rows.get(s.targetKey);
		const row: UsageResourceRow =
			existing ??
			({
				targetKey: s.targetKey,
				label: s.targetLabel,
				kind: s.targetKind,
				series: [],
				allEmpty: true,
				...(s.sharedDimensions ? { sharedDimensions: true as const } : {}),
			} satisfies UsageResourceRow);
		row.series.push(s);
		if (!s.empty) row.allEmpty = false;
		if (INVOCATION_METRICS.has(s.metricName)) row.invocations = (row.invocations ?? 0) + s.total;
		if (ERROR_METRICS.has(s.metricName)) row.errors = (row.errors ?? 0) + s.total;
		if (LATENCY_METRICS.has(s.metricName) && s.points.length > 0) {
			// An average of averages is wrong in general, but each series here
			// holds ONE metric's per-period averages, so the mean over periods is
			// the honest summary available without re-querying with a different
			// statistic.
			row.latencyMs = s.points.reduce((sum, p) => sum + p.value, 0) / s.points.length;
		}
		rows.set(s.targetKey, row);
	}
	return [...rows.values()].sort(
		(a, b) =>
			Number(a.allEmpty) - Number(b.allEmpty) ||
			(b.invocations ?? 0) - (a.invocations ?? 0) ||
			a.label.localeCompare(b.label),
	);
}

/** Human label for a target kind, singular and plural. */
export const KIND_LABEL: Record<UsageTargetInfo['kind'], { one: string; many: string }> = {
	api: { one: 'API', many: 'APIs' },
	function: { one: 'Function', many: 'Functions' },
	table: { one: 'Table', many: 'Tables' },
	workflow: { one: 'Workflow', many: 'Workflows' },
	topic: { one: 'Topic', many: 'Topics' },
	cdn: { one: 'Distribution', many: 'CDN' },
};

/** Order the kinds appear in, most-asked-about first. */
export const KIND_ORDER: Array<UsageTargetInfo['kind']> = ['api', 'function', 'table', 'workflow', 'cdn', 'topic'];

/** One point of the combined traffic chart. */
export interface ChartPoint {
	timestamp: string;
	invocations: number;
	errors: number;
}

/**
 * Sums the invocation and error series onto one timeline (pure).
 *
 * Buckets are taken from the series' own timestamps rather than generated from
 * the range, so a gap in CloudWatch's data stays a gap instead of being drawn
 * as a zero. That distinction is the whole reason `empty` exists on a series.
 */
export function buildChart(series: UsageSeriesInfo[]): ChartPoint[] {
	const buckets = new Map<string, ChartPoint>();
	for (const s of series) {
		const counts = INVOCATION_METRICS.has(s.metricName);
		const fails = ERROR_METRICS.has(s.metricName);
		if (!counts && !fails) continue;
		for (const point of s.points) {
			const bucket = buckets.get(point.timestamp) ?? {
				timestamp: point.timestamp,
				invocations: 0,
				errors: 0,
			};
			if (counts) bucket.invocations += point.value;
			if (fails) bucket.errors += point.value;
			buckets.set(point.timestamp, bucket);
		}
	}
	return [...buckets.values()].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
}

/** A deploy to mark on the chart, positioned as a fraction of the window. */
export interface DeployMarker {
	id: string;
	at: string;
	status: DeploymentRecord['status'];
	/** 0..1 across the charted window. */
	position: number;
}

/**
 * Places deploys that fall inside the charted window (pure).
 *
 * Only deploys for the SAME stage, and only those strictly inside the window:
 * a marker clamped to an edge would claim a deploy happened at the window's
 * boundary when it happened outside it, which is the kind of small lie that
 * makes someone correlate a traffic change with the wrong release.
 */
export function deployMarkers(
	deployments: DeploymentRecord[],
	stage: string,
	start: string | undefined,
	end: string | undefined,
): DeployMarker[] {
	if (!start || !end) return [];
	const from = Date.parse(start);
	const to = Date.parse(end);
	if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) return [];
	const markers: DeployMarker[] = [];
	for (const deployment of deployments) {
		if (deployment.stage !== stage) continue;
		const at = Date.parse(deployment.startedAt);
		if (!Number.isFinite(at) || at < from || at > to) continue;
		markers.push({
			id: deployment.id,
			at: deployment.startedAt,
			status: deployment.status,
			position: (at - from) / (to - from),
		});
	}
	return markers.sort((a, b) => a.at.localeCompare(b.at));
}

/**
 * Why the traffic chart has no line to draw, or undefined when it has one.
 *
 * Three outcomes, because they mean different things and only one of them is
 * "your app is idle":
 *
 * - no request or error metric was even asked for (nothing here counts traffic)
 * - they were asked for and CloudWatch returned NO datapoints, which is not the
 *   same as returning zeroes: nothing was published at all
 * - a single bucket, which is a real measurement that simply cannot be a line
 *
 * The generic "not enough datapoints" wording this replaces was actively
 * misleading on a stage whose tables had 168 datapoints each: the page appeared
 * to have found nothing while the tables below it were full.
 */
export function chartEmptyReason(series: UsageSeriesInfo[], chartLength: number): string | undefined {
	if (chartLength >= 2) return undefined;
	const trafficSeries = series.filter((s) => INVOCATION_METRICS.has(s.metricName) || ERROR_METRICS.has(s.metricName));
	if (trafficSeries.length === 0) {
		return 'None of this stage’s resources publish a request count, so there is no traffic to chart.';
	}
	if (trafficSeries.every((s) => s.empty)) {
		const measured = series.filter((s) => !s.empty).length;
		return measured > 0
			? `CloudWatch recorded no request or error datapoints in this window, so there is no line to draw. Other metrics did report (${measured} ${measured === 1 ? 'series' : 'series'} below), so this is an idle API rather than a missing stage.`
			: 'CloudWatch recorded no datapoints at all in this window. That is different from zero traffic: nothing was published.';
	}
	return 'Only one bucket of request data falls in this window, which cannot be drawn as a line. Choose a longer range.';
}

/**
 * Caption for the chart's deploy markers.
 *
 * Says which window it means, because two of them are in play: markers are
 * placed against the CHARTED extent (where CloudWatch returned data), while the
 * reader asked for a wider range. A deploy can therefore fall inside the
 * requested range and still have no marker, and "No deploys in this window"
 * alone reads as though none happened at all. Naming the case keeps the
 * information rather than discarding it, and still refuses to draw the marker
 * somewhere it would misrepresent.
 */
export function deployCaption(markerCount: number, inRequestedRange: number): string {
	if (markerCount > 0) {
		return `${markerCount} ${markerCount === 1 ? 'deploy' : 'deploys'} marked`;
	}
	if (inRequestedRange > 0) {
		const plural = inRequestedRange === 1 ? 'deploy' : 'deploys';
		return `${inRequestedRange} ${plural} in this range, but outside the span CloudWatch returned data for, so ${inRequestedRange === 1 ? 'it is' : 'they are'} not marked`;
	}
	return 'No deploys in this range';
}

/**
 * An SVG polyline for a series of values, normalised to a 0..100 box (pure).
 *
 * Returns undefined for fewer than two points: a one-point line renders as
 * nothing and a zero-point one as `NaN` in the path, which React happily puts
 * in the DOM as a broken attribute.
 */
export function sparklinePoints(values: number[], width = 100, height = 100): string | undefined {
	if (values.length < 2) return undefined;
	const max = Math.max(...values);
	const span = max > 0 ? max : 1;
	const step = width / (values.length - 1);
	return values
		.map((value, i) => `${(i * step).toFixed(2)},${(height - (value / span) * height).toFixed(2)}`)
		.join(' ');
}

/** Compact number for a tile: 1234 -> 1.2k. */
export function compactNumber(value: number): string {
	if (!Number.isFinite(value)) return '—';
	if (Math.abs(value) < 1000) return Number.isInteger(value) ? String(value) : value.toFixed(2);
	return new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(value);
}

/** Milliseconds for a tile: 1234.5 -> 1.23s, 42.1 -> 42ms. */
export function formatDuration(ms: number | undefined): string {
	if (ms === undefined || !Number.isFinite(ms)) return '—';
	if (ms < 1000) return `${Math.round(ms)}ms`;
	return `${(ms / 1000).toFixed(2)}s`;
}

/** Window presets offered on the page, with the period each resolves to. */
export const RANGE_PRESETS = [
	{ label: '1h', minutes: 60 },
	{ label: '24h', minutes: 24 * 60 },
	{ label: '7d', minutes: 7 * 24 * 60 },
	{ label: '30d', minutes: 30 * 24 * 60 },
] as const;

/**
 * A short sentence for an unavailable usage read.
 *
 * ACCESS_DENIED is called out by name because it is the failure most easily
 * mistaken for "my app has no traffic": the request succeeded, the charts are
 * blank, and nothing says the dashboard was simply not allowed to look.
 */
export function usageUnavailableTitle(code: string | undefined): string {
	switch (code) {
		case 'ACCESS_DENIED':
			return 'No CloudWatch metrics access';
		case 'CREDENTIALS_EXPIRED':
			return 'AWS credentials expired';
		case 'CREDENTIALS_MISSING':
			return 'No AWS credentials';
		case 'STACK_NOT_FOUND':
			return 'No deployed stack for this stage';
		default:
			return 'Usage data unavailable';
	}
}
