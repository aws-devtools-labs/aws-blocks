// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// Browser stub — Metrics is server-side only.
// Provides a no-op implementation that silently drops all metric emissions.

import { externalMetricsRef } from './from-existing.js';
import type { EmitOptions, MetricDatum, ExternalMetricsRef, MetricsEmitter } from './types.js';

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

export class Metrics implements MetricsEmitter {
	constructor(..._args: any[]) {}
	emit(_name: string, _value: number, _options?: EmitOptions): void {}
	emitBatch(_metrics: MetricDatum[]): void {}
	flush(): void {}
	child(_dimensions: Record<string, string>): MetricsEmitter { return new Metrics(); }
	static fromExisting(namespace: string): ExternalMetricsRef {
		return externalMetricsRef(namespace);
	}
}
