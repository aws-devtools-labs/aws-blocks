// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { Scope, registerSdkIdentifiers } from '@aws-blocks/core';
import type { ScopeParent } from '@aws-blocks/core';
import type { StandardSchemaV1 } from '@standard-schema/spec';
import { randomUUID } from 'node:crypto';
import type {
	AsyncJobContext,
	AsyncJobOptions,
	SubmitOptions,
	BatchSubmitResult,
	AsyncJobState,
	AsyncJobStatus,
	WaitUntilCompleteOptions,
} from './types.js';
import { AsyncJobErrors } from './errors.js';
import { validateDelaySeconds } from './validation.js';
import { JobStatusTracker, statusNotTrackedError } from './status.js';
import { Logger } from '@aws-blocks/bb-logger';
import type { ChildLogger } from '@aws-blocks/bb-logger';
import { BB_NAME, BB_VERSION } from './version.js';

export { AsyncJobErrors, BatchSubmitFailedError } from './errors.js';
export type {
	AsyncJobContext,
	AsyncJobOptions,
	SubmitOptions,
	BatchSubmitResult,
	AsyncJobState,
	AsyncJobStatus,
	AsyncJobTransition,
	WaitUntilCompleteOptions,
} from './types.js';

interface QueueEntry<T> {
	jobId: string;
	payload: T;
	receiveCount: number;
	sentAt: string;
	delayedUntil: string | null;
	failedAt: string | null;
	lastError: string | null;
}

const MAX_PAYLOAD_BYTES = 256 * 1024;
/** Upper bound on payloads per `submitBatch` call — parity with the AWS runtime. */
const MAX_BATCH_PAYLOADS = 10_000;

/**
 * Background job processing backed by SQS and Lambda.
 *
 * Submit a payload, get a job ID back, and a handler processes it
 * asynchronously with automatic retries and dead-letter handling.
 *
 * **When to use:** Offload work from the API response path — sending emails,
 * processing uploads, generating reports, or any fire-and-forget task.
 *
 * **When NOT to use:** For scheduled recurring work, use `CronJob`.
 *
 * **Best practices:**
 * - Keep payloads small (< 256 KB) — store large data in FileBucket/KVStore and pass a reference
 * - Design handlers to be idempotent — jobs may be delivered more than once
 * - Set `visibilityTimeout` to at least 2x the expected handler duration
 *
 * **Scaling (AWS):** SQS standard queues support nearly unlimited throughput.
 * A dedicated Lambda function processes jobs with automatic concurrency scaling.
 *
 * @example
 * ```typescript
 * const emailJob = new AsyncJob(scope, 'welcome-email', {
 *   handler: async (payload: { to: string }, ctx) => {
 *     await sendEmail(payload.to);
 *   },
 * });
 *
 * const { jobId } = await emailJob.submit({ to: 'alice@example.com' });
 * ```
 *
 * @example Observing state transitions
 * ```typescript
 * const job = new AsyncJob(scope, 'ingest', { handler, trackStatus: true });
 *
 * const { jobId } = await job.submit({ documentId: 'doc-1' });
 * const status = await job.waitUntilComplete(jobId);
 * status.transitions.map(t => t.state); // ['queued', 'processing', 'complete']
 * ```
 */
export class AsyncJob<T = unknown> extends Scope {
	private handler: (payload: T, context: AsyncJobContext) => Promise<void>;
	private schema?: StandardSchemaV1<T>;
	private maxRetries: number;
	private _id: string;
	private _status?: JobStatusTracker;

	// In-process queue state for dev server inspection
	public readonly _queue: {
		pending: QueueEntry<T>[];
		processing: QueueEntry<T>[];
		delayed: QueueEntry<T>[];
		failed: QueueEntry<T>[];
		totalSubmitted: number;
		totalCompleted: number;
	};

	/** @internal Logger for internal operations. Defaults to error-level when not provided. */
	protected log: ChildLogger;

	constructor(scope: ScopeParent, id: string, options: AsyncJobOptions<T>) {
		super(id, { parent: scope, bbName: BB_NAME, bbVersion: BB_VERSION });
		this.log = options?.logger ?? new Logger(this, 'logger', { level: 'error' });
		this._id = id;
		this.handler = options.handler;
		this.schema = options.schema;
		this.maxRetries = options.maxRetries ?? 3;
		this._queue = {
			pending: [],
			processing: [],
			delayed: [],
			failed: [],
			totalSubmitted: 0,
			totalCompleted: 0,
		};
		registerSdkIdentifiers(this.fullId, { queueUrl: `mock-queue://${this.fullId}` });
		if (options.trackStatus) {
			this._status = new JobStatusTracker(this, this.log);
		}
	}

	/** Throws unless this job was created with `trackStatus: true`. */
	private requireStatus(): JobStatusTracker {
		if (!this._status) throw statusNotTrackedError(this._id);
		return this._status;
	}

	/**
	 * Read a job's recorded status, including every state it has passed through.
	 *
	 * Requires `trackStatus: true`. Because `transitions` is append-only, a single
	 * read after the job settled still shows the intermediate `processing` state,
	 * so there is no need to slow the handler down to make it observable.
	 *
	 * @param jobId - Job identifier returned by `submit()`.
	 * @returns The status record, or `null` if nothing is recorded for that id.
	 * @throws {AsyncJobErrors.StatusNotTracked} If the job was created without `trackStatus: true`.
	 *
	 * @example
	 * ```typescript
	 * const status = await job.getStatus(jobId);
	 * if (status?.state === 'failed') console.error(status.error);
	 * ```
	 */
	async getStatus(jobId: string): Promise<AsyncJobStatus | null> {
		return this.requireStatus().get(jobId);
	}

	/**
	 * Wait until a job reaches `complete` or `failed`.
	 *
	 * Requires `trackStatus: true`. Resolves on either terminal state — inspect
	 * `state` and `error` on the returned record to tell them apart.
	 *
	 * @param jobId - Job identifier returned by `submit()`.
	 * @param options - Optional. `timeoutMs` (default 30000), `pollIntervalMs` (default 250), `signal`.
	 * @returns The final status record.
	 * @throws {AsyncJobErrors.StatusNotTracked} If the job was created without `trackStatus: true`.
	 * @throws {AsyncJobErrors.Timeout} If the job does not settle within `timeoutMs`.
	 *
	 * @example
	 * ```typescript
	 * const status = await job.waitUntilComplete(jobId, { timeoutMs: 60_000 });
	 * ```
	 */
	async waitUntilComplete(jobId: string, options?: WaitUntilCompleteOptions): Promise<AsyncJobStatus> {
		return this.requireStatus().waitUntilComplete(jobId, options);
	}

	/**
	 * Enqueue a single job for background processing.
	 *
	 * The handler runs asynchronously — this method returns immediately with a job ID.
	 * In local dev, the handler executes via `setTimeout`. In AWS, the payload is
	 * sent to SQS and a dedicated Lambda processes it.
	 *
	 * @param payload - The job data passed to the handler.
	 * @param options - Optional. `delaySeconds` defers processing (0–900s).
	 * @returns `{ jobId }` — unique identifier for tracking.
	 * @throws {AsyncJobErrors.PayloadTooLarge} If serialized payload exceeds 256 KB.
	 * @throws {AsyncJobErrors.ValidationFailed} If schema validation fails or delaySeconds is not an integer from 0 to 900.
	 */
	async submit(payload: T, options?: SubmitOptions): Promise<{ jobId: string }> {
		validateDelaySeconds(options?.delaySeconds);
		await this.validatePayload(payload);
		const jobId = randomUUID().slice(0, 13);
		const sentAt = new Date().toISOString();
		const delaySeconds = options?.delaySeconds ?? 0;

		this._queue.totalSubmitted++;

		const entry: QueueEntry<T> = {
			jobId,
			payload,
			receiveCount: 0,
			sentAt,
			delayedUntil: delaySeconds > 0 ? new Date(Date.now() + delaySeconds * 1000).toISOString() : null,
			failedAt: null,
			lastError: null,
		};

		await this._status?.recordQueued(jobId, sentAt);

		if (delaySeconds > 0) {
			console.log(`[AsyncJob:${this._id}] submitted job ${jobId} (delayed ${delaySeconds}s)`);
			this._queue.delayed.push(entry);
			setTimeout(() => {
				this._queue.delayed = this._queue.delayed.filter(e => e.jobId !== jobId);
				this.processEntry(entry);
			}, delaySeconds * 1000);
		} else {
			console.log(`[AsyncJob:${this._id}] submitted job ${jobId}`);
			this.processEntry(entry);
		}

		return { jobId };
	}

	/**
	 * Enqueue multiple jobs in a single call.
	 *
	 * The mock runtime enqueues each payload via `submit()` in turn; the AWS
	 * runtime instead packs them into SQS `SendMessageBatch` requests. Either way a
	 * batch of any size up to {@link MAX_BATCH_PAYLOADS} is accepted — larger
	 * batches are rejected up front.
	 *
	 * @param payloads - Array of job payloads (at most {@link MAX_BATCH_PAYLOADS}).
	 * @param options - Optional. `delaySeconds` applied to all messages.
	 * @returns `{ jobIds, failed }` — `jobIds` in the same order as input payloads (`null` for failed entries); `failed` lists any entries that could not be enqueued.
	 * @throws {AsyncJobErrors.BatchEmpty} If payloads array is empty.
	 * @throws {AsyncJobErrors.BatchTooLarge} If more than {@link MAX_BATCH_PAYLOADS} payloads.
	 * @throws {AsyncJobErrors.PayloadTooLarge} If any payload exceeds 256 KB.
	 * @throws {AsyncJobErrors.ValidationFailed} If any payload fails schema validation or delaySeconds is not an integer from 0 to 900.
	 * @throws {AsyncJobErrors.BatchSubmitFailed} If one or more messages fail to send (AWS only). A multi-chunk submit is not atomic; the error's `failed` and `jobIds` properties carry the partial results across all chunks.
	 */
	async submitBatch(payloads: T[], options?: SubmitOptions): Promise<BatchSubmitResult> {
		if (payloads.length === 0) {
			const err = new Error(
				`${AsyncJobErrors.BatchEmpty}: Batch is empty, must contain at least 1 payload`
			);
			err.name = AsyncJobErrors.BatchEmpty;
			throw err;
		}

		if (payloads.length > MAX_BATCH_PAYLOADS) {
			const err = new Error(
				`${AsyncJobErrors.BatchTooLarge}: Batch contains ${payloads.length} payloads, exceeds the ${MAX_BATCH_PAYLOADS} per-call limit`
			);
			err.name = AsyncJobErrors.BatchTooLarge;
			throw err;
		}

		validateDelaySeconds(options?.delaySeconds);

		// Validate every payload before enqueuing any, so one bad payload fails the
		// whole call rather than half-submitting the batch — matching the AWS runtime.
		for (const payload of payloads) {
			await this.validatePayload(payload);
		}

		const jobIds: Array<string | null> = [];
		for (const payload of payloads) {
			const { jobId } = await this.submit(payload, options);
			jobIds.push(jobId);
		}
		return { jobIds, failed: [] };
	}

	private async validatePayload(payload: T): Promise<void> {
		// StandardSchemaV1 — validate() may return a Promise
		if (this.schema) {
			const rawResult = this.schema['~standard'].validate(payload);
			const result = rawResult instanceof Promise ? await rawResult : rawResult;
			if (result && typeof result === 'object' && 'issues' in result && result.issues) {
				const msg = result.issues[0]?.message ?? 'Validation failed';
				const err = new Error(`${AsyncJobErrors.ValidationFailed}: ${msg}`);
				err.name = AsyncJobErrors.ValidationFailed;
				throw err;
			}
		}

		// Payload size validation
		const serialized = JSON.stringify(payload);
		const bytes = Buffer.byteLength(serialized, 'utf8');
		if (bytes > MAX_PAYLOAD_BYTES) {
			const kb = Math.ceil(bytes / 1024);
			const err = new Error(
				`${AsyncJobErrors.PayloadTooLarge}: Serialized payload is ${kb} KB, exceeds 256 KB limit`
			);
			err.name = AsyncJobErrors.PayloadTooLarge;
			throw err;
		}
	}

	private processEntry(entry: QueueEntry<T>): void {
		setTimeout(async () => {
			entry.receiveCount++;
			this._queue.pending = this._queue.pending.filter(e => e.jobId !== entry.jobId);
			this._queue.processing.push(entry);

			await this._status?.tryRecordTransition(entry.jobId, 'processing', entry.receiveCount);

			const start = Date.now();
			try {
				await this.handler(entry.payload, {
					jobId: entry.jobId,
					receiveCount: entry.receiveCount,
					sentAt: entry.sentAt,
				});
				this._queue.processing = this._queue.processing.filter(e => e.jobId !== entry.jobId);
				this._queue.totalCompleted++;
				await this._status?.tryRecordTransition(entry.jobId, 'complete', entry.receiveCount);
				console.log(`[AsyncJob:${this._id}] completed job ${entry.jobId} (${Date.now() - start}ms)`);
			} catch (error: any) {
				this._queue.processing = this._queue.processing.filter(e => e.jobId !== entry.jobId);
				const errorMsg = error?.message ?? String(error);

				if (entry.receiveCount >= this.maxRetries) {
					entry.failedAt = new Date().toISOString();
					entry.lastError = errorMsg;
					this._queue.failed.push(entry);
					await this._status?.tryRecordTransition(entry.jobId, 'failed', entry.receiveCount, errorMsg);
					console.log(`[AsyncJob:${this._id}] job ${entry.jobId} moved to DLQ after ${this.maxRetries} attempts`);
					console.log(`[AsyncJob:${this._id}] DLQ payload: ${JSON.stringify(entry.payload)}`);
				} else {
					console.log(
						`[AsyncJob:${this._id}] job ${entry.jobId} failed (attempt ${entry.receiveCount}/${this.maxRetries}): ${errorMsg}`
					);
					console.log(`[AsyncJob:${this._id}] retrying job ${entry.jobId} (attempt ${entry.receiveCount + 1}/${this.maxRetries})`);
					this.processEntry(entry);
				}
			}
		}, 0);
	}
}
