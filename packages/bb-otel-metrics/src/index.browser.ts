// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// Browser stub — OtelMetrics is server-side only.
// Provides a no-op implementation that silently drops all metric emissions and
// returns inert instrument handles, so bundlers don't pull the OTel SDK into the
// browser bundle.

import type { EmitOptions, OtelMetricsEmitter } from './types.js';

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

const NOOP_INSTRUMENT: any = {
	add() {},
	record() {},
	addCallback() {},
	removeCallback() {},
};

export class OtelMetrics implements OtelMetricsEmitter {
	readonly defaultDimensions: Readonly<Record<string, string>> = {};
	readonly metricsKind = 'otlp' as const;
	constructor(..._args: any[]) {}
	emit(_name: string, _value: number, _options?: EmitOptions): void {}
	flush(): void {}
	child(_attributes: Record<string, string>): OtelMetricsEmitter { return new OtelMetrics(); }
	counter(): any { return NOOP_INSTRUMENT; }
	histogram(): any { return NOOP_INSTRUMENT; }
	upDownCounter(): any { return NOOP_INSTRUMENT; }
	observableGauge(): any { return NOOP_INSTRUMENT; }
	get rawMeter(): any { return { createCounter: () => NOOP_INSTRUMENT, createHistogram: () => NOOP_INSTRUMENT, createUpDownCounter: () => NOOP_INSTRUMENT, createObservableGauge: () => NOOP_INSTRUMENT }; }
}
