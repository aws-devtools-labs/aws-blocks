// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * `@aws-blocks/otel-common` — runtime entry point.
 *
 * Shared, framework-agnostic helpers for the OpenTelemetry building blocks:
 * the in-process SDK bootstrap (`getOrCreateOtelSdk`), the per-invocation flush
 * (`flushOtel`), and the pure collector-config renderer. The CDK infra helper
 * lives in the `./cdk` subpath (it imports `aws-cdk-lib`).
 */

export {
	getOrCreateOtelSdk,
	registerOtelFlusher,
	flushOtel,
	getOtelMeterProvider,
	getOtelTracerProvider,
	getOtelLoggerProvider,
} from './sdk.js';
export type { OtelExporters, OtelSdk } from './sdk.js';
export { mockExporters, FileSpanExporter } from './mock.js';
export { renderCollectorConfig } from './collector-config.js';
export {
	DEFAULT_COLLECTOR_LAYER_VERSION,
	COLLECTOR_LAYER_ACCOUNT,
	COLLECTOR_LOCAL_PORT,
} from './constants.js';
export type {
	OtelSignal,
	OtelSignals,
	OtelEndpointOverride,
	OtelSharedInfraOptions,
	CollectorConfigInput,
	OtelSdkOptions,
	OtelResourceOptions,
} from './types.js';
