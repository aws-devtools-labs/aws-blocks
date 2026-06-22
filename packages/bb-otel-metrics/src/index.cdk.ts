// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import * as cdk from 'aws-cdk-lib';
import { Scope } from '@aws-blocks/core/cdk';
import type { ScopeParent } from '@aws-blocks/core';
import { getOrCreateOtelSharedInfra } from '@aws-blocks/otel-common/cdk';
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
 * CDK construct for OTel Metrics. Attaches the shared OTel collector infrastructure
 * to the Blocks handler (once per stack) and grants the metrics IAM
 * (`cloudwatch:PutMetricData`). Exposes `defaultDimensions` + `metricsKind` so the
 * Dashboard block can build PromQL widgets for this Metrics instance.
 */
export class OtelMetrics extends Scope {
	readonly defaultDimensions: Readonly<Record<string, string>>;
	/** Marks these metrics as OTLP/PromQL so the Dashboard renders PromQL widgets. */
	readonly metricsKind = 'otlp' as const;

	constructor(scope: ScopeParent, id: string, options?: OtelMetricsOptions) {
		super(id, { parent: scope });
		this.defaultDimensions = options?.defaultAttributes ?? {};
		getOrCreateOtelSharedInfra(cdk.Stack.of(this), this.handler, this, {
			signals: { metrics: true },
		});
	}
}
