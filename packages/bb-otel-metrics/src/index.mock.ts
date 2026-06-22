// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Local-development runtime for OTel Metrics.
 *
 * Behaviour matches the AWS runtime (same `@opentelemetry/api` Meter call path and
 * escape hatch), but the in-process SDK is initialized with console/file exporters
 * instead of the collector — there is no collector layer locally. Metrics print to
 * stdout via the OTel `ConsoleMetricExporter`.
 */

import { Scope } from '@aws-blocks/core';
import type { ScopeParent } from '@aws-blocks/core';
import { getMockDataDir } from '@aws-blocks/core/bb-utils';
import { join } from 'node:path';
import { getOrCreateOtelSdk, mockExporters } from '@aws-blocks/otel-common';
import { OtelMetrics as AwsOtelMetrics } from './index.aws.js';
import type { OtelMetricsOptions } from './types.js';

export { OtelMetricsErrors } from './errors.js';
export type {
	OtelMetricsOptions,
	EmitOptions,
	MetricUnit,
	OtelMetricsEmitter,
	Counter,
	Histogram,
	UpDownCounter,
	ObservableGauge,
	Meter,
} from './types.js';

/**
 * Mock OtelMetrics: initializes the in-process SDK with local (console/file) exporters
 * before delegating to the shared AWS implementation. The SDK singleton is created on
 * first construction, so this must run before any block touches the global providers.
 */
export class OtelMetrics extends AwsOtelMetrics {
	constructor(scope: ScopeParent, id: string, options?: OtelMetricsOptions) {
		// Seed the in-process SDK with mock exporters using a fullId-scoped traces file,
		// matching the bb-tracer mock convention. getOrCreateOtelSdk is a singleton, so
		// the first block to construct wins; subsequent ones reuse it.
		const probe = new Scope(id, { parent: scope });
		const tracesFile = join(getMockDataDir(probe), 'traces.json');
		getOrCreateOtelSdk({
			resource: {
				serviceName: options?.serviceName,
				serviceNamespace: options?.serviceNamespace,
				serviceVersion: options?.serviceVersion,
			},
			defaultServiceName: probe.fullId,
		}, mockExporters(tracesFile));
		super(scope, id, options);
	}
}
