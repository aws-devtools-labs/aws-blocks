// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import type { StandardSchemaV1 } from '@standard-schema/spec';
import type { ComputeProvider } from '@aws-blocks/core/cdk/internal';
import type { ChildLogger } from '@aws-blocks/bb-logger';

/**
 * Context passed to the AsyncJob handler with metadata about the current job.
 */
export interface AsyncJobContext {
	/** Unique identifier for this job (SQS message ID in AWS, truncated UUID in mock). */
	jobId: string;
	/** Number of times this message has been received (1 on first delivery). */
	receiveCount: number;
	/** ISO 8601 timestamp of when the message was sent. */
	sentAt: string;
}

/**
 * Configuration options for creating an AsyncJob.
 *
 * Generic over `C`, the {@link ComputeProvider} passed as `compute` (defaulting
 * to a serverless provider when none is given). Container-only options such as
 * `maxConcurrencyPerCPU` are merged in only when `C` is a container compute —
 * see {@link ContainerOnlyJobOptions}.
 */
export type AsyncJobOptions<T, C extends ComputeProvider = ComputeProvider<'serverless'>> = {
	/** Async function that processes each job payload. */
	handler: (payload: T, context: AsyncJobContext) => Promise<void>;
	/** Optional schema for runtime payload validation on submit. Accepts any StandardSchemaV1 implementation (Zod, Valibot, ArkType, etc.). */
	schema?: StandardSchemaV1<T>;
	/** Maximum retry attempts before sending to the DLQ. Default: 3. */
	maxRetries?: number;
	/**
	 * Number of messages the Lambda trigger receives per invocation. 1–10, or up
	 * to 10000 when `maxBatchingWindowSeconds` is greater than 0. Out-of-range
	 * values throw `InvalidOptionException` at synth time. Default: 10.
	 */
	batchSize?: number;
	/**
	 * How long SQS waits to accumulate a full batch before invoking the Lambda,
	 * in seconds. 0–300; out-of-range values throw `InvalidOptionException` at
	 * synth time. Higher values fill batches more completely (lower cost) at the
	 * price of added latency. Default: 5.
	 */
	maxBatchingWindowSeconds?: number;
	/**
	 * Record every job's state transitions so they can be read back with
	 * `getStatus()` / `waitUntilComplete()`. Default: `false`.
	 *
	 * Enabling this provisions one DynamoDB table for the job's status records
	 * and adds a write on submit plus one per state change. Leave it off for
	 * pure fire-and-forget work.
	 */
	trackStatus?: boolean;
	/** Optional logger for internal operations. When omitted, a default Logger at error level is created. */
	logger?: ChildLogger;
	/**
	 * The compute this job's handler runs on. Pass a `Compute` block (or any
	 * {@link ComputeProvider}) to place the handler on a different runtime than the
	 * app default — e.g. a long-running or high-memory job that a container
	 * (Fargate) can serve but a serverless compute cannot.
	 *
	 * When omitted, the job runs on the app's default (serverless) compute, exactly
	 * as today. Assigning a container-backed compute moves delivery from a native
	 * SQS event source to an owner-matched poller the container self-starts; the
	 * per-handler wall-clock limit comes from the compute's `timeoutSeconds`. In
	 * local dev, compute assignment is transparent — the handler runs in-process.
	 */
	compute?: C;

	/**
	 * Wall-clock limit for one delivery, in seconds. A property of the work, not
	 * the compute. On a container it is enforced by the runtime (the job's worker
	 * is terminated at the deadline); on a serverless compute it is bounded by the
	 * function timeout. Must fit under the compute's ceiling where one exists.
	 */
	timeoutSeconds?: number;
} & ContainerOnlyJobOptions<C>;

/**
 * Options that apply only when the job runs on a **container** compute. Merged
 * into {@link AsyncJobOptions} conditionally on the injected compute's kind, so
 * these fields are present only for a container compute and are a **compile
 * error** on a serverless one (not a silently-ignored property). Resolves to
 * `{}` for a serverless compute or when no compute is assigned (the app default
 * is serverless).
 */
export type ContainerOnlyJobOptions<C extends ComputeProvider> = C extends ComputeProvider<'container'>
	? {
			/**
			 * How many deliveries of this job run at once per instance, expressed
			 * **per vCPU**. Blocks multiplies by the compute's vCPU count for the
			 * per-instance concurrency: `max(1, ceil(maxConcurrencyPerCPU × vcpu))`.
			 * Higher for IO-bound work that mostly awaits; 1 (or omit) for CPU-bound
			 * work. Container-only — exposed only when the injected `compute` is a
			 * container; setting it with a serverless compute is a compile error.
			 */
			maxConcurrencyPerCPU?: number;
		}
	: Record<never, never>;

/**
 * Lifecycle state of a single job.
 *
 * `queued` is recorded on submit, `processing` at the start of every delivery
 * to the handler, and `complete` or `failed` once the job settles. A retry adds
 * another `processing` entry rather than a new terminal state.
 */
export type AsyncJobState = 'queued' | 'processing' | 'complete' | 'failed';

/** A single entry in a job's transition history. */
export interface AsyncJobTransition {
	/** State the job moved into. */
	state: AsyncJobState;
	/** ISO 8601 timestamp of the transition. */
	at: string;
	/** Delivery attempt that produced this transition. `0` for `queued`, `1` on first delivery. */
	attempt: number;
}

/**
 * Recorded status of a job, returned by `getStatus()` and `waitUntilComplete()`.
 *
 * `transitions` is append-only, so intermediate states stay observable no matter
 * when the record is read — a caller that polls once after the job finished
 * still sees that it passed through `processing`.
 */
export interface AsyncJobStatus {
	/** Job identifier returned by `submit()`. */
	jobId: string;
	/** Most recent state. */
	state: AsyncJobState;
	/** Every state the job has entered, in order. */
	transitions: AsyncJobTransition[];
	/** Number of times the job has been delivered to the handler. */
	attempts: number;
	/** ISO 8601 timestamp of when the job was submitted. */
	submittedAt: string;
	/** ISO 8601 timestamp of the most recent transition. */
	updatedAt: string;
	/** Message from the last handler error. Set when `state` is `failed`. */
	error?: string;
}

/** Options for `waitUntilComplete()`. */
export interface WaitUntilCompleteOptions {
	/** Total time to wait before throwing `AsyncJobErrors.Timeout`. Default: 30000. */
	timeoutMs?: number;
	/** Delay between status reads, carrying ±20% jitter. Clamped to a 1ms minimum. Default: 250. */
	pollIntervalMs?: number;
	/** Cancels the wait, rejecting with the signal's abort reason. */
	signal?: AbortSignal;
}

/**
 * Options for submit() and submitBatch() calls.
 */
export interface SubmitOptions {
	/** Delay before the job becomes visible for processing. 0–900 seconds. Default: 0. */
	delaySeconds?: number;
}

/**
 * Result from submitBatch() including successful job IDs and any failures.
 */
export interface BatchSubmitResult {
	/** Job IDs in the same order as input payloads. `null` for entries that failed. */
	jobIds: Array<string | null>;
	/** Details of any entries that failed to enqueue. */
	failed: Array<{ index: number; code: string; message: string }>;
}

