// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import AWSXRay from 'aws-xray-sdk-core';
import { Scope } from '@aws-blocks/core';
import type { ScopeParent } from '@aws-blocks/core';
import type { TracerOptions, Segment as ISegment, AnnotationValue } from './types.js';
import { Logger } from '@aws-blocks/bb-logger';
import type { ChildLogger } from '@aws-blocks/bb-logger';
import { BB_NAME, BB_VERSION } from './version.js';

export type { TracerOptions, Segment, AnnotationValue } from './types.js';

// ── X-Ray Segment Adapter ───────────────────────────────────────────────────

class XRaySegment implements ISegment {

	constructor(private subsegment: AWSXRay.Subsegment) {}

	addAnnotation(key: string, value: AnnotationValue): void {
		this.subsegment.addAnnotation(key, value);
	}

	addMetadata(key: string, value: unknown): void {
		this.subsegment.addMetadata(key, value);
	}

	addError(error: Error): void {
		this.subsegment.addError(error, false);
	}

	setHttpStatus(statusCode: number): void {
		// Use native X-Ray HTTP response field instead of annotation
		(this.subsegment as any).http = {
			...(this.subsegment as any).http,
			response: { status: statusCode }
		};
		if (statusCode >= 500) {
			this.subsegment.addFaultFlag();
		} else if (statusCode >= 400) {
			this.subsegment.addErrorFlag();
		}
	}
}

// ── Tracer (AWS runtime) ───────────────────────────────────────────────────

export class Tracer extends Scope {
	private enabled: boolean;
	/** @internal Logger for internal operations. Defaults to error-level when not provided. */
	protected log: ChildLogger;

	constructor(scope: ScopeParent, id: string, options?: TracerOptions) {
		super(id, { parent: scope, bbName: BB_NAME, bbVersion: BB_VERSION });
		this.log = options?.logger ?? new Logger(this, 'logger', { level: 'error' });
		this.enabled = options?.enabled !== false;
	}

	/**
	 * Wrap an async function in a traced X-Ray subsegment.
	 * The segment is automatically closed when fn completes or throws.
	 * Errors are recorded on the segment and re-thrown.
	 *
	 * @param name - Human-readable name for the segment.
	 * @param fn - Async function to execute within the traced segment.
	 * @returns The return value of `fn`.
	 */
	async startSegment<T>(name: string, fn: (segment: ISegment) => Promise<T>): Promise<T> {
		if (!this.enabled) {
			return fn(NO_OP_SEGMENT);
		}

		const parentSegment = AWSXRay.getSegment();
		if (!parentSegment) {
			return fn(NO_OP_SEGMENT);
		}

		const subsegment = parentSegment.addNewSubsegment(name);
		try {
			const result = await fn(new XRaySegment(subsegment));
			subsegment.close();
			return result;
		} catch (error) {
			subsegment.addError(error as Error, false);
			subsegment.close();
			throw error;
		}
	}

	/**
	 * Add a searchable annotation to the Lambda facade segment.
	 *
	 * @param key - Annotation key.
	 * @param value - String, number, or boolean value.
	 */
	addAnnotation(key: string, value: AnnotationValue): void {
		if (!this.enabled) return;
		const segment = AWSXRay.getSegment();
		if (segment) segment.addAnnotation(key, value);
	}

	/**
	 * Add non-searchable metadata to the Lambda facade segment.
	 *
	 * @param key - Metadata key.
	 * @param value - Any JSON-serializable value.
	 */
	addMetadata(key: string, value: unknown): void {
		if (!this.enabled) return;
		const segment = AWSXRay.getSegment();
		if (segment) segment.addMetadata(key, value);
	}

	/**
	 * Get the current X-Ray trace ID, or null if tracing is disabled / no active trace.
	 * Useful for correlating logs with traces.
	 */
	getTraceId(): string | null {
		if (!this.enabled) return null;
		const traceId = process.env._X_AMZN_TRACE_ID;
		if (!traceId) return null;
		const match = traceId.match(/Root=([^;]+)/);
		return match ? match[1] : null;
	}
}

// No-op segment for disabled/unavailable tracing
const NO_OP_SEGMENT: ISegment = {
	addAnnotation() {},
	addMetadata() {},
	addError() {},
	setHttpStatus() {},
};
