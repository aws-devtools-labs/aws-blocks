// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Shared types for the OpenTelemetry building blocks. Zero runtime dependencies.
 *
 * The OTel family (`OtelMetrics` / `OtelLogger` / `OtelTracer`) exports telemetry
 * via an in-process OTel SDK to a standalone OpenTelemetry Collector Lambda layer
 * (running on `localhost:4318`), which signs with SigV4 and forwards to CloudWatch's
 * native OTLP endpoints. See `@aws-blocks/otel-common/cdk` for the infra helper and
 * `collector-config.ts` for the rendered collector configuration.
 */

/** The three OTel signals the collector pipelines and IAM grants are keyed on. */
export type OtelSignal = 'traces' | 'metrics' | 'logs';

/** Which signals to enable. Omitted fields default to `true`. */
export interface OtelSignals {
	traces?: boolean;
	metrics?: boolean;
	logs?: boolean;
}

/**
 * Override the default CloudWatch-OTLP export target with a third-party OTLP
 * backend. When set, the collector emits a single `otlphttp` exporter pointed at
 * `endpoint` with the given `headers` and **no** SigV4 signing (and no AWS IAM
 * grants are attached).
 */
export interface OtelEndpointOverride {
	/** Base OTLP/HTTP endpoint (the collector appends `/v1/{signal}`). */
	endpoint: string;
	/** Static headers (e.g. an API key) sent on every export request. */
	headers?: Record<string, string>;
}

/**
 * Options for `getOrCreateOtelSharedInfra` (CDK). All fields optional; sensible
 * CloudWatch-OTLP defaults are used otherwise.
 */
export interface OtelSharedInfraOptions {
	/** Which signals to enable. Defaults to all three. */
	signals?: OtelSignals;
	/** Full collector-layer ARN override. Takes precedence over `layerVersion`/`architecture`. */
	layerArn?: string;
	/**
	 * Version token of the standalone `opentelemetry-collector` layer (e.g. `'0_15_0'`).
	 * Defaults to {@link DEFAULT_COLLECTOR_LAYER_VERSION}.
	 */
	layerVersion?: string;
	/** Lambda architecture token for the collector layer. Defaults to `'amd64'` (x86_64). */
	architecture?: 'amd64' | 'arm64';
	/** Redirect all signals to a third-party OTLP backend instead of CloudWatch. */
	endpointOverride?: OtelEndpointOverride;
	/**
	 * CloudWatch Logs group for the logs signal. Defaults to `/aws/otel/<scope.fullId>`.
	 * The group and stream are created by the helper (the OTLP logs endpoint requires
	 * a pre-existing group + stream).
	 */
	logGroupName?: string;
	/** CloudWatch Logs stream for the logs signal. Defaults to `'default'`. */
	logStreamName?: string;
}

/**
 * Inputs to the pure collector-config renderer. Region must be concrete (token-free)
 * for the asset-based config-layer path.
 */
export interface CollectorConfigInput {
	region: string;
	signals: Required<OtelSignals>;
	logGroupName: string;
	logStreamName: string;
	endpointOverride?: OtelEndpointOverride;
}

/**
 * Service identity for the OTel SDK `Resource`, following the OpenTelemetry
 * {@link https://opentelemetry.io/docs/specs/semconv/resource/service/ service semantic conventions}.
 * Set once per process (the SDK Resource is a process-wide singleton).
 */
export interface OtelResourceOptions {
	/**
	 * `service.name` — the logical service name. Defaults to the `BLOCKS_STACK_NAME`
	 * env var, falling back to the constructing block's scope `fullId`.
	 */
	serviceName?: string;
	/** `service.namespace` — a grouping for related services (e.g. team or system). */
	serviceNamespace?: string;
	/** `service.version` — the service version string. */
	serviceVersion?: string;
	/** Additional resource attributes merged onto the base service identity. */
	attributes?: Record<string, string | number | boolean>;
}

/**
 * Options for the in-process OTel SDK (`getOrCreateOtelSdk`). The defaults target
 * the local collector; the mock runtime overrides the exporter destination.
 */
export interface OtelSdkOptions {
	/** Service identity (semconv resource attributes). */
	resource?: OtelResourceOptions;
	/**
	 * Fallback `service.name` when `resource.serviceName` and `BLOCKS_STACK_NAME` are
	 * both unset — typically the constructing block's scope `fullId`.
	 */
	defaultServiceName?: string;
	/** Collector OTLP/HTTP base URL. Defaults to `http://localhost:4318`. */
	collectorUrl?: string;
}
