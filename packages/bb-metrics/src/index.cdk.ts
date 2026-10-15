// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { Scope, synthGuard } from '@aws-blocks/core/cdk';
import type { ScopeParent } from '@aws-blocks/core';
import type { ExternalMetricsRef, MetricsOptions } from './types.js';

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

	/**
	 * Reference an existing CloudWatch namespace not managed by this Building Block.
	 *
	 * @param namespace - The CloudWatch namespace string.
	 *
	 * @example
	 * ```typescript
	 * const metrics = new Metrics(scope, 'legacy', {
	 *   metrics: Metrics.fromExisting('MyOrg/SharedMetrics'),
	 * });
	 * ```
	 */
	static fromExisting(namespace: string): ExternalMetricsRef {
		return { __brand: 'ExternalMetricsRef' as const, namespace };
	}

	// ── Runtime methods are not available during CDK synth ────────────────
	// Under `--conditions=cdk` a Metrics resolves to this construct, which only
	// provisions infrastructure; these methods live in the runtime build. Calling
	// one at module top-level (which runs during synth) would otherwise fail with a
	// cryptic `X is not a function`; these stubs turn that into an actionable message.
	emit(..._args: unknown[]): never { return synthGuard('Metrics', 'emit'); }
	emitBatch(..._args: unknown[]): never { return synthGuard('Metrics', 'emitBatch'); }
	flush(..._args: unknown[]): never { return synthGuard('Metrics', 'flush'); }
}
