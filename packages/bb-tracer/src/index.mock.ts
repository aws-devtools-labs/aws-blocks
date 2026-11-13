// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { Scope } from '@aws-blocks/core';
import { getMockDataDir, assertNotMockInDeployedEnv } from '@aws-blocks/core/bb-utils';
import type { ScopeParent } from '@aws-blocks/core';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import type { TracerOptions, Segment as ISegment, AnnotationValue } from './types.js';
import { Logger } from '@aws-blocks/bb-logger';
import type { ChildLogger } from '@aws-blocks/bb-logger';
import { BB_NAME, BB_VERSION } from './version.js';

// Fail closed if this mock entry loads in a deployed env — see assertNotMockInDeployedEnv.
assertNotMockInDeployedEnv('bb-tracer');

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

interface TraceState {
	traceId: string | null;
	rootAnnotations: Record<string, AnnotationValue>;
	rootMetadata: Record<string, unknown>;
	closed: boolean;
}

interface TraceContext {
	trace: TraceState;
	sampled: boolean;
	record?: TraceRecord;
	parent?: TraceContext;
	closed: boolean;
}

function createTraceState(): TraceState {
	return { traceId: null, rootAnnotations: {}, rootMetadata: {}, closed: false };
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
	private context = new AsyncLocalStorage<TraceContext>();
	// Preserve annotations and IDs set before startSegment, without sharing
	// this staging state with a root that has already started.
	private pendingTrace = createTraceState();

	/** @internal Logger for internal operations. Defaults to error-level when not provided. */
	protected log: ChildLogger;

	constructor(scope: ScopeParent, id: string, options?: TracerOptions) {
		super(id, { parent: scope, bbName: BB_NAME, bbVersion: BB_VERSION });
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

		const parent = this.getActiveContext();
		const trace = parent?.trace ?? this.pendingTrace;
		if (!parent) this.pendingTrace = createTraceState();
		// Sample once per root, including unsampled roots, and inherit only
		// through that root's async context rather than other in-flight work.
		const sampled = parent ? parent.sampled : this.shouldSample();
		const context: TraceContext = { trace, sampled, parent, closed: false };
		if (!sampled) {
			return this.context.run(context, async () => {
				try {
					return await fn(NO_OP_SEGMENT);
				} finally {
					context.closed = true;
					if (!parent) trace.closed = true;
				}
			});
		}
		trace.traceId ??= randomUUID();

		const segment = new MockSegment();
		const startTime = Date.now();

		const record: TraceRecord = {
			traceId: trace.traceId,
			segment: name,
			startTime,
			endTime: 0,
			durationMs: 0,
			annotations: {},
			metadata: {},
			children: [],
		};

		parent?.record?.children.push(record);
		context.record = record;

		return this.context.run(context, async () => {
			try {
				return await fn(segment);
			} catch (error) {
				segment.addError(error as Error);
				throw error;
			} finally {
				context.closed = true;
				if (!parent) trace.closed = true;
				this.finalizeRecord(record, Date.now(), segment);
				if (!parent) {
					record.rootAnnotations = { ...trace.rootAnnotations };
					record.rootMetadata = { ...trace.rootMetadata };
					this.persistTrace(record);
					this.logTrace(record);
				}
			}
		});
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
		const trace = this.getActiveContext()?.trace ?? this.pendingTrace;
		trace.rootAnnotations[key] = value;
	}

	/**
	 * Add non-searchable metadata to the current root segment.
	 *
	 * @param key - Metadata key.
	 * @param value - Any JSON-serializable value.
	 */
	addMetadata(key: string, value: unknown): void {
		if (!this.enabled) return;
		const trace = this.getActiveContext()?.trace ?? this.pendingTrace;
		trace.rootMetadata[key] = value;
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
		const trace = this.getActiveContext()?.trace ?? this.pendingTrace;
		trace.traceId ??= randomUUID();
		return trace.traceId;
	}

	// ── Private helpers ─────────────────────────────────────────────────────

	private getActiveContext(): TraceContext | undefined {
		let context = this.context.getStore();
		// Timers retain their async store after the originating segment closes.
		// A closed root invalidates even descendants that are still running.
		if (context?.trace.closed) return undefined;
		while (context?.closed) context = context.parent;
		return context;
	}

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
