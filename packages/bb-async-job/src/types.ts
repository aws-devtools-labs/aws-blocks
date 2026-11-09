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
 * Configuration options for creating an AsyncJob — see {@link AsyncJobOptions}.
 *
 * This base carries every option that does not depend on the compute kind. The
 * `compute` option and the container-only `maxConcurrencyPerCPU` knob live on
 * {@link AsyncJobOptions}, which intersects this with a discriminated union on
 * `compute` so the knob is a compile error unless `compute` is a container.
 */
export interface AsyncJobBaseOptions<T> {
	/** Async function that processes each job payload. */
	handler: (payload: T, context: AsyncJobContext) => Promise<void>;
	/** Optional schema for runtime payload validation on submit. Accepts any StandardSchemaV1 implementation (Zod, Valibot, ArkType, etc.). */
	schema?: StandardSchemaV1<T>;
	/**
	 * Maximum delivery attempts, including the first, before the job is sent to
	 * the DLQ (the queue's `maxReceiveCount`). `3` means one attempt plus two
	 * retries. Default: 3.
	 */
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
	 * Wall-clock limit for one delivery, in seconds. A property of the work, not
	 * the compute. On a container it is enforced by the runtime (the job's worker
	 * is terminated at the deadline); on a serverless compute it is bounded by the
	 * function timeout. Must fit under the compute's ceiling where one exists.
	 */
	timeoutSeconds?: number;
}

/**
 * Options for creating an AsyncJob.
 *
 * This is {@link AsyncJobBaseOptions} intersected with a discriminated union on
 * `compute`: a **container** compute carries the container-only
 * `maxConcurrencyPerCPU` knob, while an explicit serverless compute or omitting
 * `compute` forbids it (`maxConcurrencyPerCPU?: never`). Omitting `compute`
 * still inherits the scope's compute at synth time; configuring the knob requires
 * an explicit container compute even when the scope already uses one. Setting
 * the knob without an explicit container compute is a **compile error**; synth
 * also rejects it if the resolved compute is not a container, as a defense for
 * callers who bypass the types.
 *
 * There is intentionally no `C` type parameter: the compute's kind is inferred
 * from the `compute` argument itself, never spelled by hand (its type is
 * meaningless without the object). This keeps `T` the single, first-class
 * generic, so `new AsyncJob<Payload>(…)` with a container compute still compiles
 * — supplying `T` no longer forces a `ComputeProvider<'serverless'>` default.
 */
export type AsyncJobOptions<T> = AsyncJobBaseOptions<T> &
	(
		| {
				/**
				 * The compute this job's handler runs on. Pass a `Compute` block (or any
				 * {@link ComputeProvider}) to place the handler on a different runtime than
				 * the app default — e.g. a long-running or high-memory job that a container
				 * (Fargate) can serve but a serverless compute cannot.
				 *
				 * Assigning a container-backed compute moves delivery from a native SQS
				 * event source to an owner-matched poller the container self-starts; the
				 * per-handler wall-clock limit comes from this job's `timeoutSeconds`. In
				 * local dev, compute assignment is transparent — the handler runs in-process.
				 */
				compute: ComputeProvider<'container'>;
				/**
				 * How many deliveries of this job run at once per instance, expressed
				 * **per vCPU**. Blocks multiplies by the compute's vCPU count for the
				 * per-instance concurrency: `max(1, ceil(maxConcurrencyPerCPU × vcpu))`.
				 * Higher for IO-bound work that mostly awaits; explicitly set 1 for
				 * CPU-bound work. When omitted, the poller allows five in-flight deliveries
				 * per job per instance, regardless of the compute's vCPU count.
				 * Container-only: exposed only with an explicit container `compute`;
				 * setting it with a serverless compute (or omitting `compute`) is a compile
				 * error. Synth also rejects it when the resolved compute is not a container.
				 */
				maxConcurrencyPerCPU?: number;
		  }
		| {
				/**
				 * The compute this job's handler runs on. When omitted, inherits the nearest
				 * parent scope's compute, falling back to the backend's default compute
				 * when none is assigned (normally serverless). Pass a serverless `Compute`
				 * block (or any {@link ComputeProvider}) to assign one explicitly.
				 */
				compute?: ComputeProvider<'serverless'>;
				/**
				 * Container-only — not available on a serverless compute. See the container
				 * arm of {@link AsyncJobOptions}. Typed `never` so setting it here is a
				 * compile error.
				 */
				maxConcurrencyPerCPU?: never;
		  }
	);

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

