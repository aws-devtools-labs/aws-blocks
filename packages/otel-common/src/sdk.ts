// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * In-process OpenTelemetry SDK bootstrap shared by the OTel building blocks.
 *
 * There is no exec-wrapper layer, so the blocks register the global OTel providers
 * themselves at cold start. In AWS the exporters target the standalone collector on
 * `localhost:4318`; the mock runtime swaps in console/file exporters. Either way the
 * SDK + escape-hatch handles behave identically.
 *
 * **Force-flush is mandatory.** Lambda freezes the sandbox after the handler returns,
 * which would drop the SDK's async exports. Call {@link flushOtel} before returning
 * (the OTel blocks register it into the shared handler's completion hook).
 */

import { trace, metrics, context, propagation } from '@opentelemetry/api';
import type { MeterProvider as ApiMeterProvider, TracerProvider as ApiTracerProvider } from '@opentelemetry/api';
import { logs } from '@opentelemetry/api-logs';
import type { LoggerProvider as ApiLoggerProvider } from '@opentelemetry/api-logs';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { resourceFromAttributes, detectResources, envDetector } from '@opentelemetry/resources';
import { awsLambdaDetector } from '@opentelemetry/resource-detector-aws';
import {
	ATTR_SERVICE_NAME,
	ATTR_SERVICE_NAMESPACE,
	ATTR_SERVICE_VERSION,
} from '@opentelemetry/semantic-conventions';
import { BasicTracerProvider, BatchSpanProcessor } from '@opentelemetry/sdk-trace-base';
import type { SpanExporter } from '@opentelemetry/sdk-trace-base';
import { MeterProvider, PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import type { PushMetricExporter } from '@opentelemetry/sdk-metrics';
import { LoggerProvider, BatchLogRecordProcessor } from '@opentelemetry/sdk-logs';
import type { LogRecordExporter } from '@opentelemetry/sdk-logs';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-http';
import type { OtelSdkOptions, OtelResourceOptions } from './types.js';

const DEFAULT_COLLECTOR_URL = 'http://localhost:4318';
const SDK_KEY = '__BLOCKS_OTEL_SDK__';
const FLUSH_KEY = '__BLOCKS_OTEL_FLUSHERS__';

/** Factory hooks so the mock runtime can substitute exporters without re-wiring providers. */
export interface OtelExporters {
	traceExporter(): SpanExporter;
	metricExporter(): PushMetricExporter;
	logExporter(): LogRecordExporter;
}

/** The initialized in-process OTel providers, returned by {@link getOrCreateOtelSdk}. */
export interface OtelSdk {
	tracerProvider: BasicTracerProvider;
	meterProvider: MeterProvider;
	loggerProvider: LoggerProvider;
}

/** Default exporters: OTLP/HTTP to the local collector. */
function defaultExporters(collectorUrl: string): OtelExporters {
	return {
		traceExporter: () => new OTLPTraceExporter({ url: `${collectorUrl}/v1/traces` }),
		metricExporter: () => new OTLPMetricExporter({ url: `${collectorUrl}/v1/metrics` }),
		logExporter: () => new OTLPLogExporter({ url: `${collectorUrl}/v1/logs` }),
	};
}

/**
 * Build the SDK Resource from semantic-convention service identity, then merge
 * detected attributes. `service.name` resolves to (in order): an explicit
 * `resource.serviceName`, the Lambda function name (`AWS_LAMBDA_FUNCTION_NAME`), the
 * `BLOCKS_STACK_NAME` env var, `defaultServiceName` (the block's scope `fullId`), and
 * finally a constant. We always set it because the Lambda detector populates `faas.name`
 * (not `service.name`) and an unset `service.name` becomes the `unknown_service:node`
 * sentinel.
 *
 * Detection adds AWS Lambda attributes (`faas.*`, `cloud.*`, `aws.log.group.names`)
 * out of the box — the OTel-recommended path, since the collector layer omits the
 * resourcedetection processor (see contrib#17584). `envDetector` runs last so
 * `OTEL_RESOURCE_ATTRIBUTES` can override at deploy time.
 */
function buildResource(options: OtelSdkOptions) {
	const r: OtelResourceOptions = options.resource ?? {};
	// service.name resolution (the Lambda detector sets faas.name, NOT service.name; an
	// unset service.name becomes the useless `unknown_service:node` sentinel, so we always
	// default it). Prefer the most specific real identity available:
	//   explicit option → Lambda function name → stack/app name → block fullId → constant.
	// Locally (mock runtime) the first three are unset, so it resolves to the block fullId.
	const serviceName = r.serviceName
		?? process.env.AWS_LAMBDA_FUNCTION_NAME
		?? process.env.BLOCKS_STACK_NAME
		?? options.defaultServiceName
		?? 'aws-blocks-service';

	const base = resourceFromAttributes({
		[ATTR_SERVICE_NAME]: serviceName,
		...(r.serviceNamespace ? { [ATTR_SERVICE_NAMESPACE]: r.serviceNamespace } : {}),
		...(r.serviceVersion ? { [ATTR_SERVICE_VERSION]: r.serviceVersion } : {}),
		...(r.attributes ?? {}),
	});

	// `Resource.merge(other)` lets `other` win on key conflict. Merging detected INTO
	// base means: Lambda attrs (faas.*/cloud.*, no overlap) are added, and anything in
	// OTEL_RESOURCE_ATTRIBUTES (envDetector) intentionally overrides — the deploy-time
	// ops escape hatch. The base service.* attrs are untouched unless ops override them.
	const detected = detectResources({ detectors: [awsLambdaDetector, envDetector] });
	return base.merge(detected);
}

/**
 * Initialize the global OTel providers exactly once per process, returning the
 * existing instance on subsequent calls.
 *
 * @param options - service identity (resource attributes) + optional collector URL.
 * @param exporters - exporter factory override (used by the mock runtime).
 */
export function getOrCreateOtelSdk(options: OtelSdkOptions, exporters?: OtelExporters): OtelSdk {
	const g = globalThis as any;
	if (g[SDK_KEY]) return g[SDK_KEY] as OtelSdk;

	const collectorUrl = options.collectorUrl ?? DEFAULT_COLLECTOR_URL;
	const exp = exporters ?? defaultExporters(collectorUrl);
	const resource = buildResource(options);

	// Register a context manager + W3C propagator so active-span reads
	// (trace.getActiveSpan, propagation.inject/extract) work. BasicTracerProvider
	// alone does not install these.
	context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
	propagation.setGlobalPropagator(new W3CTraceContextPropagator());

	const spanProcessor = new BatchSpanProcessor(exp.traceExporter());
	const tracerProvider = new BasicTracerProvider({ resource, spanProcessors: [spanProcessor] });
	trace.setGlobalTracerProvider(tracerProvider);

	const metricReader = new PeriodicExportingMetricReader({
		exporter: exp.metricExporter(),
		exportIntervalMillis: 60_000,
	});
	const meterProvider = new MeterProvider({ resource, readers: [metricReader] });
	metrics.setGlobalMeterProvider(meterProvider);

	const logProcessor = new BatchLogRecordProcessor(exp.logExporter());
	const loggerProvider = new LoggerProvider({ resource, processors: [logProcessor] });
	logs.setGlobalLoggerProvider(loggerProvider);

	const sdk: OtelSdk = { tracerProvider, meterProvider, loggerProvider };
	g[SDK_KEY] = sdk;

	// Register a flusher so the shared handler can drain all signals before the
	// sandbox freeze. Stored on a process-global list so multiple blocks share one.
	registerOtelFlusher(async () => {
		await Promise.all([
			tracerProvider.forceFlush(),
			meterProvider.forceFlush(),
			loggerProvider.forceFlush(),
		]);
	});

	return sdk;
}

/**
 * Well-known global the runtime handler calls after each invocation to flush OTel.
 * Published here (rather than imported by core) so `@aws-blocks/core` stays decoupled
 * from the OTel packages — core only calls it when an OTel block has initialized.
 */
const FLUSH_FN_KEY = '__BLOCKS_OTEL_FLUSH__';

/** Register a flush callback invoked by {@link flushOtel}. Idempotent per callback identity. */
export function registerOtelFlusher(fn: () => Promise<void>): void {
	const g = globalThis as any;
	if (!g[FLUSH_KEY]) g[FLUSH_KEY] = new Set<() => Promise<void>>();
	(g[FLUSH_KEY] as Set<() => Promise<void>>).add(fn);
	// Publish flushOtel on the well-known global so the runtime handler can drain
	// telemetry before the sandbox freezes, without importing this package.
	if (!g[FLUSH_FN_KEY]) g[FLUSH_FN_KEY] = flushOtel;
}

/**
 * Force-flush every registered OTel provider. Call before the handler returns.
 * Safe to call when no SDK is initialized (no-op). Never throws — flush failures
 * are observability data loss, not request failures.
 */
export async function flushOtel(): Promise<void> {
	const g = globalThis as any;
	const flushers = g[FLUSH_KEY] as Set<() => Promise<void>> | undefined;
	if (!flushers || flushers.size === 0) return;
	const results = await Promise.allSettled(Array.from(flushers).map(fn => fn()));
	// Swallow individual flush errors; telemetry loss must not fail the request.
	void results;
}

// ── Provider accessors (escape hatch for OTel-compatible libraries) ──────────
//
// Hand these to a third-party library so it records into the same pipeline:
//   someLib.init({ meterProvider: getOtelMeterProvider() });
// then the library names its own meter: meterProvider.getMeter('their-lib', '1.0').
//
// They return the in-process provider an OTel block initialized; if no block has run
// yet they fall back to the `@opentelemetry/api` global provider (which the SDK also
// registers via setGlobal*Provider), so a library using the API's global getMeter()
// works without any wiring. Zero-arg and never throw.

/** The active `MeterProvider` (initialized SDK, else the API global). */
export function getOtelMeterProvider(): ApiMeterProvider {
	const sdk = (globalThis as any)[SDK_KEY] as OtelSdk | undefined;
	return sdk?.meterProvider ?? metrics.getMeterProvider();
}

/** The active `TracerProvider` (initialized SDK, else the API global). */
export function getOtelTracerProvider(): ApiTracerProvider {
	const sdk = (globalThis as any)[SDK_KEY] as OtelSdk | undefined;
	return sdk?.tracerProvider ?? trace.getTracerProvider();
}

/** The active `LoggerProvider` (initialized SDK, else the Logs-API global). */
export function getOtelLoggerProvider(): ApiLoggerProvider {
	const sdk = (globalThis as any)[SDK_KEY] as OtelSdk | undefined;
	return sdk?.loggerProvider ?? logs.getLoggerProvider();
}
