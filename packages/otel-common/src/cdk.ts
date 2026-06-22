// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * CDK infra helper for the OpenTelemetry building blocks.
 *
 * Attaches the standalone `opentelemetry-collector` Lambda layer + a config layer
 * (carrying our spike-validated collector YAML) + the collector-config env var to
 * the shared Blocks handler, exactly once per stack. Per-signal IAM grants and the
 * dedicated CloudWatch Logs group/stream are added additively as each OTel block
 * (traces / metrics / logs) opts in.
 *
 * Idempotency follows the `bb-realtime` pattern: a `Symbol.for` key on the stack.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import { PolicyStatement } from 'aws-cdk-lib/aws-iam';
import { RemovalPolicy } from 'aws-cdk-lib';
import type { Scope } from '@aws-blocks/core/cdk';
import { renderCollectorConfig } from './collector-config.js';
import {
	COLLECTOR_LAYER_ACCOUNT,
	DEFAULT_COLLECTOR_LAYER_VERSION,
} from './constants.js';
import type { OtelSharedInfraOptions, OtelSignal } from './types.js';

const SHARED_KEY = Symbol.for('BLOCKS_OTEL_SHARED');

interface OtelSharedInfra {
	/** Signals whose IAM (+ log resources) have already been granted. */
	readonly granted: Set<OtelSignal>;
	/** The dedicated CloudWatch Logs group for the logs signal (created lazily). */
	logGroup?: logs.LogGroup;
}

/**
 * Build the standalone collector layer ARN for a region/arch/version.
 * `arn:aws:lambda:<region>:184161586896:layer:opentelemetry-collector-<arch>-<ver>:1`
 */
function collectorLayerArn(region: string, arch: string, version: string): string {
	return `arn:aws:lambda:${region}:${COLLECTOR_LAYER_ACCOUNT}:layer:opentelemetry-collector-${arch}-${version}:1`;
}

/**
 * Render the collector YAML to a synth-time asset directory and return its path.
 * The layer unpacks the asset under `/opt`, so `collector.yaml` at the asset root
 * lands at `/opt/collector.yaml`.
 */
function writeCollectorConfigAsset(scope: Scope, yaml: string): string {
	// Deterministic per-scope dir so repeated synths overwrite rather than accumulate.
	const dir = join(tmpdir(), `bb-otel-collector-${scope.fullId.replace(/[^a-zA-Z0-9_-]/g, '_')}`);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, 'collector.yaml'), yaml);
	return dir;
}

/**
 * Idempotently attach OTel collector infrastructure to the shared handler and grant
 * the requested signal's IAM. Returns the shared-infra record.
 *
 * @param stack - the enclosing CDK stack (idempotency key holder).
 * @param handler - the shared Blocks Lambda (`scope.handler`).
 * @param scope - the calling OTel block's Scope (for construct parenting + fullId).
 * @param options - signals to enable, layer overrides, endpoint override, log names.
 */
export function getOrCreateOtelSharedInfra(
	stack: cdk.Stack,
	handler: lambda.Function,
	scope: Scope,
	options: OtelSharedInfraOptions = {},
): OtelSharedInfra {
	// Each block enables ONLY the signals it asks for (default off), so IAM grants stay
	// least-privilege. The collector config still configures all three pipelines (idle
	// pipelines are harmless), so a later block's signal works without reconfiguring it.
	const want = { traces: false, metrics: false, logs: false, ...options.signals };
	const requested: OtelSignal[] = (['traces', 'metrics', 'logs'] as OtelSignal[]).filter(s => want[s]);

	const logGroupName = options.logGroupName ?? `/aws/otel/${scope.fullId}`;
	const logStreamName = options.logStreamName ?? 'default';

	let shared = (stack as any)[SHARED_KEY] as OtelSharedInfra | undefined;

	// ── First call in this stack: attach layers + env (once) ──
	if (!shared) {
		const region = cdk.Token.isUnresolved(stack.region) ? '${env:AWS_REGION}' : stack.region;
		const arch = options.architecture ?? 'amd64';
		const version = options.layerVersion ?? DEFAULT_COLLECTOR_LAYER_VERSION;
		const layerArn = options.layerArn ?? collectorLayerArn(region, arch, version);

		// Always configure all three pipelines: idle pipelines never export and cost
		// nothing, while per-signal IAM (below) stays least-privilege. This avoids
		// having to know the full signal union before the layer is created.
		const yaml = renderCollectorConfig({
			region,
			signals: { traces: true, metrics: true, logs: true },
			logGroupName,
			logStreamName,
			endpointOverride: options.endpointOverride,
		});

		const collectorLayer = lambda.LayerVersion.fromLayerVersionArn(scope, 'OtelCollectorLayer', layerArn);
		const configLayer = new lambda.LayerVersion(scope, 'OtelCollectorConfigLayer', {
			code: lambda.Code.fromAsset(writeCollectorConfigAsset(scope, yaml)),
		});
		handler.addLayers(collectorLayer, configLayer);

		handler.addEnvironment('OPENTELEMETRY_COLLECTOR_CONFIG_URI', '/opt/collector.yaml');
		// Avoid double-billing X-Ray via Application Signals; we export traces ourselves.
		handler.addEnvironment('OTEL_AWS_APPLICATION_SIGNALS_ENABLED', 'false');

		shared = { granted: new Set<OtelSignal>() };
		(stack as any)[SHARED_KEY] = shared;
	}

	// ── Every call: additively grant the requested signals' IAM (+ log resources) ──
	for (const signal of requested) {
		if (shared.granted.has(signal)) continue;
		shared.granted.add(signal);

		// Third-party OTLP backend: the user supplies auth via headers; no AWS grants.
		if (options.endpointOverride) continue;

		if (signal === 'metrics') {
			handler.addToRolePolicy(new PolicyStatement({
				actions: ['cloudwatch:PutMetricData'],
				resources: ['*'],
			}));
		} else if (signal === 'traces') {
			handler.addToRolePolicy(new PolicyStatement({
				actions: [
					'xray:PutSpans',
					'xray:PutSpansForIndexing',
					'xray:PutTraceSegments',
					'xray:PutTelemetryRecords',
				],
				resources: ['*'],
			}));
		} else if (signal === 'logs') {
			// The OTLP logs endpoint requires a pre-existing log group AND stream.
			if (!shared.logGroup) {
				const logGroup = new logs.LogGroup(scope, 'OtelLogGroup', {
					logGroupName,
					removalPolicy: RemovalPolicy.DESTROY,
				});
				new logs.LogStream(scope, 'OtelLogStream', {
					logGroup,
					logStreamName,
					removalPolicy: RemovalPolicy.DESTROY,
				});
				shared.logGroup = logGroup;
			}
			handler.addToRolePolicy(new PolicyStatement({
				actions: ['logs:PutLogEvents', 'logs:DescribeLogGroups', 'logs:DescribeLogStreams'],
				resources: [shared.logGroup.logGroupArn, `${shared.logGroup.logGroupArn}:*`],
			}));
		}
	}

	return shared;
}
