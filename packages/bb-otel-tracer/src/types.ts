// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Shared types for the OTel Tracer building block. Zero runtime dependencies
 * beyond type-only imports from `@opentelemetry/api`.
 *
 * `OtelTracer` keeps the `startSegment` ergonomics of the X-Ray-based `Tracer`
 * (segment annotations/metadata, HTTP status, error capture) while exposing OTel's
 * span kind, links, events, manual context propagation, and the raw `Tracer`.
 */
import type { SpanKind, Link, Tracer, Context } from '@opentelemetry/api';

/** Valid annotation value types. */
export type AnnotationValue = string | number | boolean;

/**
 * A traced segment handle passed to the `startSegment` callback — the OTel-backed
 * analogue of the X-Ray `Segment`.
 */
export interface Segment {
	/** Add a searchable attribute (X-Ray "annotation"). */
	addAnnotation(key: string, value: AnnotationValue): void;
	/** Add non-indexed metadata (stored as a namespaced attribute). */
	addMetadata(key: string, value: unknown): void;
	/** Add a timestamped span event. */
	addEvent(name: string, attributes?: Record<string, AnnotationValue>): void;
	/** Record an error on the span (does not re-throw). */
	addError(error: Error): void;
	/** Record the HTTP response status code (sets `http.response.status_code` + span status). */
	setHttpStatus(statusCode: number): void;
}

/** Options for a single `startSegment`. */
export interface StartSegmentOptions {
	/** OTel span kind. Defaults to `INTERNAL`. */
	kind?: SpanKind;
	/** Links to other spans. */
	links?: Link[];
	/** Initial attributes. */
	attributes?: Record<string, AnnotationValue>;
}

/** Configuration for the OTel Tracer building block. */
export interface OtelTracerOptions {
	/** Enable or disable tracing. Default: `true`. When `false`, `startSegment` still runs `fn`. */
	enabled?: boolean;
	/**
	 * `service.name` resource attribute (OTel semconv). Set once per process via the SDK
	 * Resource. Defaults to `BLOCKS_STACK_NAME`, then the block's scope `fullId`.
	 */
	serviceName?: string;
	/** `service.namespace` resource attribute — a grouping for related services. */
	serviceNamespace?: string;
	/** `service.version` resource attribute. */
	serviceVersion?: string;
}

// Re-export OTel handle types for the escape-hatch surface.
export type { SpanKind, Link, Tracer, Context } from '@opentelemetry/api';
