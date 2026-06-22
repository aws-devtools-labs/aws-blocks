// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { Scope } from '@aws-blocks/core';
import type { ScopeParent } from '@aws-blocks/core';
import { metrics as otelMetrics } from '@opentelemetry/api';
import type { Counter, Histogram, UpDownCounter, ObservableGauge, Meter, MetricOptions } from '@opentelemetry/api';
import { getOrCreateOtelSdk } from '@aws-blocks/otel-common';
import { Logger } from '@aws-blocks/bb-logger';
import type { ChildLogger } from '@aws-blocks/bb-logger';
import type { EmitOptions, MetricUnit, OtelMetricsOptions, OtelMetricsEmitter } from './types.js';
import { OtelMetricsErrors } from './errors.js';

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

function blocksError(name: string, message: string): Error {
	const err = new Error(`${name}: ${message}`);
	err.name = name;
	return err;
}

function validateMetricName(name: string): void {
	if (!name || name.length === 0) {
		throw blocksError(OtelMetricsErrors.InvalidMetricName, 'Metric name must not be empty');
	}
	if (name.length > 255) {
		throw blocksError(OtelMetricsErrors.InvalidMetricName, `Metric name exceeds 255 characters (got ${name.length})`);
	}
}

/**
 * Custom application metrics via OpenTelemetry, exported to Amazon CloudWatch's OTLP
 * endpoint (PromQL-queryable) through the in-process OTel SDK + collector layer.
 *
 * Offers an ergonomic `emit`/`child` surface and additionally exposes OTel's typed
 * instruments (`counter`, `histogram`, `upDownCounter`, `observableGauge`) and the raw
 * `Meter` (`rawMeter`) for full power. There is no `emitBatch` — OpenTelemetry batches at
 * export time (the SDK's periodic reader), so calling `emit` repeatedly is the idiom.
 *
 * Service identity (`service.name`/`service.namespace`/`service.version`) is set on the
 * SDK resource and is process-wide; the meter (instrumentation scope) name distinguishes
 * per-block telemetry. AWS Lambda resource attributes (`faas.*`, `cloud.*`) are detected
 * and attached automatically.
 *
 * **When to use:** the default for application metrics. Choose the AWS-native `Metrics`
 * block only if you specifically need CloudWatch EMF / classic namespace+dimension metrics.
 */
export class OtelMetrics extends Scope implements OtelMetricsEmitter {
	/**
	 * Default attributes applied to every metric. Exposed as `defaultDimensions` for
	 * structural compatibility with the Dashboard's `MetricsBBRef`.
	 */
	readonly defaultDimensions: Readonly<Record<string, string>>;
	/** Marks these metrics as OTLP/PromQL so the Dashboard renders PromQL widgets. */
	readonly metricsKind = 'otlp' as const;

	/** @internal */
	protected log: ChildLogger;
	private meter: Meter;
	private counters = new Map<string, Counter>();

	constructor(scope: ScopeParent, id: string, options?: OtelMetricsOptions) {
		super(id, { parent: scope });
		this.log = options?.logger ?? new Logger(this, 'logger', { level: 'error' });
		this.defaultDimensions = options?.defaultAttributes ?? {};
		getOrCreateOtelSdk({
			resource: {
				serviceName: options?.serviceName,
				serviceNamespace: options?.serviceNamespace,
				serviceVersion: options?.serviceVersion,
			},
			defaultServiceName: this.fullId,
		});
		this.meter = otelMetrics.getMeter(options?.meterName ?? this.fullId);
	}

	private counterFor(name: string, unit?: MetricUnit): Counter {
		let c = this.counters.get(name);
		if (!c) {
			c = this.meter.createCounter(name, { unit: unit ?? '1' });
			this.counters.set(name, c);
		}
		return c;
	}

	/** Record a single additive metric data point (mapped onto an OTel Counter). */
	emit(name: string, value: number, options?: EmitOptions): void {
		validateMetricName(name);
		this.counterFor(name, options?.unit).add(value, { ...this.defaultDimensions, ...options?.attributes });
	}

	/** No-op: the in-process SDK exports on its own cadence and is force-flushed by the runtime. */
	flush(): void {}

	/** Create a child emitter with merged default attributes (same meter). */
	child(attributes: Record<string, string>): OtelMetricsEmitter {
		return new ChildOtelMetrics(this.meter, this.counters, { ...this.defaultDimensions, ...attributes });
	}

	// ── Typed OTel instruments (escape hatch with structure) ──

	/** Create (or get) a monotonic Counter. */
	counter(name: string, options?: MetricOptions): Counter {
		return this.meter.createCounter(name, options);
	}

	/** Create a Histogram for value distributions. */
	histogram(name: string, options?: MetricOptions): Histogram {
		return this.meter.createHistogram(name, options);
	}

	/** Create a non-monotonic UpDownCounter. */
	upDownCounter(name: string, options?: MetricOptions): UpDownCounter {
		return this.meter.createUpDownCounter(name, options);
	}

	/** Create an async ObservableGauge driven by a callback. */
	observableGauge(name: string, callback: (result: { observe(value: number, attributes?: Record<string, string>): void }) => void, options?: MetricOptions): ObservableGauge {
		const gauge = this.meter.createObservableGauge(name, options);
		gauge.addCallback(callback as any);
		return gauge;
	}

	/** The underlying OTel `Meter` — full escape hatch. */
	get rawMeter(): Meter {
		return this.meter;
	}
}

// ── ChildOtelMetrics ──────────────────────────────────────────────────────────

class ChildOtelMetrics implements OtelMetricsEmitter {
	constructor(
		private meter: Meter,
		private counters: Map<string, Counter>,
		readonly defaultDimensions: Readonly<Record<string, string>>,
	) {}

	private counterFor(name: string, unit?: MetricUnit): Counter {
		let c = this.counters.get(name);
		if (!c) {
			c = this.meter.createCounter(name, { unit: unit ?? '1' });
			this.counters.set(name, c);
		}
		return c;
	}

	emit(name: string, value: number, options?: EmitOptions): void {
		validateMetricName(name);
		this.counterFor(name, options?.unit).add(value, { ...this.defaultDimensions, ...options?.attributes });
	}

	flush(): void {}

	child(attributes: Record<string, string>): OtelMetricsEmitter {
		return new ChildOtelMetrics(this.meter, this.counters, { ...this.defaultDimensions, ...attributes });
	}
}
