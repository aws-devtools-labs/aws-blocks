// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { Scope } from '@aws-blocks/core';
import type { ScopeParent } from '@aws-blocks/core';
import { trace, context as otelContext, propagation, SpanKind, SpanStatusCode } from '@opentelemetry/api';
import type { Span, Tracer, Context } from '@opentelemetry/api';
import { getOrCreateOtelSdk } from '@aws-blocks/otel-common';
import type { AnnotationValue, Segment as ISegment, StartSegmentOptions, OtelTracerOptions } from './types.js';

export type { Segment, AnnotationValue, StartSegmentOptions, OtelTracerOptions, SpanKind, Link, Tracer, Context } from './types.js';

/** Prefix for non-indexed "metadata" attributes (distinct from searchable annotations). */
const METADATA_PREFIX = 'metadata.';

// ── Span adapter ──────────────────────────────────────────────────────────────

class SpanSegment implements ISegment {
	constructor(private span: Span) {}

	addAnnotation(key: string, value: AnnotationValue): void {
		this.span.setAttribute(key, value);
	}

	addMetadata(key: string, value: unknown): void {
		// X-Ray metadata is non-searchable; OTel has only attributes, so namespace the
		// key and stringify non-primitive values. Searchability is governed by X-Ray
		// indexing rules, not by this annotation/metadata split.
		const v = typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
			? value
			: JSON.stringify(value);
		this.span.setAttribute(`${METADATA_PREFIX}${key}`, v as AnnotationValue);
	}

	addEvent(name: string, attributes?: Record<string, AnnotationValue>): void {
		this.span.addEvent(name, attributes);
	}

	addError(error: Error): void {
		this.span.recordException(error);
		this.span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
	}

	setHttpStatus(statusCode: number): void {
		this.span.setAttribute('http.response.status_code', statusCode);
		if (statusCode >= 500) this.span.setStatus({ code: SpanStatusCode.ERROR });
	}
}

const NO_OP_SEGMENT: ISegment = {
	addAnnotation() {},
	addMetadata() {},
	addEvent() {},
	addError() {},
	setHttpStatus() {},
};

// ── OtelTracer ──────────────────────────────────────────────────────────────

/**
 * Distributed tracing via OpenTelemetry, exported to AWS X-Ray through CloudWatch's
 * OTLP traces endpoint (in-process OTel SDK + collector layer).
 *
 * Keeps the `startSegment(name, fn)` callback shape of the X-Ray-based `Tracer`, plus
 * span kind/links/events, manual W3C context propagation (`inject`/`extract`), and the
 * raw OTel `Tracer` (`rawTracer`).
 *
 * **Prerequisite:** CloudWatch **Transaction Search** must be enabled in the account/
 * region for spans to be queryable (they land in the `aws/spans` log group).
 */
export class OtelTracer extends Scope {
	private enabled: boolean;
	private tracer: Tracer;

	constructor(scope: ScopeParent, id: string, options?: OtelTracerOptions) {
		super(id, { parent: scope });
		this.enabled = options?.enabled !== false;
		if (this.enabled) {
			getOrCreateOtelSdk({
				resource: {
					serviceName: options?.serviceName,
					serviceNamespace: options?.serviceNamespace,
					serviceVersion: options?.serviceVersion,
				},
				defaultServiceName: this.fullId,
			});
		}
		this.tracer = trace.getTracer(this.fullId);
	}

	/**
	 * Wrap an async function in a traced span (auto-closed; errors recorded + re-thrown).
	 */
	async startSegment<T>(name: string, fn: (segment: ISegment) => Promise<T>, options?: StartSegmentOptions): Promise<T> {
		if (!this.enabled) return fn(NO_OP_SEGMENT);

		return this.tracer.startActiveSpan(
			name,
			{ kind: options?.kind ?? SpanKind.INTERNAL, links: options?.links, attributes: options?.attributes },
			async (span) => {
				try {
					const result = await fn(new SpanSegment(span));
					span.setStatus({ code: SpanStatusCode.OK });
					return result;
				} catch (error) {
					span.recordException(error as Error);
					span.setStatus({ code: SpanStatusCode.ERROR, message: (error as Error).message });
					throw error;
				} finally {
					span.end();
				}
			},
		);
	}

	/** Add a searchable annotation to the currently-active span. */
	addAnnotation(key: string, value: AnnotationValue): void {
		if (!this.enabled) return;
		trace.getActiveSpan()?.setAttribute(key, value);
	}

	/** Add non-indexed metadata to the currently-active span. */
	addMetadata(key: string, value: unknown): void {
		if (!this.enabled) return;
		const v = typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
			? value
			: JSON.stringify(value);
		trace.getActiveSpan()?.setAttribute(`${METADATA_PREFIX}${key}`, v as AnnotationValue);
	}

	/** Add a timestamped event to the currently-active span. */
	addEvent(name: string, attributes?: Record<string, AnnotationValue>): void {
		if (!this.enabled) return;
		trace.getActiveSpan()?.addEvent(name, attributes);
	}

	/** Get the current trace ID for log correlation, or null if none/disabled. */
	getTraceId(): string | null {
		if (!this.enabled) return null;
		const ctx = trace.getActiveSpan()?.spanContext();
		return ctx?.traceId ?? null;
	}

	/** Inject the active trace context into a carrier (W3C propagation) for outbound calls. */
	inject(carrier: Record<string, string>): void {
		if (!this.enabled) return;
		propagation.inject(otelContext.active(), carrier);
	}

	/** Extract a trace context from an inbound carrier. */
	extract(carrier: Record<string, string>): Context {
		return propagation.extract(otelContext.active(), carrier);
	}

	/** The underlying OTel `Tracer` — full escape hatch. */
	get rawTracer(): Tracer {
		return this.tracer;
	}
}
