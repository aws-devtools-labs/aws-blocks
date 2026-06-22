// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for the OTLP/PromQL Dashboard extension: the PromqlWidget JSON shape and the
 * OTLP branch in resolveConfig/buildDashboardWidgets. Classic CloudWatch metrics must
 * remain on the GraphWidget path (regression guard).
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import {
	PromqlWidget,
	buildPromqlMetricsWidgets,
	buildDashboardWidgets,
	resolveConfig,
} from './widgets.js';
import type { DashboardOptions } from './types.js';

describe('PromqlWidget', () => {
	it('emits a type:chart widget with a PromQL cloudwatch-metrics query', () => {
		const json = new PromqlWidget({ title: 'Reqs', query: 'sum({"http.requests"})', region: 'us-east-1' }).toJson();
		assert.equal(json.length, 1);
		const w = json[0];
		assert.equal(w.type, 'chart');
		const q = w.properties.data.queries[0];
		assert.equal(q.type, 'cloudwatch-metrics');
		assert.equal(q.language, 'PromQL');
		assert.equal(q.query, 'sum({"http.requests"})');
	});

	it('supports the number view for single-value tiles', () => {
		const w = new PromqlWidget({ title: 'T', query: 'sum({"x"})', region: 'us-east-1', view: 'number' }).toJson()[0];
		assert.equal(w.properties.view, 'number');
	});
});

describe('buildPromqlMetricsWidgets', () => {
	it('builds a query per metric selecting by name; respects promql override', () => {
		const rows = buildPromqlMetricsWidgets(
			[{ name: 'http.requests' }, { name: 'latency', promql: 'histogram_quantile(0.99, {"latency"})' }],
			'us-east-1',
		);
		const widgets = rows.flat();
		assert.equal(widgets.length, 2);
		const q0 = (widgets[0] as PromqlWidget).toJson()[0].properties.data.queries[0].query;
		const q1 = (widgets[1] as PromqlWidget).toJson()[0].properties.data.queries[0].query;
		assert.equal(q0, 'sum({"http.requests"})');
		assert.equal(q1, 'histogram_quantile(0.99, {"latency"})');
	});

	it('folds default dimensions into the selector as label matchers', () => {
		const rows = buildPromqlMetricsWidgets([{ name: 'reqs' }], 'us-east-1', { service: 'orders' });
		const q = (rows.flat()[0] as PromqlWidget).toJson()[0].properties.data.queries[0].query;
		assert.match(q, /service="orders"/);
		assert.match(q, /"reqs"/);
	});
});

describe('resolveConfig / buildDashboardWidgets — metricsKind routing', () => {
	it('defaults metricsKind to cloudwatch (existing Metrics unaffected)', () => {
		const cfg = resolveConfig('dash', { metrics: { namespace: 'App/NS' } } as DashboardOptions, 'fn');
		assert.equal(cfg.metricsKind, 'cloudwatch');
	});

	it('routes otlp metrics through PromQL chart widgets', () => {
		const options: DashboardOptions = {
			metrics: { namespace: 'svc', metricsKind: 'otlp' } as any,
			metricConfigs: [{ name: 'http.requests' }],
		};
		const cfg = resolveConfig('dash', options, 'fn');
		assert.equal(cfg.metricsKind, 'otlp');
		const rows = buildDashboardWidgets(cfg, 'fn', 'us-east-1');
		const json = rows.flat().flatMap(w => (w as any).toJson?.() ?? []);
		const hasPromqlChart = json.some((j: any) => j.type === 'chart' && j.properties?.data?.queries?.[0]?.language === 'PromQL');
		assert.ok(hasPromqlChart, 'expected a PromQL chart widget for otlp metrics');
		// And NO classic metric widget in the metrics section.
		const hasMetricGraph = json.some((j: any) => j.type === 'metric' && JSON.stringify(j).includes('http.requests'));
		assert.ok(!hasMetricGraph, 'otlp metrics must not produce a classic metric widget');
	});

	it('renders PromQL widgets for an OTLP metrics ref with NO namespace (OtelMetrics shape)', () => {
		// Regression: OtelMetrics has no `namespace`; the metrics section must still render.
		const options: DashboardOptions = {
			metrics: { metricsKind: 'otlp' } as any, // no namespace, like OtelMetrics
			metricConfigs: [{ name: 'orders.placed' }],
		};
		const cfg = resolveConfig('dash', options, 'fn');
		assert.equal(cfg.metricsEnabled, true);
		const json = buildDashboardWidgets(cfg, 'fn', 'us-east-1').flat().flatMap(w => (w as any).toJson?.() ?? []);
		const hasPromqlChart = json.some((j: any) => j.type === 'chart' && j.properties?.data?.queries?.[0]?.language === 'PromQL');
		assert.ok(hasPromqlChart, 'OTLP metrics without a namespace must still render PromQL widgets');
	});

	it('classic cloudwatch metrics still produce metric GraphWidgets', () => {
		const options: DashboardOptions = {
			metrics: { namespace: 'App/NS' },
			metricConfigs: [{ name: 'RequestCount' }],
		};
		const cfg = resolveConfig('dash', options, 'fn');
		const rows = buildDashboardWidgets(cfg, 'fn', 'us-east-1');
		const json = rows.flat().flatMap(w => (w as any).toJson?.() ?? []);
		const hasMetric = json.some((j: any) => j.type === 'metric');
		assert.ok(hasMetric, 'cloudwatch metrics should still render metric widgets');
	});
});
