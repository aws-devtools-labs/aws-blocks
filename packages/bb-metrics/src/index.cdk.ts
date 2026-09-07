// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { Scope } from '@aws-blocks/core/cdk';
import type { ScopeParent } from '@aws-blocks/core';
import type { MetricsOptions } from './types.js';

export { MetricsErrors } from './errors.js';
export type {
	MetricsOptions,
	EmitOptions,
	MetricDatum,
	MetricUnit,
	MetricResolution,
	ExternalMetricsRef,
	MetricsEmitter,
} from './types.js';

/**
 * CDK construct for Metrics.
 *
 * EMF writes structured JSON to stdout which Lambda captures in CloudWatch Logs.
 * CloudWatch automatically extracts metrics — no additional IAM permissions or
 * environment variables are needed.
 */
export class Metrics extends Scope {
	/** The resolved CloudWatch namespace for metrics emitted by this instance. */
	readonly namespace: string;

	/** Default dimensions applied to every metric emitted by this instance. */
	readonly defaultDimensions: Readonly<Record<string, string>>;

	constructor(scope: ScopeParent, id: string, options?: MetricsOptions) {
		super(id, { parent: scope });
		this.namespace = options?.metrics?.namespace
			?? options?.namespace
			?? this.fullId;
		this.defaultDimensions = options?.defaultDimensions ?? {};
	}
}
