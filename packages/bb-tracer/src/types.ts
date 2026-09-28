// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Shared types for Tracer BB. Imported by mock, aws, cdk, and browser entry points.
 * This file has zero runtime dependencies — types only.
 */
import type { ChildLogger } from '@aws-blocks/bb-logger';

/** Valid annotation value types for X-Ray indexing. */
export type AnnotationValue = string | number | boolean;

/**
 * A traced subsegment handle passed to the `startSegment` callback.
 * Use this to add annotations, metadata, and record errors within the
 * scope of a specific operation.
 */
export interface Segment {
	/**
	 * Add a searchable annotation to this segment.
	 * Annotations are indexed by X-Ray and can be used to filter traces.
	 *
	 * @param key - Annotation key (keep cardinality low).
	 * @param value - String, number, or boolean value.
	 */
	addAnnotation(key: string, value: AnnotationValue): void;

	/**
	 * Add non-searchable metadata to this segment.
	 * Metadata is visible when viewing individual traces but not indexed.
	 *
	 * @param key - Metadata key.
	 * @param value - Any JSON-serializable value.
	 */
	addMetadata(key: string, value: unknown): void;

	/**
	 * Record an error on this segment without re-throwing.
	 * The segment is marked as faulted and the error details are attached.
	 * Use when you catch and handle an error but want it visible in traces.
	 *
	 * @param error - The error to record.
	 */
	addError(error: Error): void;

	/**
	 * Record the HTTP response status code on this segment.
	 * Helps X-Ray categorize responses (2xx, 4xx, 5xx).
	 *
	 * @param statusCode - HTTP status code (e.g., 200, 404, 500).
	 */
	setHttpStatus(statusCode: number): void;
}

/**
 * Configuration options for the Tracer Building Block.
 */
export interface TracerOptions {
	/**
	 * Enable or disable tracing. Default: `true`.
	 * When `false`, all runtime operations are silent no-ops but `startSegment`
	 * still executes the wrapped function normally.
	 *
	 * **At deploy time this is not a global off switch.** Tracing is presence-gated
	 * and fleet-wide: `enabled: false` only means *this* `Tracer` doesn't opt in.
	 * If any other `Tracer` exists in the app, X-Ray is still enabled on every
	 * compute. To keep X-Ray off, don't construct a `Tracer` at all.
	 */
	enabled?: boolean;

	/**
	 * Sampling rate between 0 and 1. Default: `1.0`.
	 *
	 * @remarks In production (AWS runtime), sampling is controlled by
	 * X-Ray sampling rules — this option is ignored. It only affects
	 * local mock behavior where X-Ray sampling infrastructure is absent.
	 *
	 * A value of `0.1` means roughly 10% of local traces are recorded.
	 */
	samplingRate?: number;
	/** Optional logger for internal operations. When omitted, a default Logger at error level is created. */
	logger?: ChildLogger;
}
