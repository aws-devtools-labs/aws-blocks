// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import type { RawStackResource } from './log-groups.js';
import { LocalDataProvider } from './local-provider.js';
import type { MetricQuery, RawMetricDataResult } from './metric-usage.js';

/*
 * The gate's guarantee is behavioural, not textual: an unconfirmed request must
 * make NO billable call. These tests therefore COUNT invocations of the metric
 * fetch seam rather than reading the response's own `usageSource` and trusting
 * it. A response that merely claims to be gated while having spent money is the
 * exact failure this must catch.
 */
describe('LocalDataProvider.getUsage', () => {
	let tmpDir: string;

	function makeProject(): string {
		tmpDir = join(tmpdir(), `admin-ui-usage-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(join(tmpDir, '.blocks'), { recursive: true });
		mkdirSync(join(tmpDir, '.blocks-sandbox'), { recursive: true });
		writeFileSync(join(tmpDir, 'package.json'), JSON.stringify({ name: 'my-app' }));
		writeFileSync(join(tmpDir, '.blocks/config.json'), JSON.stringify({ stackId: 'my-app-abc123' }));
		// Production's own outputs document supplies its stack AND its region.
		writeFileSync(
			join(tmpDir, '.blocks-sandbox/outputs.production.json'),
			JSON.stringify({ 'my-app-prod': { ApiUrl: 'https://abc.execute-api.eu-west-1.amazonaws.com/prod/' } }),
		);
		return tmpDir;
	}

	afterEach(() => {
		if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
	});

	const RESOURCES: RawStackResource[] = [
		{ LogicalResourceId: 'Api', PhysicalResourceId: 'abc123xyz', ResourceType: 'AWS::ApiGateway::RestApi' },
		{ LogicalResourceId: 'Stage', PhysicalResourceId: 'prod', ResourceType: 'AWS::ApiGateway::Stage' },
		{ LogicalResourceId: 'Users', PhysicalResourceId: 'my-app-prod-users', ResourceType: 'AWS::DynamoDB::Table' },
		{ LogicalResourceId: 'Fn', PhysicalResourceId: 'my-app-prod-handler', ResourceType: 'AWS::Lambda::Function' },
	];

	const TEMPLATE = {
		Resources: { Api: { Type: 'AWS::ApiGateway::RestApi', Properties: { Name: 'Blocks API' } } },
	};

	/** A provider whose metric fetch is counted, so the gate can be proven. */
	function countingProvider(options: { onFetch?: () => RawMetricDataResult[]; failFetch?: Error } = {}) {
		const calls: Array<{ queries: MetricQuery[]; start: Date; end: Date; period: number }> = [];
		const provider = new LocalDataProvider(
			makeProject(),
			undefined, // fetchEvents
			async () => RESOURCES,
			undefined, // fetchLogMetadata
			undefined, // runInsights
			async () => TEMPLATE,
			undefined, // fetchDescription
			undefined, // fetchCostTags
			undefined, // fetchCosts
			undefined, // runDoctorImpl
			undefined, // discoverBlocksImpl
			undefined, // readLocalDataImpl
			undefined, // readCloudDataImpl
			undefined, // putLocalRecordImpl
			undefined, // deleteLocalRecordImpl
			undefined, // putCloudRecordImpl
			undefined, // deleteCloudRecordImpl
			undefined, // buildRpcMethodCatalogueImpl
			undefined, // resolveRpcEndpointImpl
			undefined, // invokeRpcImpl
			async (queries, start, end, period) => {
				calls.push({ queries, start, end, period });
				if (options.failFetch) throw options.failFetch;
				return options.onFetch ? options.onFetch() : [];
			},
		);
		return { provider, calls };
	}

	it('makes NO billable call without consent', async () => {
		const { provider, calls } = countingProvider();
		const result = await provider.getUsage({ stage: 'production', rangeMinutes: 60, confirmed: false });
		assert.equal(calls.length, 0, 'an unconfirmed request must not call GetMetricData');
		assert.equal(result.usageSource, 'gated');
		assert.equal(result.series, undefined);
		assert.equal(result.totals, undefined);
	});

	it('still prices the request it did not make', async () => {
		// The gate is only useful if it says what the call would cost, so the
		// estimate must be present precisely when nothing was spent.
		const { provider } = countingProvider();
		const result = await provider.getUsage({ stage: 'production', rangeMinutes: 60, confirmed: false });
		assert.ok(result.estimate.metricsRequested > 0);
		assert.ok(result.estimate.usd > 0);
		assert.equal(result.estimate.alwaysCharged, true);
		assert.ok(result.targets.length > 0);
	});

	it('never reports the charge as $0.00 when it is not zero', async () => {
		const { provider } = countingProvider();
		const { estimate } = await provider.getUsage({ stage: 'production', rangeMinutes: 60, confirmed: false });
		assert.notEqual(estimate.usdFormatted, '$0.00');
	});

	it('fetches exactly once with consent', async () => {
		const { provider, calls } = countingProvider();
		const result = await provider.getUsage({ stage: 'production', rangeMinutes: 60, confirmed: true });
		assert.equal(calls.length, 1);
		assert.equal(result.usageSource, 'cloudwatch');
		assert.ok(Array.isArray(result.series));
		assert.ok(result.totals);
		assert.ok(result.fetchedAt);
	});

	it('charges the same whether or not consent was given', async () => {
		// The estimate the user authorises must be the estimate of the request
		// actually sent: a gated figure that differs from the billed one makes
		// the consent meaningless.
		const gated = await countingProvider().provider.getUsage({
			stage: 'production',
			rangeMinutes: 60,
			confirmed: false,
		});
		const confirmed = await countingProvider().provider.getUsage({
			stage: 'production',
			rangeMinutes: 60,
			confirmed: true,
		});
		assert.deepEqual(confirmed.estimate, gated.estimate);
	});

	it('sends the queries it priced, and no others', async () => {
		const { provider, calls } = countingProvider();
		const gated = await provider.getUsage({ stage: 'production', rangeMinutes: 60, confirmed: false });
		await provider.getUsage({ stage: 'production', rangeMinutes: 60, confirmed: true });
		assert.equal(calls[0].queries.length, gated.estimate.metricsRequested);
	});

	it('derives the window from rangeMinutes and reports the period', async () => {
		const { provider, calls } = countingProvider();
		const result = await provider.getUsage({ stage: 'production', rangeMinutes: 60, confirmed: true });
		assert.equal(result.periodSeconds, 60);
		assert.equal(result.rangeMinutes, 60);
		assert.equal(calls[0].period, 60);
		const spanMinutes = (calls[0].end.getTime() - calls[0].start.getTime()) / 60_000;
		assert.ok(Math.abs(spanMinutes - 60) < 1, `window was ${spanMinutes} minutes`);
	});

	it('reports a fetch failure as unavailable, never as an empty chart', async () => {
		// An AccessDenied that rendered as "no traffic" is the worst outcome
		// available here, so the error must reach the response.
		const denied = new Error('User is not authorized to perform cloudwatch:GetMetricData');
		denied.name = 'AccessDeniedException';
		const { provider } = countingProvider({ failFetch: denied });
		const result = await provider.getUsage({ stage: 'production', rangeMinutes: 60, confirmed: true });
		assert.equal(result.usageSource, 'unavailable');
		assert.equal(result.usageErrorCode, 'ACCESS_DENIED');
		assert.match(result.usageError ?? '', /GetMetricData/);
		assert.equal(result.series, undefined);
	});

	it('reports a stage with no resolvable stack as unavailable', async () => {
		const { provider, calls } = countingProvider();
		const result = await provider.getUsage({ stage: 'nonexistent', rangeMinutes: 60, confirmed: true });
		assert.equal(result.usageSource, 'unavailable');
		assert.equal(calls.length, 0, 'nothing to query means nothing billed');
		assert.equal(result.estimate.metricsRequested, 0);
	});

	it('carries the shared-dimensions reason through to the response', async () => {
		// The REST API's dimensions are not stage-unique. The view can only say
		// so if the reason survives the whole path.
		const { provider } = countingProvider();
		const result = await provider.getUsage({ stage: 'production', rangeMinutes: 60, confirmed: false });
		const api = result.targets.find((t) => t.kind === 'api');
		assert.equal(api?.sharedDimensions, true);
		assert.match(api?.sharedReason ?? '', /every stage of this app/);
	});

	it('reports the per-stage region it resolved, not an ambient one', async () => {
		const { provider } = countingProvider();
		const result = await provider.getUsage({ stage: 'production', rangeMinutes: 60, confirmed: false });
		assert.equal(result.awsContext?.region, 'eu-west-1');
		assert.equal(result.awsContext?.regionSource, 'outputs');
	});

	it('attributes every target to the stage stack', async () => {
		const { provider } = countingProvider();
		const result = await provider.getUsage({ stage: 'production', rangeMinutes: 60, confirmed: false });
		assert.equal(result.stackName, 'my-app-prod');
	});

	it('maps returned datapoints into series the view can chart', async () => {
		const { provider, calls } = countingProvider({
			onFetch: () => [],
		});
		// Two passes: the first learns the ids, the second answers for them.
		await provider.getUsage({ stage: 'production', rangeMinutes: 60, confirmed: true });
		const ids = calls[0].queries.map((q) => q.id);
		const { provider: answering } = countingProvider({
			onFetch: () =>
				ids.map((id) => ({
					Id: id,
					Timestamps: [new Date('2026-10-07T01:00:00Z')],
					Values: [3],
				})),
		});
		const result = await answering.getUsage({ stage: 'production', rangeMinutes: 60, confirmed: true });
		assert.equal(result.series?.length, ids.length);
		assert.ok(result.series?.every((s) => s.points.length === 1));
		assert.equal(result.totals?.emptySeries, 0);
	});

	it('does not cache, so a second confirmed request bills again', async () => {
		// Caching would make the second refresh free and the first expensive,
		// which is the asymmetry that makes a consent screen lie.
		const { provider, calls } = countingProvider();
		await provider.getUsage({ stage: 'production', rangeMinutes: 60, confirmed: true });
		await provider.getUsage({ stage: 'production', rangeMinutes: 60, confirmed: true });
		assert.equal(calls.length, 2);
	});
});
