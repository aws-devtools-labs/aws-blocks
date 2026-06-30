// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { Scope } from '@aws-blocks/core';
import { getMockDataDir } from '@aws-blocks/core/bb-utils';
import type { ScopeParent } from '@aws-blocks/core';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { TracerOptions, Segment as ISegment, AnnotationValue } from './types.js';
import { Logger } from '@aws-blocks/bb-logger';
import type { ChildLogger } from '@aws-blocks/bb-logger';

export type { TracerOptions, Segment, AnnotationValue } from './types.js';

// ── Internal Types ──────────────────────────────────────────────────────────

interface TraceRecord {
	traceId: string;
	segment: string;
	startTime: number;
	endTime: number;
	durationMs: number;
	annotations: Record<string, AnnotationValue>;
	metadata: Record<string, unknown>;
	error?: { name: string; message: string };
	httpStatus?: number;
	children: TraceRecord[];
	rootAnnotations?: Record<string, AnnotationValue>;
	rootMetadata?: Record<string, unknown>;
}

// ── Mock Segment ────────────────────────────────────────────────────────────

class MockSegment implements ISegment {
	public annotations: Record<string, AnnotationValue> = {};
	public metadata: Record<string, unknown> = {};
	public error?: { name: string; message: string };
	public httpStatus?: number;

	addAnnotation(key: string, value: AnnotationValue): void {
		this.annotations[key] = value;
	}

	addMetadata(key: string, value: unknown): void {
		this.metadata[key] = value;
	}

	addError(error: Error): void {
		this.error = { name: error.name, message: error.message };
	}

	setHttpStatus(statusCode: number): void {
		this.httpStatus = statusCode;
	}
}

// ── Tracer (mock) ──────────────────────────────────────────────────────────

/**
 * Distributed tracing backed by AWS X-Ray.
 *
 * **When to use:** You need to trace request flow across services, debug
 * latency issues, or visualize service dependencies. Good for identifying
 * bottlenecks, understanding call chains, and correlating failures across
 * Building Blocks.
 *
 * **When NOT to use:** If you need structured log output, use `Logging`. If
 * you need numeric measurements over time, use `Metrics`.
 *
 * **Best practices:**
 * - Use `startSegment` to wrap discrete units of work (DB calls, HTTP requests, business logic)
 * - Keep segment names short and descriptive (e.g., `'fetchUser'`, `'processPayment'`)
 * - Use annotations for values you want to filter/search by in the X-Ray console
 * - Use metadata for large or complex debugging data you don't need to search
 * - Keep annotation cardinality low (avoid user-specific values as annotation keys)
 *
 * **Scaling:** No throughput limits from the BB itself. X-Ray sampling controls
 * trace volume. Cost is per trace recorded and per trace retrieved. Use
 * `samplingRate` to control volume in high-throughput scenarios.
 */
export class Tracer extends Scope {
	private enabled: boolean;
	private samplingRate: number;
	private tracesFilePath: string;
	private currentTraceId: string | null = null;
	private rootAnnotations: Record<string, AnnotationValue> = {};
	private rootMetadata: Record<string, unknown> = {};
	private segmentStack: TraceRecord[] = [];
	/**
	 * Depth tracker for an in-flight *unsampled* trace. The sampled path tracks
	 * nesting via `segmentStack`, but an unsampled root pushes nothing, so a
	 * counter is needed to keep its subsegments unsampled too (rather than
	 * letting them re-roll and spawn their own root traces).
	 */
	private unsampledDepth = 0;

	/** @internal Logger for internal operations. Defaults to error-level when not provided. */
	protected log: ChildLogger;

	constructor(scope: ScopeParent, id: string, options?: TracerOptions) {
		super(id, { parent: scope });
		this.log = options?.logger ?? new Logger(this, 'logger', { level: 'error' });
		this.enabled = options?.enabled !== false;
		const rate = options?.samplingRate ?? 1.0;
		if (rate < 0 || rate > 1) {
			throw new RangeError('samplingRate must be between 0 and 1');
		}
		this.samplingRate = rate;
		this.tracesFilePath = join(getMockDataDir(this), 'traces.json');
	}

	/**
	 * Wrap an async function in a traced subsegment.
	 * The segment is automatically closed when fn completes or throws.
	 * Errors are recorded on the segment and re-thrown.
	 *
	 * @param name - Human-readable name for the segment (e.g., 'fetchUser').
	 * @param fn - Async function to execute within the traced segment.
	 * @returns The return value of `fn`.
	 */
	async startSegment<T>(name: string, fn: (segment: ISegment) => Promise<T>): Promise<T> {
		if (!this.enabled) {
			return fn(NO_OP_SEGMENT);
		}

		// Sampling is a per-trace decision: roll it once at the root segment and
		// have every subsegment inherit it, so a trace is recorded whole or not
		// at all. Rolling per subsegment (the previous behavior) would randomly
		// drop children from a sampled trace, or promote a subsegment of an
		// unsampled trace into its own orphan root trace.
		const inActiveTrace = this.segmentStack.length > 0 || this.unsampledDepth > 0;
		const sampled = inActiveTrace ? this.unsampledDepth === 0 : this.shouldSample();
		if (!sampled) {
			this.unsampledDepth++;
			try {
				return await fn(NO_OP_SEGMENT);
			} finally {
				this.unsampledDepth--;
			}
		}

		if (!this.currentTraceId) {
			this.currentTraceId = randomUUID();
		}

		const segment = new MockSegment();
		const startTime = Date.now();
		const isTopLevel = this.segmentStack.length === 0;

		// Create a placeholder record and push onto stack
		const record: TraceRecord = {
			traceId: this.currentTraceId!,
			segment: name,
			startTime,
			endTime: 0,
			durationMs: 0,
			annotations: {},
			metadata: {},
			children: [],
		};

		// If there's a parent on the stack, add this as a child
		if (!isTopLevel) {
			this.segmentStack[this.segmentStack.length - 1].children.push(record);
		}

		this.segmentStack.push(record);

		try {
			const result = await fn(segment);
			const endTime = Date.now();

			this.finalizeRecord(record, endTime, segment);
			this.segmentStack.pop();

			if (isTopLevel) {
				record.rootAnnotations = { ...this.rootAnnotations };
				record.rootMetadata = { ...this.rootMetadata };
				this.persistTrace(record);
				this.logTrace(record);
				this.currentTraceId = null;
				this.rootAnnotations = {};
				this.rootMetadata = {};
			}

			return result;
		} catch (error) {
			const endTime = Date.now();
			segment.addError(error as Error);

			this.finalizeRecord(record, endTime, segment);
			this.segmentStack.pop();

			if (isTopLevel) {
				record.rootAnnotations = { ...this.rootAnnotations };
				record.rootMetadata = { ...this.rootMetadata };
				this.persistTrace(record);
				this.logTrace(record);
				this.currentTraceId = null;
				this.rootAnnotations = {};
				this.rootMetadata = {};
			}

			throw error;
		}
	}

	/**
	 * Add a searchable annotation to the current root segment.
	 * In AWS: adds to the Lambda facade segment.
	 * In mock: adds to the top-level trace record.
	 *
	 * @param key - Annotation key.
	 * @param value - String, number, or boolean value.
	 */
	addAnnotation(key: string, value: AnnotationValue): void {
		if (!this.enabled) return;
		this.rootAnnotations[key] = value;
	}

	/**
	 * Add non-searchable metadata to the current root segment.
	 *
	 * @param key - Metadata key.
	 * @param value - Any JSON-serializable value.
	 */
	addMetadata(key: string, value: unknown): void {
		if (!this.enabled) return;
		this.rootMetadata[key] = value;
	}

	/**
	 * Get the current trace ID, or null if tracing is disabled / no active trace.
	 * Useful for correlating logs with traces.
	 *
	 * In AWS: returns the X-Ray trace ID from _X_AMZN_TRACE_ID.
	 * In mock: returns a generated UUID trace ID.
	 */
	getTraceId(): string | null {
		if (!this.enabled) return null;
		if (!this.currentTraceId) {
			this.currentTraceId = randomUUID();
		}
		return this.currentTraceId;
	}

	// ── Private helpers ─────────────────────────────────────────────────────

	private shouldSample(): boolean {
		return Math.random() < this.samplingRate;
	}

	private finalizeRecord(record: TraceRecord, endTime: number, segment: MockSegment): void {
		record.endTime = endTime;
		record.durationMs = endTime - record.startTime;
		record.annotations = { ...segment.annotations };
		record.metadata = { ...segment.metadata };
		if (segment.error) record.error = segment.error;
		if (segment.httpStatus !== undefined) record.httpStatus = segment.httpStatus;
	}

	private persistTrace(record: TraceRecord): void {
		let traces: TraceRecord[] = [];
		if (existsSync(this.tracesFilePath)) {
			try {
				traces = JSON.parse(readFileSync(this.tracesFilePath, 'utf8'));
			} catch { /* corrupted file — start fresh */ }
		}
		traces.push(record);
		if (traces.length > 100) {
			traces = traces.slice(-100);
		}
		writeFileSync(this.tracesFilePath, JSON.stringify(traces, null, 2));
	}

	private logTrace(record: TraceRecord): void {
		console.log(JSON.stringify({
			_type: 'trace',
			traceId: record.traceId,
			segment: record.segment,
			durationMs: record.durationMs,
			annotations: Object.keys(record.annotations).length > 0 ? record.annotations : undefined,
			metadata: Object.keys(record.metadata).length > 0 ? record.metadata : undefined,
			error: record.error,
			httpStatus: record.httpStatus,
		}, null, 2));
	}
}

// No-op segment for disabled/unsampled traces
const NO_OP_SEGMENT: ISegment = {
	addAnnotation() {},
	addMetadata() {},
	addError() {},
	setHttpStatus() {},
};
