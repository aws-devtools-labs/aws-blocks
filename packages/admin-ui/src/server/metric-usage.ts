// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import type { UsageCostEstimate, UsageTargetInfo } from '../contract/v1.js';
import { awsClientConfig } from './aws-config.js';
import { classifyEventsError } from './cfn-events.js';
import type { UsageResult } from './data-provider.js';
import { type MetricTarget, type MetricTargetKind, metricRegion, targetKey } from './metric-targets.js';

/**
 * Usage metrics (usage view): turns the discovered {@link MetricTarget}s into
 * GetMetricData queries, maps the response into time series, and PRICES the
 * request before it is made.
 *
 * WHY THE COST IS COMPUTED, NOT A CONSTANT
 *
 * GetMetricData is one of three CloudWatch operations the free tier explicitly
 * excludes: "1 Million API requests (not including GetMetricData,
 * GetInsightRuleReport and GetMetricWidgetImage: these 3 operations are always
 * charged)". So this view always costs something, however little, and the user
 * is entitled to the real figure for the request they are about to authorise
 * rather than a reassuring guess. {@link estimateCost} derives it from the
 * query set actually built, so the number on the consent screen cannot drift
 * away from the number on the bill when the metric list changes.
 *
 * The billed unit is a METRIC REQUESTED, not an API call: one metric carrying
 * up to five statistics counts once, and each further block of five counts
 * again. Every query here asks for exactly one statistic, so the count is the
 * number of queries, which is also what keeps the estimate auditable.
 */

/** $0.01 per 1,000 metrics requested (us-east-1 list price; varies by region). */
const USD_PER_1000_METRICS = 0.01;

/** Statistics per metric included in one billed metric request. */
const STATS_PER_BILLED_METRIC = 5;

/** A single GetMetricData call accepts at most 500 MetricDataQuery entries. */
export const MAX_QUERIES_PER_CALL = 500;

/**
 * Metrics requested per target kind, with the statistic each one needs.
 *
 * Chosen to answer "is it being used, is it failing, is it slow" and nothing
 * more: every extra metric here is money on every refresh, so the list is
 * deliberately short rather than exhaustive. `Sum` for counters (invocations,
 * requests, errors) because an average over a sparse series understates
 * traffic; `Average` for latencies and durations, where a sum is meaningless.
 */
const METRICS_BY_KIND: Record<MetricTargetKind, Array<{ name: string; stat: string; unit?: string }>> = {
	api: [
		{ name: 'Count', stat: 'Sum' },
		{ name: '4XXError', stat: 'Sum' },
		{ name: '5XXError', stat: 'Sum' },
		{ name: 'Latency', stat: 'Average' },
	],
	function: [
		{ name: 'Invocations', stat: 'Sum' },
		{ name: 'Errors', stat: 'Sum' },
		{ name: 'Throttles', stat: 'Sum' },
		{ name: 'Duration', stat: 'Average' },
	],
	table: [
		{ name: 'ConsumedReadCapacityUnits', stat: 'Sum' },
		{ name: 'ConsumedWriteCapacityUnits', stat: 'Sum' },
		// Dimensioned on the table alone, so it covers every operation.
		{ name: 'ThrottledRequests', stat: 'Sum' },
	],
	workflow: [
		{ name: 'ExecutionsStarted', stat: 'Sum' },
		{ name: 'ExecutionsFailed', stat: 'Sum' },
	],
	topic: [
		{ name: 'NumberOfMessagesPublished', stat: 'Sum' },
		{ name: 'NumberOfNotificationsFailed', stat: 'Sum' },
	],
	cdn: [
		{ name: 'Requests', stat: 'Sum' },
		{ name: 'TotalErrorRate', stat: 'Average' },
	],
};

/** Metric names that count requests, so a view can total "invocations". */
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

/** One metric to retrieve for one target, with the id that correlates it back. */
export interface MetricQuery {
	/** GetMetricData query id. Must match `^[a-z][a-zA-Z0-9_]*$`. */
	id: string;
	namespace: string;
	metricName: string;
	stat: string;
	dimensions: Array<{ name: string; value: string }>;
	/** Region this query must be sent to: CloudFront differs from the stack. */
	region: string;
	/** Key of the target this came from, so the response maps back to it. */
	targetKey: string;
	targetLabel: string;
	targetKind: MetricTargetKind;
	/** True when the target's dimensions are not stage-unique (see metric-targets). */
	sharedDimensions?: true;
}

/**
 * Resolution for a time range, honouring CloudWatch's own aggregation.
 *
 * CloudWatch aggregates on age (1-minute data for 15 days, 5-minute to 63 days,
 * 1-hour beyond), so asking for a finer period than the data's own resolution
 * returns gaps rather than detail. The period is therefore derived from the
 * range instead of being a caller's choice, which also bounds the datapoint
 * count per query well under the API's 100,800 ceiling.
 */
export function periodForRange(rangeMinutes: number): number {
	if (rangeMinutes <= 3 * 60) return 60;
	if (rangeMinutes <= 24 * 60) return 300;
	if (rangeMinutes <= 7 * 24 * 60) return 3600;
	return 86_400;
}

/** A GetMetricData query id: a stable, API-legal identifier per metric. */
export function queryId(index: number): string {
	return `m${index}`;
}

/**
 * Pure mapping: targets → the metric queries that describe them.
 *
 * Order is stable (target order, then the kind's metric order) so a query id
 * means the same thing across calls and the estimate shown to the user matches
 * the request later made.
 */
export function buildMetricQueries(targets: MetricTarget[], stackRegion: string): MetricQuery[] {
	const queries: MetricQuery[] = [];
	for (const target of targets) {
		const region = metricRegion(target, stackRegion);
		const key = targetKey(target);
		for (const metric of METRICS_BY_KIND[target.kind] ?? []) {
			queries.push({
				id: queryId(queries.length),
				namespace: target.namespace,
				metricName: metric.name,
				stat: metric.stat,
				dimensions: target.dimensions.map((d) => ({ name: d.name, value: d.value })),
				region,
				targetKey: key,
				targetLabel: target.label,
				targetKind: target.kind,
				...(target.sharedDimensions ? { sharedDimensions: true as const } : {}),
			});
		}
	}
	return queries;
}

/** What a usage refresh will cost, and the arithmetic behind it. */
export interface CostEstimate {
	/** Billed metric requests: the figure the rate applies to. */
	metricsRequested: number;
	/** GetMetricData calls needed, which is NOT the billed unit. */
	apiCalls: number;
	/** Estimated charge in USD. */
	usd: number;
	/** The rate used, so the view can cite it rather than restate it. */
	usdPer1000Metrics: number;
	/**
	 * True because GetMetricData is excluded from the CloudWatch free tier, so
	 * there is no allowance to fall inside. Present as a field rather than
	 * prose so the view cannot imply a free tier that does not apply.
	 */
	alwaysCharged: true;
}

/**
 * Prices a query set (pure).
 *
 * Statistics are billed in blocks of five PER METRIC, so the count groups
 * queries by metric first and then divides: one metric with nine statistics is
 * two billed requests, not nine. Every query built here asks for one
 * statistic, which makes the grouping a no-op today, and that is exactly why it
 * is written out rather than assumed. A later change that asks for several
 * statistics of one metric would otherwise silently overcharge the estimate.
 */
export function estimateCost(queries: MetricQuery[]): CostEstimate {
	const statsPerMetric = new Map<string, number>();
	for (const query of queries) {
		const key = `${query.region}|${query.namespace}|${query.metricName}|${query.targetKey}`;
		statsPerMetric.set(key, (statsPerMetric.get(key) ?? 0) + 1);
	}
	let metricsRequested = 0;
	for (const stats of statsPerMetric.values()) {
		metricsRequested += Math.ceil(stats / STATS_PER_BILLED_METRIC);
	}
	// Queries are split by region AND by the 500-per-call ceiling.
	const byRegion = new Map<string, number>();
	for (const query of queries) {
		byRegion.set(query.region, (byRegion.get(query.region) ?? 0) + 1);
	}
	let apiCalls = 0;
	for (const count of byRegion.values()) {
		apiCalls += Math.ceil(count / MAX_QUERIES_PER_CALL);
	}
	return {
		metricsRequested,
		apiCalls,
		usd: (metricsRequested / 1000) * USD_PER_1000_METRICS,
		usdPer1000Metrics: USD_PER_1000_METRICS,
		alwaysCharged: true,
	};
}

/** Formats an estimate for display, never rounding a real charge to `$0.00`. */
export function formatUsd(usd: number): string {
	if (usd === 0) return '$0.00';
	// Below a cent, two decimals would read as free. Show enough digits that a
	// small charge still looks like a charge.
	if (usd < 0.01) return `$${usd.toFixed(5).replace(/0+$/, '').replace(/\.$/, '')}`;
	return `$${usd.toFixed(2)}`;
}

/** One datapoint of a series. */
export interface UsagePoint {
	timestamp: string;
	value: number;
}

/** Raw shape consumed from GetMetricData MetricDataResults. */
export interface RawMetricDataResult {
	Id?: string;
	Label?: string;
	Timestamps?: Date[];
	Values?: number[];
	StatusCode?: string;
}

/** One metric's series, resolved back to the target it describes. */
export interface UsageSeries {
	targetKey: string;
	targetLabel: string;
	targetKind: MetricTargetKind;
	metricName: string;
	stat: string;
	namespace: string;
	/** Oldest first. Empty when the metric exists but has no datapoints. */
	points: UsagePoint[];
	/** Sum of the series, for counters; the view decides whether it is meaningful. */
	total: number;
	/** True when this series aggregates every stage sharing the dimensions. */
	sharedDimensions?: true;
	/**
	 * True when CloudWatch returned no datapoints. Distinct from a missing
	 * series: the metric was asked for and the answer was "nothing recorded",
	 * which the view must say rather than drawing a zero line.
	 */
	empty?: true;
}

/**
 * Pure mapping: GetMetricData results → series, correlated by query id.
 *
 * Points are SORTED by timestamp rather than reversed. CloudWatch's order
 * depends on `ScanBy`, and a reversal that assumes one direction silently
 * produces a backwards chart the day the other is used, so the order is
 * established here instead of inherited from the request.
 *
 * A result whose id is unknown is dropped: it cannot be attributed to a
 * target, and guessing would mislabel a chart.
 */
export function mapMetricData(results: RawMetricDataResult[], queries: MetricQuery[]): UsageSeries[] {
	const byId = new Map(queries.map((q) => [q.id, q]));
	const series: UsageSeries[] = [];

	for (const result of mergeByQueryId(results)) {
		const query = result.Id ? byId.get(result.Id) : undefined;
		if (!query) continue;
		const timestamps = result.Timestamps ?? [];
		const values = result.Values ?? [];
		const points: UsagePoint[] = [];
		// Pair by index, bounded by the shorter array: a truncated response must
		// not produce a point with a value and no time, or the reverse.
		for (let i = 0; i < Math.min(timestamps.length, values.length); i++) {
			const timestamp = timestamps[i];
			const value = values[i];
			if (timestamp === undefined || value === undefined) continue;
			points.push({ timestamp: new Date(timestamp).toISOString(), value });
		}
		points.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
		series.push({
			targetKey: query.targetKey,
			targetLabel: query.targetLabel,
			targetKind: query.targetKind,
			metricName: query.metricName,
			stat: query.stat,
			namespace: query.namespace,
			points,
			total: round4(points.reduce((sum, p) => sum + p.value, 0)),
			...(query.sharedDimensions ? { sharedDimensions: true as const } : {}),
			...(points.length === 0 ? { empty: true as const } : {}),
		});
	}

	return series;
}

/**
 * Concatenates results that share a query id into one.
 *
 * GetMetricData paginates by returning FURTHER DATAPOINTS FOR THE SAME ids, so
 * the pages of one query arrive as several results carrying one id. Treating
 * them as separate results would emit duplicate series for one metric and
 * total only the last page, which reads as a sudden drop in traffic.
 */
function mergeByQueryId(results: RawMetricDataResult[]): RawMetricDataResult[] {
	const merged = new Map<string, RawMetricDataResult>();
	const order: string[] = [];
	for (const result of results) {
		if (!result.Id) continue;
		const existing = merged.get(result.Id);
		if (!existing) {
			order.push(result.Id);
			merged.set(result.Id, {
				...result,
				Timestamps: [...(result.Timestamps ?? [])],
				Values: [...(result.Values ?? [])],
			});
			continue;
		}
		existing.Timestamps?.push(...(result.Timestamps ?? []));
		existing.Values?.push(...(result.Values ?? []));
	}
	return order.map((id) => merged.get(id) as RawMetricDataResult);
}

function round4(n: number): number {
	return Math.round(n * 10_000) / 10_000;
}

/** Headline figures across every series (pure). */
export interface UsageTotals {
	invocations: number;
	errors: number;
	/** Series that returned no datapoints at all. */
	emptySeries: number;
	seriesCount: number;
	/** True when any contributing series aggregates more than this stage. */
	includesSharedDimensions?: true;
}

/**
 * Totals the series into headline numbers.
 *
 * `includesSharedDimensions` exists so a summary tile can never present a
 * figure as this environment's when a contributing series covers every stage.
 * It is set from the series that actually feed the totals, not from the whole
 * set, so an unused shared series does not taint an otherwise exact figure.
 */
export function summarise(series: UsageSeries[]): UsageTotals {
	let invocations = 0;
	let errors = 0;
	let emptySeries = 0;
	let shared = false;
	for (const s of series) {
		if (s.empty) emptySeries++;
		const counts = INVOCATION_METRICS.has(s.metricName);
		const fails = ERROR_METRICS.has(s.metricName);
		if (counts) invocations += s.total;
		if (fails) errors += s.total;
		if ((counts || fails) && s.sharedDimensions) shared = true;
	}
	return {
		invocations: round4(invocations),
		errors: round4(errors),
		emptySeries,
		seriesCount: series.length,
		...(shared ? { includesSharedDimensions: true as const } : {}),
	};
}

/**
 * Projects a priced query set onto the contract's estimate shape (pure).
 *
 * The formatted figure is produced HERE rather than in the view, so every
 * surface shows the same string and none of them can re-round a sub-cent
 * charge into `$0.00`. See {@link formatUsd}.
 */
export function toUsageEstimate(estimate: CostEstimate): UsageCostEstimate {
	return {
		metricsRequested: estimate.metricsRequested,
		apiCalls: estimate.apiCalls,
		usd: estimate.usd,
		usdFormatted: formatUsd(estimate.usd),
		usdPer1000Metrics: estimate.usdPer1000Metrics,
		alwaysCharged: estimate.alwaysCharged,
	};
}

/**
 * Summarises the targets for the consent screen (pure).
 *
 * `metricCount` is counted from the QUERIES, not from the metric table, so the
 * per-target numbers add up to the figure being charged for. A target with no
 * queries is still listed: "this resource is deployed and nothing about it is
 * being measured" is information, and silently dropping it would make the
 * inventory disagree with the resources view.
 */
export function toUsageTargets(targets: MetricTarget[], queries: MetricQuery[]): UsageTargetInfo[] {
	const counts = new Map<string, number>();
	const regions = new Map<string, string>();
	for (const query of queries) {
		counts.set(query.targetKey, (counts.get(query.targetKey) ?? 0) + 1);
		regions.set(query.targetKey, query.region);
	}
	return targets.map((target) => {
		const key = targetKey(target);
		return {
			kind: target.kind,
			label: target.label,
			namespace: target.namespace,
			metricCount: counts.get(key) ?? 0,
			region: regions.get(key) ?? '',
			...(target.sharedDimensions ? { sharedDimensions: true as const } : {}),
			...(target.sharedReason ? { sharedReason: target.sharedReason } : {}),
		};
	});
}

/**
 * Classifies a usage failure for the contract's error code (pure).
 *
 * Delegates to {@link classifyEventsError} for the credential and
 * stack-not-found cases rather than restating those patterns, and adds the one
 * it does not cover: ACCESS_DENIED. That case matters more here than anywhere
 * else in the dashboard, because `cloudwatch:GetMetricData` is a permission a
 * read-only role can plausibly lack while every other pillar still works, and
 * "you cannot read metrics" must not be reported as "your app has no traffic".
 */
export function classifyUsageError(error: unknown): NonNullable<UsageResult['usageErrorCode']> {
	const haystack = error instanceof Error ? `${error.name} ${error.message}` : String(error);
	if (/AccessDenied|not authorized|UnauthorizedOperation/i.test(haystack)) return 'ACCESS_DENIED';
	return classifyEventsError(error);
}

/** Splits queries into per-region batches within the 500-per-call ceiling (pure). */
export function batchQueries(queries: MetricQuery[]): Array<{ region: string; queries: MetricQuery[] }> {
	const byRegion = new Map<string, MetricQuery[]>();
	for (const query of queries) {
		const existing = byRegion.get(query.region);
		if (existing) existing.push(query);
		else byRegion.set(query.region, [query]);
	}
	const batches: Array<{ region: string; queries: MetricQuery[] }> = [];
	for (const [region, regionQueries] of byRegion) {
		for (let i = 0; i < regionQueries.length; i += MAX_QUERIES_PER_CALL) {
			batches.push({ region, queries: regionQueries.slice(i, i + MAX_QUERIES_PER_CALL) });
		}
	}
	return batches;
}

/**
 * The MetricDataQuery shape this module builds.
 *
 * Declared locally and structurally compatible with the SDK's own
 * `MetricDataQuery`, rather than importing that type or widening the return to
 * `Record<string, unknown>`. The SDK is loaded by dynamic import at the edge
 * (as every other fetcher in this package does), so a top-level type import
 * would be the only static dependency on it; and the loose record would not
 * type-check against `send()`, which is a real mismatch rather than something
 * to cast away.
 */
export interface GetMetricDataQuery {
	Id: string;
	MetricStat: {
		Metric: {
			Namespace: string;
			MetricName: string;
			Dimensions: Array<{ Name: string; Value: string }>;
		};
		Period: number;
		Stat: string;
	};
	ReturnData: boolean;
}

/** The GetMetricData request body for one batch (pure, so it is assertable). */
export function toGetMetricDataInput(
	queries: MetricQuery[],
	start: Date,
	end: Date,
	period: number,
): {
	StartTime: Date;
	EndTime: Date;
	ScanBy: 'TimestampAscending';
	MetricDataQueries: GetMetricDataQuery[];
} {
	return {
		StartTime: start,
		EndTime: end,
		// Ascending so pagination truncates the OLDEST data rather than the
		// newest, which is the half a usage view actually needs.
		ScanBy: 'TimestampAscending',
		MetricDataQueries: queries.map((query) => ({
			Id: query.id,
			MetricStat: {
				Metric: {
					Namespace: query.namespace,
					MetricName: query.metricName,
					Dimensions: query.dimensions.map((d) => ({ Name: d.name, Value: d.value })),
				},
				Period: period,
				Stat: query.stat,
			},
			ReturnData: true,
		})),
	};
}

/**
 * Runs the batches and returns every result.
 *
 * Throws on AWS errors, like the other fetchers in this package: a usage view
 * that silently returns an empty chart on AccessDenied is indistinguishable
 * from an app with no traffic, and the route needs the error to say which.
 */
export async function fetchMetricData(
	queries: MetricQuery[],
	start: Date,
	end: Date,
	period: number,
): Promise<RawMetricDataResult[]> {
	if (queries.length === 0) return [];
	const { CloudWatchClient, GetMetricDataCommand } = await import('@aws-sdk/client-cloudwatch');
	const results: RawMetricDataResult[] = [];

	for (const batch of batchQueries(queries)) {
		const client = new CloudWatchClient(awsClientConfig(batch.region));
		const input = toGetMetricDataInput(batch.queries, start, end, period);
		let nextToken: string | undefined;
		do {
			const response = await client.send(
				new GetMetricDataCommand({ ...input, ...(nextToken ? { NextToken: nextToken } : {}) }),
			);
			results.push(...(response.MetricDataResults ?? []));
			nextToken = response.NextToken;
		} while (nextToken);
	}

	return results;
}
