// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { MetricTarget } from './metric-targets.js';
import {
	MAX_QUERIES_PER_CALL,
	type MetricQuery,
	type RawMetricDataResult,
	batchQueries,
	buildMetricQueries,
	classifyUsageError,
	estimateCost,
	formatUsd,
	mapMetricData,
	periodForRange,
	queryId,
	summarise,
	toGetMetricDataInput,
	toUsageEstimate,
	toUsageTargets,
} from './metric-usage.js';

const STACK_REGION = 'eu-west-1';

function target(overrides: Partial<MetricTarget> = {}): MetricTarget {
	return {
		namespace: 'AWS/DynamoDB',
		dimensions: [{ name: 'TableName', value: 'rota-3a4f18-prod-rota-staff' }],
		kind: 'table',
		label: 'rota-staff',
		logicalResourceId: 'StaffTable',
		resourceType: 'AWS::DynamoDB::Table',
		...overrides,
	};
}

const REST_API_TARGET = target({
	namespace: 'AWS/ApiGateway',
	dimensions: [
		{ name: 'ApiName', value: 'Blocks API' },
		{ name: 'Stage', value: 'prod' },
	],
	kind: 'api',
	label: 'Blocks API',
	resourceType: 'AWS::ApiGateway::RestApi',
	sharedDimensions: true,
	sharedReason: 'shared across stages',
});

const CDN_TARGET = target({
	namespace: 'AWS/CloudFront',
	dimensions: [
		{ name: 'DistributionId', value: 'E3GGZTOE6OVVS9' },
		{ name: 'Region', value: 'Global' },
	],
	kind: 'cdn',
	label: 'E3GGZTOE6OVVS9',
	resourceType: 'AWS::CloudFront::Distribution',
});

describe('buildMetricQueries', () => {
	it('builds one query per metric of the kind, with unique ids', () => {
		const queries = buildMetricQueries([target()], STACK_REGION);
		assert.equal(queries.length, 3); // table: read, write, throttles
		assert.deepEqual(
			queries.map((q) => q.metricName),
			['ConsumedReadCapacityUnits', 'ConsumedWriteCapacityUnits', 'ThrottledRequests'],
		);
		assert.equal(new Set(queries.map((q) => q.id)).size, queries.length);
	});

	it('uses API-legal query ids', () => {
		const queries = buildMetricQueries([target(), REST_API_TARGET], STACK_REGION);
		for (const query of queries) {
			assert.match(query.id, /^[a-z][a-zA-Z0-9_]*$/, `illegal GetMetricData id: ${query.id}`);
		}
	});

	it('sums counters and averages latencies, never the reverse', () => {
		const queries = buildMetricQueries([REST_API_TARGET], STACK_REGION);
		const stat = (name: string) => queries.find((q) => q.metricName === name)?.stat;
		assert.equal(stat('Count'), 'Sum');
		assert.equal(stat('5XXError'), 'Sum');
		assert.equal(stat('Latency'), 'Average');
	});

	it('sends CloudFront queries to us-east-1 and the rest to the stack region', () => {
		const queries = buildMetricQueries([target(), CDN_TARGET], STACK_REGION);
		const regions = new Map(queries.map((q) => [q.targetKind, q.region]));
		assert.equal(regions.get('table'), 'eu-west-1');
		assert.equal(regions.get('cdn'), 'us-east-1');
	});

	it('carries the shared-dimensions flag onto every query of that target', () => {
		const queries = buildMetricQueries([REST_API_TARGET, target()], STACK_REGION);
		const api = queries.filter((q) => q.targetKind === 'api');
		const table = queries.filter((q) => q.targetKind === 'table');
		assert.ok(api.length > 0);
		assert.ok(api.every((q) => q.sharedDimensions === true));
		assert.ok(table.every((q) => q.sharedDimensions === undefined));
	});

	it('copies the dimensions rather than aliasing the target', () => {
		const t = target();
		const [query] = buildMetricQueries([t], STACK_REGION);
		query.dimensions[0].value = 'mutated';
		assert.equal(t.dimensions[0].value, 'rota-3a4f18-prod-rota-staff');
	});
});

describe('estimateCost', () => {
	it('prices by metrics requested at $0.01 per 1,000', () => {
		const queries = buildMetricQueries([target()], STACK_REGION);
		const estimate = estimateCost(queries);
		assert.equal(estimate.metricsRequested, 3);
		assert.equal(estimate.usdPer1000Metrics, 0.01);
		assert.equal(estimate.usd, (3 / 1000) * 0.01);
	});

	it('never claims a free tier, because GetMetricData has none', () => {
		assert.equal(estimateCost(buildMetricQueries([target()], STACK_REGION)).alwaysCharged, true);
	});

	it('bills five statistics of one metric as a single metric request', () => {
		// The billed unit is a metric, not a statistic: up to five statistics of
		// one metric count once. Five queries for ONE metric must therefore cost
		// the same as one.
		const base = buildMetricQueries([target()], STACK_REGION)[0];
		const fiveStats: MetricQuery[] = ['Sum', 'Average', 'Minimum', 'Maximum', 'SampleCount'].map((stat, i) => ({
			...base,
			id: `m${i}`,
			stat,
		}));
		assert.equal(estimateCost(fiveStats).metricsRequested, 1);
	});

	it('bills a sixth statistic of one metric as a second metric request', () => {
		const base = buildMetricQueries([target()], STACK_REGION)[0];
		const sixStats: MetricQuery[] = Array.from({ length: 6 }, (_, i) => ({
			...base,
			id: `m${i}`,
			stat: `s${i}`,
		}));
		assert.equal(estimateCost(sixStats).metricsRequested, 2);
	});

	it('counts API calls per region, which is not the billed unit', () => {
		const estimate = estimateCost(buildMetricQueries([target(), CDN_TARGET], STACK_REGION));
		// Two regions => two calls, but the charge follows metrics requested.
		assert.equal(estimate.apiCalls, 2);
		assert.equal(estimate.metricsRequested, 5); // 3 table + 2 cdn
	});

	it('splits one region into several calls past the 500-query ceiling', () => {
		const base = buildMetricQueries([target()], STACK_REGION)[0];
		const many: MetricQuery[] = Array.from({ length: MAX_QUERIES_PER_CALL + 1 }, (_, i) => ({
			...base,
			id: `m${i}`,
			metricName: `Metric${i}`,
		}));
		assert.equal(estimateCost(many).apiCalls, 2);
	});

	it('prices an empty query set at nothing', () => {
		const estimate = estimateCost([]);
		assert.equal(estimate.metricsRequested, 0);
		assert.equal(estimate.usd, 0);
		assert.equal(estimate.apiCalls, 0);
	});
});

describe('queryId', () => {
	it('produces a GetMetricData-legal id', () => {
		// The API requires `^[a-z][a-zA-Z0-9_]*$`; a leading digit is rejected by
		// CloudWatch at request time, not by anything here.
		for (const index of [0, 1, 42, 499]) {
			assert.match(queryId(index), /^[a-z][a-zA-Z0-9_]*$/);
		}
	});

	it('is unique per index', () => {
		const ids = new Set(Array.from({ length: 500 }, (_, i) => queryId(i)));
		assert.equal(ids.size, 500);
	});
});

describe('toUsageEstimate', () => {
	it('formats the charge once, so every surface shows the same string', () => {
		const estimate = toUsageEstimate(estimateCost(buildMetricQueries([target()], STACK_REGION)));
		assert.equal(estimate.metricsRequested, 3);
		assert.equal(estimate.usd, 0.00003);
		assert.equal(estimate.usdFormatted, '$0.00003');
		assert.equal(estimate.alwaysCharged, true);
		assert.equal(estimate.usdPer1000Metrics, 0.01);
	});

	it('carries a zero estimate through as $0.00', () => {
		const estimate = toUsageEstimate(estimateCost([]));
		assert.equal(estimate.usd, 0);
		assert.equal(estimate.usdFormatted, '$0.00');
	});
});

describe('toUsageTargets', () => {
	it('per-target metric counts sum to the figure being charged for', () => {
		/*
		 * The consent screen shows both: a per-kind breakdown and one total
		 * charge. If they disagree the screen is lying about one of them, and
		 * the reader has no way to tell which.
		 */
		const targets = [target(), REST_API_TARGET, CDN_TARGET];
		const queries = buildMetricQueries(targets, STACK_REGION);
		const infos = toUsageTargets(targets, queries);
		const summed = infos.reduce((sum, t) => sum + t.metricCount, 0);
		assert.equal(summed, estimateCost(queries).metricsRequested);
	});

	it('reports the region each target is actually read from', () => {
		const targets = [target(), CDN_TARGET];
		const infos = toUsageTargets(targets, buildMetricQueries(targets, STACK_REGION));
		assert.equal(infos.find((t) => t.kind === 'table')?.region, 'eu-west-1');
		assert.equal(infos.find((t) => t.kind === 'cdn')?.region, 'us-east-1');
	});

	it('carries the shared-dimensions reason verbatim', () => {
		const infos = toUsageTargets([REST_API_TARGET], buildMetricQueries([REST_API_TARGET], STACK_REGION));
		assert.equal(infos[0].sharedDimensions, true);
		assert.equal(infos[0].sharedReason, REST_API_TARGET.sharedReason);
	});

	it('lists a target that contributes no metrics rather than dropping it', () => {
		// "Deployed and not measured" is information; a silently shorter
		// inventory would disagree with the resources view.
		const infos = toUsageTargets([target()], []);
		assert.equal(infos.length, 1);
		assert.equal(infos[0].metricCount, 0);
	});
});

describe('classifyUsageError', () => {
	it('names an access denial, which no other classifier covers', () => {
		// The failure most easily mistaken for "my app has no traffic".
		const denied = new Error('User is not authorized to perform cloudwatch:GetMetricData');
		denied.name = 'AccessDeniedException';
		assert.equal(classifyUsageError(denied), 'ACCESS_DENIED');
		assert.equal(classifyUsageError(new Error('UnauthorizedOperation')), 'ACCESS_DENIED');
	});

	it('delegates the credential cases rather than restating their patterns', () => {
		const expired = new Error('The security token included in the request is expired');
		expired.name = 'ExpiredTokenException';
		assert.equal(classifyUsageError(expired), 'CREDENTIALS_EXPIRED');
		assert.equal(
			classifyUsageError(new Error('Could not load credentials from any providers')),
			'CREDENTIALS_MISSING',
		);
	});

	it('delegates stack-not-found', () => {
		assert.equal(classifyUsageError(new Error('Stack with id my-stack does not exist')), 'STACK_NOT_FOUND');
	});

	it('falls back to UNKNOWN, including for a non-Error', () => {
		assert.equal(classifyUsageError(new Error('socket hang up')), 'UNKNOWN');
		assert.equal(classifyUsageError('a string'), 'UNKNOWN');
		assert.equal(classifyUsageError(undefined), 'UNKNOWN');
	});
});

describe('formatUsd', () => {
	it('does not render a real charge as $0.00', () => {
		// The whole point of the consent screen: a sub-cent charge must still
		// look like a charge, or the gate is theatre.
		assert.notEqual(formatUsd(0.00029), '$0.00');
		assert.equal(formatUsd(0.00029), '$0.00029');
	});

	it('renders exactly zero as $0.00', () => {
		assert.equal(formatUsd(0), '$0.00');
	});

	it('renders a cent or more with two decimals', () => {
		assert.equal(formatUsd(0.01), '$0.01');
		assert.equal(formatUsd(1.5), '$1.50');
	});
});

describe('periodForRange', () => {
	it('matches CloudWatch resolution tiers rather than asking for finer data', () => {
		assert.equal(periodForRange(60), 60);
		assert.equal(periodForRange(24 * 60), 300);
		assert.equal(periodForRange(7 * 24 * 60), 3600);
		assert.equal(periodForRange(30 * 24 * 60), 86_400);
	});

	it('keeps datapoints per query well under the API ceiling', () => {
		for (const minutes of [60, 3 * 60, 24 * 60, 7 * 24 * 60, 30 * 24 * 60, 90 * 24 * 60]) {
			const points = (minutes * 60) / periodForRange(minutes);
			assert.ok(points <= 100_800, `${minutes}m yields ${points} datapoints`);
		}
	});
});

describe('batchQueries', () => {
	it('groups by region so each batch targets one endpoint', () => {
		const batches = batchQueries(buildMetricQueries([target(), CDN_TARGET], STACK_REGION));
		assert.deepEqual(batches.map((b) => b.region).sort(), ['eu-west-1', 'us-east-1']);
		for (const batch of batches) {
			assert.ok(batch.queries.every((q) => q.region === batch.region));
		}
	});

	it('never exceeds the per-call ceiling', () => {
		const base = buildMetricQueries([target()], STACK_REGION)[0];
		const many: MetricQuery[] = Array.from({ length: 1201 }, (_, i) => ({ ...base, id: `m${i}` }));
		const batches = batchQueries(many);
		assert.equal(batches.length, 3);
		assert.ok(batches.every((b) => b.queries.length <= MAX_QUERIES_PER_CALL));
		assert.equal(
			batches.reduce((sum, b) => sum + b.queries.length, 0),
			1201,
		);
	});

	it('returns nothing for no queries', () => {
		assert.deepEqual(batchQueries([]), []);
	});
});

describe('toGetMetricDataInput', () => {
	const start = new Date('2026-10-07T00:00:00Z');
	const end = new Date('2026-10-07T12:00:00Z');

	it('scans ascending so pagination truncates the oldest data, not the newest', () => {
		const input = toGetMetricDataInput(buildMetricQueries([target()], STACK_REGION), start, end, 300);
		assert.equal(input.ScanBy, 'TimestampAscending');
	});

	it('carries namespace, dimensions, stat and period into the request', () => {
		const queries = buildMetricQueries([REST_API_TARGET], STACK_REGION);
		const input = toGetMetricDataInput(queries, start, end, 300);
		const first = input.MetricDataQueries[0];
		assert.equal(first.Id, queries[0].id);
		assert.equal(first.MetricStat.Metric.Namespace, 'AWS/ApiGateway');
		assert.deepEqual(first.MetricStat.Metric.Dimensions, [
			{ Name: 'ApiName', Value: 'Blocks API' },
			{ Name: 'Stage', Value: 'prod' },
		]);
		assert.equal(first.MetricStat.Period, 300);
		assert.equal(first.MetricStat.Stat, 'Sum');
	});
});

describe('mapMetricData', () => {
	const queries = buildMetricQueries([target()], STACK_REGION);

	it('correlates a result back to its target by query id', () => {
		const results: RawMetricDataResult[] = [
			{
				Id: queries[0].id,
				Timestamps: [new Date('2026-10-07T01:00:00Z'), new Date('2026-10-07T02:00:00Z')],
				Values: [2, 3],
			},
		];
		const [s] = mapMetricData(results, queries);
		assert.equal(s.targetLabel, 'rota-staff');
		assert.equal(s.metricName, 'ConsumedReadCapacityUnits');
		assert.equal(s.total, 5);
	});

	it('orders points oldest-first regardless of the order received', () => {
		const descending: RawMetricDataResult[] = [
			{
				Id: queries[0].id,
				Timestamps: [new Date('2026-10-07T03:00:00Z'), new Date('2026-10-07T01:00:00Z')],
				Values: [9, 1],
			},
		];
		const [s] = mapMetricData(descending, queries);
		assert.deepEqual(
			s.points.map((p) => p.value),
			[1, 9],
		);
	});

	it('merges paginated pages of one query instead of duplicating the series', () => {
		// GetMetricData paginates by returning MORE DATAPOINTS FOR THE SAME id.
		// Treating the pages as separate results would emit two series for one
		// metric and total only the last page, reading as a drop in traffic.
		const paged: RawMetricDataResult[] = [
			{ Id: queries[0].id, Timestamps: [new Date('2026-10-07T01:00:00Z')], Values: [4] },
			{ Id: queries[0].id, Timestamps: [new Date('2026-10-07T02:00:00Z')], Values: [6] },
		];
		const series = mapMetricData(paged, queries);
		assert.equal(series.length, 1);
		assert.equal(series[0].points.length, 2);
		assert.equal(series[0].total, 10);
	});

	it('marks a metric with no datapoints as empty, not as zero', () => {
		// "Nothing recorded" and "zero traffic" look identical on a chart; only
		// the flag lets the view say which it is.
		const [s] = mapMetricData([{ Id: queries[0].id, Timestamps: [], Values: [] }], queries);
		assert.equal(s.empty, true);
		assert.deepEqual(s.points, []);
		assert.equal(s.total, 0);
	});

	it('does not mark a series with datapoints as empty', () => {
		const [s] = mapMetricData(
			[{ Id: queries[0].id, Timestamps: [new Date('2026-10-07T01:00:00Z')], Values: [0] }],
			queries,
		);
		assert.equal(s.empty, undefined);
	});

	it('drops a result whose id matches no query', () => {
		const series = mapMetricData([{ Id: 'unknown', Timestamps: [new Date()], Values: [1] }], queries);
		assert.deepEqual(series, []);
	});

	it('ignores a value with no matching timestamp', () => {
		const [s] = mapMetricData(
			[{ Id: queries[0].id, Timestamps: [new Date('2026-10-07T01:00:00Z')], Values: [1, 2, 3] }],
			queries,
		);
		assert.equal(s.points.length, 1);
		assert.equal(s.total, 1);
	});
});

describe('summarise', () => {
	it('totals invocations and errors separately', () => {
		const queries = buildMetricQueries([target({ kind: 'function', namespace: 'AWS/Lambda' })], STACK_REGION);
		const results: RawMetricDataResult[] = queries.map((q, i) => ({
			Id: q.id,
			Timestamps: [new Date('2026-10-07T01:00:00Z')],
			Values: [[100, 5, 2, 42][i]],
		}));
		const totals = summarise(mapMetricData(results, queries));
		assert.equal(totals.invocations, 100);
		assert.equal(totals.errors, 7); // Errors 5 + Throttles 2; Duration excluded
	});

	it('flags totals that include a stage-spanning series', () => {
		const queries = buildMetricQueries([REST_API_TARGET], STACK_REGION);
		const results = queries.map((q) => ({
			Id: q.id,
			Timestamps: [new Date('2026-10-07T01:00:00Z')],
			Values: [1],
		}));
		assert.equal(summarise(mapMetricData(results, queries)).includesSharedDimensions, true);
	});

	it('does not flag totals drawn only from stage-unique series', () => {
		const queries = buildMetricQueries([target()], STACK_REGION);
		const results = queries.map((q) => ({
			Id: q.id,
			Timestamps: [new Date('2026-10-07T01:00:00Z')],
			Values: [1],
		}));
		assert.equal(summarise(mapMetricData(results, queries)).includesSharedDimensions, undefined);
	});

	it('counts the series that returned nothing', () => {
		const queries = buildMetricQueries([target()], STACK_REGION);
		const results = queries.map((q) => ({ Id: q.id, Timestamps: [], Values: [] }));
		const totals = summarise(mapMetricData(results, queries));
		assert.equal(totals.emptySeries, 3);
		assert.equal(totals.seriesCount, 3);
	});
});
