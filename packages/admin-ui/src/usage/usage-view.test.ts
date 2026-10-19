// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { DeploymentRecord, UsageSeriesInfo } from '../contract/v1.js';
import {
	buildChart,
	chartEmptyReason,
	compactNumber,
	deployCaption,
	deployMarkers,
	formatDuration,
	groupByResource,
	sparklinePoints,
	usageUnavailableTitle,
} from './usage-view.js';

/**
 * A series fixture.
 *
 * `empty` is DERIVED from the points rather than defaulted, because the
 * contract defines it as "CloudWatch returned no datapoints": a fixture
 * carrying points and `empty: true` is not a value the server can produce, and
 * writing one by accident tests behaviour that cannot happen. Pass `empty`
 * explicitly only to exercise a deliberately inconsistent payload.
 */
function series(overrides: Partial<UsageSeriesInfo> = {}): UsageSeriesInfo {
	const points = overrides.points ?? [];
	return {
		targetKey: 'AWS/Lambda|FunctionName=fn',
		targetLabel: 'fn',
		targetKind: 'function',
		metricName: 'Invocations',
		stat: 'Sum',
		namespace: 'AWS/Lambda',
		total: points.reduce((sum, p) => sum + p.value, 0),
		...(points.length === 0 ? { empty: true as const } : {}),
		...overrides,
		points,
	};
}

function points(values: Array<[string, number]>) {
	return values.map(([timestamp, value]) => ({ timestamp, value }));
}

describe('groupByResource', () => {
	it('gathers a resource’s metrics into one row', () => {
		const rows = groupByResource([
			series({ metricName: 'Invocations', total: 100, points: points([['2026-10-07T01:00:00Z', 100]]) }),
			series({ metricName: 'Errors', total: 3, points: points([['2026-10-07T01:00:00Z', 3]]) }),
			series({ metricName: 'Throttles', total: 1, points: points([['2026-10-07T01:00:00Z', 1]]) }),
			series({
				metricName: 'Duration',
				stat: 'Average',
				total: 50,
				points: points([['2026-10-07T01:00:00Z', 50]]),
			}),
		]);
		assert.equal(rows.length, 1);
		assert.equal(rows[0].invocations, 100);
		assert.equal(rows[0].errors, 4, 'errors and throttles both count as failures');
		assert.equal(rows[0].latencyMs, 50);
		assert.equal(rows[0].allEmpty, false);
	});

	it('keeps separate resources apart even in one namespace', () => {
		const rows = groupByResource([
			series({ targetKey: 'k1', targetLabel: 'a', total: 5, points: points([['t', 5]]) }),
			series({ targetKey: 'k2', targetLabel: 'b', total: 9, points: points([['t', 9]]) }),
		]);
		assert.deepEqual(
			rows.map((r) => r.label),
			['b', 'a'],
			'busiest first',
		);
	});

	it('sorts resources with no datapoints last but still returns them', () => {
		// "Deployed and never touched" is a finding; hiding it would make this
		// page disagree with the resources view.
		const rows = groupByResource([
			series({ targetKey: 'quiet', targetLabel: 'quiet' }),
			series({ targetKey: 'busy', targetLabel: 'busy', total: 1, points: points([['t', 1]]) }),
		]);
		assert.deepEqual(
			rows.map((r) => r.label),
			['busy', 'quiet'],
		);
		assert.equal(rows[1].allEmpty, true);
	});

	it('reports a resource as allEmpty only when every series is empty', () => {
		const rows = groupByResource([
			series({ targetKey: 'k', metricName: 'Invocations', empty: true }),
			series({ targetKey: 'k', metricName: 'Errors', points: points([['t', 0]]) }),
		]);
		assert.equal(rows[0].allEmpty, false, 'a zero-valued datapoint is still a datapoint');
	});

	it('carries the shared-dimensions flag onto the row', () => {
		const rows = groupByResource([series({ targetKind: 'api', sharedDimensions: true })]);
		assert.equal(rows[0].sharedDimensions, true);
	});

	it('does not mutate the series it was given', () => {
		const input = [series({ total: 1, points: points([['t', 1]]) })];
		const snapshot = JSON.stringify(input);
		groupByResource(input);
		assert.equal(JSON.stringify(input), snapshot);
	});
});

describe('buildChart', () => {
	it('sums invocations and errors per timestamp across resources', () => {
		const chart = buildChart([
			series({ targetKey: 'a', metricName: 'Invocations', points: points([['2026-10-07T01:00:00Z', 10]]) }),
			series({ targetKey: 'b', metricName: 'Count', points: points([['2026-10-07T01:00:00Z', 5]]) }),
			series({ targetKey: 'a', metricName: 'Errors', points: points([['2026-10-07T01:00:00Z', 2]]) }),
		]);
		assert.equal(chart.length, 1);
		assert.equal(chart[0].invocations, 15);
		assert.equal(chart[0].errors, 2);
	});

	it('ignores metrics that are neither counts nor errors', () => {
		// Averaging a latency into a request count would silently inflate it.
		const chart = buildChart([
			series({ metricName: 'Duration', stat: 'Average', points: points([['t1', 250]]) }),
			series({ metricName: 'Latency', stat: 'Average', points: points([['t1', 90]]) }),
		]);
		assert.deepEqual(chart, []);
	});

	it('orders buckets oldest first', () => {
		const chart = buildChart([
			series({
				metricName: 'Invocations',
				points: points([
					['2026-10-07T03:00:00Z', 3],
					['2026-10-07T01:00:00Z', 1],
				]),
			}),
		]);
		assert.deepEqual(
			chart.map((p) => p.invocations),
			[1, 3],
		);
	});

	it('leaves a gap as a gap rather than inventing a zero', () => {
		// A generated timeline would draw an absent bucket as zero traffic, which
		// is exactly the lie the server's `empty` flag exists to prevent.
		const chart = buildChart([
			series({
				metricName: 'Invocations',
				points: points([
					['2026-10-07T01:00:00Z', 1],
					['2026-10-07T05:00:00Z', 1],
				]),
			}),
		]);
		assert.equal(chart.length, 2);
	});
});

describe('deployMarkers', () => {
	const start = '2026-10-07T00:00:00Z';
	const end = '2026-10-07T12:00:00Z';
	function deploy(overrides: Partial<DeploymentRecord> = {}): DeploymentRecord {
		return {
			id: 'd1',
			stage: 'production',
			startedAt: '2026-10-07T06:00:00Z',
			status: 'SUCCEEDED',
			source: 'deploy-history',
			...overrides,
		};
	}

	it('positions a deploy as a fraction of the window', () => {
		const [marker] = deployMarkers([deploy()], 'production', start, end);
		assert.equal(marker.position, 0.5);
	});

	it('excludes a deploy from another stage', () => {
		assert.deepEqual(deployMarkers([deploy({ stage: 'sandbox' })], 'production', start, end), []);
	});

	it('excludes a deploy outside the window rather than clamping it to an edge', () => {
		// A clamped marker claims the deploy happened at the boundary, which
		// invites correlating a traffic change with the wrong release.
		const before = deploy({ id: 'before', startedAt: '2026-10-06T23:00:00Z' });
		const after = deploy({ id: 'after', startedAt: '2026-10-07T13:00:00Z' });
		assert.deepEqual(deployMarkers([before, after], 'production', start, end), []);
	});

	it('returns nothing when the window is unknown', () => {
		assert.deepEqual(deployMarkers([deploy()], 'production', undefined, end), []);
		assert.deepEqual(deployMarkers([deploy()], 'production', start, undefined), []);
	});

	it('returns nothing for a zero-length or inverted window', () => {
		assert.deepEqual(deployMarkers([deploy()], 'production', end, start), []);
		assert.deepEqual(deployMarkers([deploy()], 'production', start, start), []);
	});

	it('skips an unparseable timestamp instead of placing it at NaN', () => {
		assert.deepEqual(deployMarkers([deploy({ startedAt: 'not a date' })], 'production', start, end), []);
	});

	it('orders markers oldest first', () => {
		const markers = deployMarkers(
			[
				deploy({ id: 'late', startedAt: '2026-10-07T09:00:00Z' }),
				deploy({ id: 'early', startedAt: '2026-10-07T02:00:00Z' }),
			],
			'production',
			start,
			end,
		);
		assert.deepEqual(
			markers.map((m) => m.id),
			['early', 'late'],
		);
	});

	it('keeps a failed deploy, so a traffic drop can be matched to it', () => {
		const [marker] = deployMarkers([deploy({ status: 'FAILED' })], 'production', start, end);
		assert.equal(marker.status, 'FAILED');
	});

	it('positions against whatever window it is given, so a caller can pass the chart extent', () => {
		/*
		 * The page passes the CHART's first and last bucket rather than the
		 * requested window, because `buildChart` spans only where data exists.
		 * Positioning the same deploy against both ranges must give different
		 * fractions, which is what makes passing the wrong one a visible bug
		 * rather than a silent one.
		 */
		const deployment = deploy({ startedAt: '2026-10-07T06:00:00Z' });
		const againstWindow = deployMarkers([deployment], 'production', start, end)[0];
		const againstChart = deployMarkers([deployment], 'production', '2026-10-07T04:00:00Z', end)[0];
		assert.equal(againstWindow.position, 0.5);
		assert.equal(againstChart.position, 0.25);
	});
});

describe('deployCaption', () => {
	it('counts the markers it drew', () => {
		assert.equal(deployCaption(1, 1), '1 deploy marked');
		assert.equal(deployCaption(3, 3), '3 deploys marked');
	});

	it('does not claim no deploys happened when one is merely unmarkable', () => {
		// The real case: a deploy inside the requested 7 days but after the last
		// bucket CloudWatch returned. Drawing it would misplace it; saying "no
		// deploys" would discard it.
		const caption = deployCaption(0, 1);
		assert.match(caption, /1 deploy in this range/);
		assert.match(caption, /not marked/);
		assert.doesNotMatch(caption, /^No deploys/);
	});

	it('says none only when none happened in the range at all', () => {
		assert.equal(deployCaption(0, 0), 'No deploys in this range');
	});
});

describe('chartEmptyReason', () => {
	it('returns nothing when there is a line to draw', () => {
		const data = [
			series({
				metricName: 'Invocations',
				points: points([
					['2026-10-07T01:00:00Z', 1],
					['2026-10-07T02:00:00Z', 2],
				]),
			}),
		];
		assert.equal(chartEmptyReason(data, buildChart(data).length), undefined);
	});

	it('distinguishes an idle API from a missing stage when other metrics did report', () => {
		// The case that exposed the old wording: table metrics had 168
		// datapoints each while the page claimed it found nothing.
		const data = [
			series({ metricName: 'Invocations', targetKey: 'fn' }),
			series({
				metricName: 'ConsumedReadCapacityUnits',
				targetKey: 'tbl',
				targetKind: 'table',
				points: points([
					['2026-10-07T01:00:00Z', 2],
					['2026-10-07T02:00:00Z', 3],
				]),
			}),
		];
		const reason = chartEmptyReason(data, buildChart(data).length);
		assert.match(reason ?? '', /idle API rather than a missing stage/);
		assert.doesNotMatch(reason ?? '', /not enough datapoints/i);
	});

	it('says nothing was published when every series is empty', () => {
		const data = [series({ metricName: 'Invocations' }), series({ metricName: 'Errors' })];
		assert.match(chartEmptyReason(data, 0) ?? '', /no datapoints at all/);
	});

	it('says so when no resource publishes a request count', () => {
		const data = [series({ metricName: 'ConsumedReadCapacityUnits', targetKind: 'table' })];
		assert.match(chartEmptyReason(data, 0) ?? '', /publish a request count/);
	});

	it('asks for a longer range when only one bucket landed', () => {
		const data = [series({ metricName: 'Invocations', points: points([['2026-10-07T01:00:00Z', 5]]) })];
		assert.match(chartEmptyReason(data, 1) ?? '', /longer range/);
	});
});

describe('sparklinePoints', () => {
	it('normalises to the box and inverts the y axis', () => {
		// y=0 is the top of an SVG box, so the maximum must land at 0.
		assert.equal(sparklinePoints([0, 10], 100, 100), '0.00,100.00 100.00,0.00');
	});

	it('returns undefined below two points, so no NaN reaches the DOM', () => {
		assert.equal(sparklinePoints([]), undefined);
		assert.equal(sparklinePoints([5]), undefined);
	});

	it('draws an all-zero series flat instead of dividing by zero', () => {
		assert.equal(sparklinePoints([0, 0, 0], 100, 100), '0.00,100.00 50.00,100.00 100.00,100.00');
	});
});

describe('compactNumber', () => {
	it('shows small integers exactly', () => {
		assert.equal(compactNumber(0), '0');
		assert.equal(compactNumber(311), '311');
	});

	it('compacts thousands', () => {
		assert.equal(compactNumber(1234), '1.2K');
	});

	it('keeps a fractional capacity unit readable', () => {
		assert.equal(compactNumber(0.5), '0.50');
	});
});

describe('formatDuration', () => {
	it('uses milliseconds below a second and seconds above', () => {
		assert.equal(formatDuration(42.1), '42ms');
		assert.equal(formatDuration(1234.5), '1.23s');
	});

	it('renders an absent duration as a dash', () => {
		assert.equal(formatDuration(undefined), '—');
		assert.equal(formatDuration(Number.NaN), '—');
	});
});

describe('usageUnavailableTitle', () => {
	it('names an access denial rather than calling it missing data', () => {
		// The failure most easily mistaken for "my app has no traffic".
		assert.equal(usageUnavailableTitle('ACCESS_DENIED'), 'No CloudWatch metrics access');
	});

	it('falls back for an unknown code', () => {
		assert.equal(usageUnavailableTitle(undefined), 'Usage data unavailable');
		assert.equal(usageUnavailableTitle('SOMETHING_NEW'), 'Usage data unavailable');
	});
});
