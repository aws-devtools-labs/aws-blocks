// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { SQSClient, SendMessageCommand, SendMessageBatchCommand } from '@aws-sdk/client-sqs';
import { ReceiveMessageCommand, DeleteMessageCommand, ChangeMessageVisibilityCommand } from '@aws-sdk/client-sqs';
import type { SendMessageBatchCommandOutput } from '@aws-sdk/client-sqs';
import { Scope, registerSdkIdentifiers, getSdkIdentifiers } from '@aws-blocks/core';
import { getConfigSync, getContainerComputeId, isContainerRuntime, registerContainerPoller } from '@aws-blocks/core';
import { dispatchJobToWorker, isJobWorker } from '@aws-blocks/core';
import { EventSourceMapping, sanitizeConfigKey } from '@aws-blocks/core/bb-utils';
import { registerAsyncJob } from './job-registry.js';
import type { ScopeParent } from '@aws-blocks/core';
import type { StandardSchemaV1 } from '@standard-schema/spec';
import type {
	AsyncJobContext,
	AsyncJobOptions,
	SubmitOptions,
	BatchSubmitResult,
	AsyncJobState,
	AsyncJobStatus,
	WaitUntilCompleteOptions,
} from './types.js';
import { AsyncJobErrors, BatchSubmitFailedError } from './errors.js';
import { JobStatusTracker, statusNotTrackedError } from './status.js';
import { BB_NAME, BB_VERSION } from './version.js';
import { Logger } from '@aws-blocks/bb-logger';
import type { ChildLogger } from '@aws-blocks/bb-logger';

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

const MAX_PAYLOAD_BYTES = 256 * 1024;
const MAX_BATCH_SIZE = 10;
/**
 * Upper bound on payloads per `submitBatch` call. Not an SQS limit — a guardrail
 * so a single call cannot fan out to an unbounded number of SQS requests.
 */
const MAX_BATCH_PAYLOADS = 10_000;
/** Maximum number of `SendMessageBatch` requests in flight at once. */
const MAX_BATCH_CONCURRENCY = 5;

/**
 * How long, in seconds, the container poller keeps an in-flight message hidden
 * on each heartbeat. Re-applied on an interval while the handler runs so a
 * long-running job (the reason a container is used) is never redelivered
 * mid-flight — the container equivalent of Lambda's event-source mapping
 * auto-extending visibility up to the function timeout.
 */
const VISIBILITY_HEARTBEAT_SECONDS = 60;
/**
 * Interval between heartbeats. Comfortably shorter than
 * {@link VISIBILITY_HEARTBEAT_SECONDS} so the next extension always lands before
 * the current visibility window lapses, even under some scheduling delay.
 */
const VISIBILITY_HEARTBEAT_INTERVAL_MS = 30_000;

/**
 * Default number of jobs a container processes at once when the compute doesn't
 * set `maxConcurrency`. Conservative because a container job can be heavy (it's
 * on a container precisely because it's long-running or memory-hungry); the
 * customer raises it — and sizes the task's cpu/memory to match — as the primary
 * per-task cost lever.
 */
const DEFAULT_CONTAINER_CONCURRENCY = 5;

export class AsyncJob<T = unknown> extends Scope {
	private _handler: (payload: T, context: AsyncJobContext) => Promise<void>;
	private _schema?: StandardSchemaV1<T>;
	private _envKey: string;
	private _id: string;
	private _sqsClient: SQSClient;
	private _maxRetries: number;
	private _status?: JobStatusTracker;

	/** @internal Logger for internal operations. Defaults to error-level when not provided. */
	protected log: ChildLogger;

	constructor(scope: ScopeParent, id: string, options: AsyncJobOptions<T>) {
		super(id, { parent: scope, bbName: BB_NAME, bbVersion: BB_VERSION });
		this.log = options?.logger ?? new Logger(this, 'logger', { level: 'error' });
		this._handler = options.handler;
		this._schema = options.schema;
		this._id = id;
		this._maxRetries = options.maxRetries ?? 3;
		this._sqsClient = new SQSClient({
			customUserAgent: this.buildUserAgentChain(),
		});

		const envKey = `BLOCKS_QUEUE_URL_${sanitizeConfigKey(this.fullId)}`;
		const queueUrl = process.env[envKey] ?? '';
		this._envKey = envKey;

		registerSdkIdentifiers(this.fullId, { queueUrl });

		if (options.trackStatus) {
			this._status = new JobStatusTracker(this, this.log);
		}

		// Only register handler if queue URL is available (i.e., running in Lambda, not codegen)
		if (queueUrl) {
			// Always register this job for lookup-by-fullId. A container job worker
			// re-imports the backend and resolves the handler here to run one job.
			// Registered via a thin adapter so `_processRecord` stays private.
			registerAsyncJob(this.fullId, { _processRecord: (record) => this._processRecord(record) });

			if (isJobWorker()) {
				// Inside a spawned worker thread: the parent handed us one job and
				// resolves it via the registry above. Do NOT start a poller — the
				// parent owns pulling; a worker that polled would double-consume.
			} else if (isContainerRuntime()) {
				// Container PARENT process: self-start a poller for the queues THIS
				// compute owns (owner-match). The poller dispatches each message to a
				// fresh worker thread (enforced timeout + isolation). The owner id was
				// stamped at synth as BLOCKS_HANDLER_OWNER_<id>; run only if it matches
				// this process's BLOCKS_COMPUTE_ID, so exactly one compute drains each
				// queue even when several containers run the same image.
				const owner = getConfigSync(`BLOCKS_HANDLER_OWNER_${sanitizeConfigKey(this.fullId)}`);
				const self = getContainerComputeId();
				if (owner && self && owner === self) {
					this.registerContainerPoller(queueUrl);
				}
			} else {
				const queueName = queueUrl.split('/').pop()!;
				this.registerLambdaEventHandler(EventSourceMapping.SQS, queueName, (record) => this._processRecord(record));
			}
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

	/** Ensures queue URL is available, throws descriptive error if not */
	private ensureQueueUrl(): void {
		if (!getSdkIdentifiers(this).queueUrl) {
			throw new Error(
				`AsyncJob "${this._id}": missing required environment variable "${this._envKey}". ` +
				`Ensure the CDK stack has been deployed and the Lambda environment is configured correctly.`
			);
		}
	}

	/** Process an SQS record — called by the Lambda handler */
	private async _processRecord(record: {
		messageId: string;
		body: string;
		attributes: { ApproximateReceiveCount: string; SentTimestamp: string };
	}, signal?: AbortSignal): Promise<void> {
		const payload = JSON.parse(record.body) as T;
		const ctx: AsyncJobContext = {
			jobId: record.messageId,
			receiveCount: parseInt(record.attributes.ApproximateReceiveCount, 10),
			sentAt: new Date(parseInt(record.attributes.SentTimestamp, 10)).toISOString(),
			signal,
		};

		await this._status?.tryRecordTransition(ctx.jobId, 'processing', ctx.receiveCount);

		try {
			await this._handler(payload, ctx);
		} catch (error: unknown) {
			// SQS redrive owns the retry decision: this delivery is only terminal once
			// the receive count has reached maxReceiveCount. Earlier failures record
			// nothing, so the next attempt simply appends another `processing` entry.
			if (ctx.receiveCount >= this._maxRetries) {
				const message = error instanceof Error ? error.message : String(error);
				await this._status?.tryRecordTransition(ctx.jobId, 'failed', ctx.receiveCount, message);
			}
			throw error;
		}

		await this._status?.tryRecordTransition(ctx.jobId, 'complete', ctx.receiveCount);
	}

	/**
	 * Start a long-poll loop that drains this job's queue on the container **parent**
	 * process, dispatching each message to a **fresh worker thread** (see core's
	 * `dispatchJobToWorker`). Running each job in its own worker is what makes the
	 * per-handler wall-clock limit *enforced* rather than cooperative: on timeout
	 * the parent hard-terminates the worker, so even a pure CPU busy-loop is
	 * stopped. The limit is the compute's `timeoutSeconds`, stamped as
	 * `BLOCKS_HANDLER_TIMEOUT_<id>` at synth.
	 *
	 * Concurrency is bounded by `BLOCKS_HANDLER_CONCURRENCY_<id>` (the poller's
	 * per-task cost lever): at most that many workers run at once. Delete-on-success
	 * only — a message is deleted after its worker reports success; a timeout,
	 * crash, or handler error leaves it for SQS redrive → DLQ after `maxRetries`
	 * (at-least-once, matching the Lambda path). Visibility is extended on a
	 * heartbeat so a long job isn't redelivered mid-flight.
	 *
	 * Registered with core's container runtime, which starts it after the backend
	 * import and drains it on SIGTERM (stop receiving, let in-flight workers finish
	 * within the grace window).
	 */
	private registerContainerPoller(queueUrl: string): void {
		const timeoutRaw = getConfigSync(`BLOCKS_HANDLER_TIMEOUT_${sanitizeConfigKey(this.fullId)}`);
		const timeoutMs = timeoutRaw ? Number(timeoutRaw) * 1000 : undefined;
		const concurrencyRaw = getConfigSync(`BLOCKS_HANDLER_CONCURRENCY_${sanitizeConfigKey(this.fullId)}`);
		const maxConcurrency = concurrencyRaw ? Math.max(1, Number(concurrencyRaw)) : DEFAULT_CONTAINER_CONCURRENCY;

		registerContainerPoller(() => {
			let running = true;
			let inFlight = 0;
			const idle: Array<() => void> = [];

			// Resolve when all in-flight workers have finished (for graceful drain).
			const whenDrained = (): Promise<void> =>
				inFlight === 0 ? Promise.resolve() : new Promise<void>((r) => idle.push(r));

			const releaseSlot = () => {
				inFlight--;
				if (inFlight === 0) {
					while (idle.length) idle.shift()!();
				}
			};

			// Handle one message end to end: dispatch to a worker (enforced timeout),
			// heartbeat visibility while it runs, delete on success, leave for redrive
			// otherwise. Never throws — a failure just means "don't delete".
			const handleMessage = async (m: {
				MessageId?: string;
				Body?: string;
				ReceiptHandle?: string;
				Attributes?: Record<string, string>;
			}): Promise<void> => {
				const record = {
					messageId: m.MessageId ?? '',
					body: m.Body ?? '',
					attributes: {
						ApproximateReceiveCount: m.Attributes?.ApproximateReceiveCount ?? '1',
						SentTimestamp: m.Attributes?.SentTimestamp ?? String(Date.now()),
					},
				};
				try {
					const result = await this.withVisibilityHeartbeat(queueUrl, m.ReceiptHandle, () =>
						dispatchJobToWorker({ jobFullId: this.fullId, record }, timeoutMs),
					);
					if (result.ok) {
						await this._sqsClient.send(
							new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: m.ReceiptHandle! }),
						);
					} else {
						// Timeout / crash / handler error: do NOT delete. SQS re-shows the
						// message after its visibility timeout and redrives it, moving it to
						// the DLQ once ApproximateReceiveCount exceeds maxReceiveCount.
						this.log.error?.(
							`AsyncJob "${this._id}" delivery failed for ${record.messageId}` +
								`${result.timedOut ? ' (wall-clock timeout — worker terminated)' : ''}: ${result.error}`,
						);
					}
				} finally {
					releaseSlot();
				}
			};

			const loop = async (): Promise<void> => {
				while (running) {
					// Only pull as many as we have free worker slots for, so a burst can't
					// spawn unbounded workers (the cost cap).
					const free = maxConcurrency - inFlight;
					if (free <= 0) {
						await new Promise((r) => setTimeout(r, 50));
						continue;
					}
					let messages: Array<{
						MessageId?: string;
						Body?: string;
						ReceiptHandle?: string;
						Attributes?: Record<string, string>;
					}>;
					try {
						const res = await this._sqsClient.send(
							new ReceiveMessageCommand({
								QueueUrl: queueUrl,
								MaxNumberOfMessages: Math.min(10, free),
								WaitTimeSeconds: 20,
								MessageSystemAttributeNames: ['ApproximateReceiveCount', 'SentTimestamp'],
							}),
						);
						messages = res.Messages ?? [];
					} catch (err) {
						this.log.error?.(
							`AsyncJob container poller receive failed: ${err instanceof Error ? err.message : String(err)}`,
						);
						await new Promise((r) => setTimeout(r, 1000));
						continue;
					}

					// Dispatch each message to its own worker without awaiting here, so up
					// to maxConcurrency run in parallel; the slot count gates the next pull.
					for (const m of messages) {
						inFlight++;
						void handleMessage(m);
					}
				}
			};
			void loop();

			return {
				stop() {
					running = false;
				},
				drain: whenDrained,
			};
		});
	}

	/**
	 * Run `work` while keeping the in-flight message hidden from other receives.
	 *
	 * SQS hides a received message only for the queue's visibility timeout; a job
	 * that runs longer would otherwise reappear and be processed a second time
	 * (a duplicate run, and a wasted retry). This periodically re-applies a
	 * visibility extension on the message's receipt handle until `work` settles —
	 * the container equivalent of what Lambda's event-source mapping does
	 * automatically. Best-effort: a failed extension is logged, not fatal (SQS's
	 * at-least-once contract still holds), and the interval is always cleared in
	 * `finally` so it can't outlive the job.
	 */
	private async withVisibilityHeartbeat<R>(
		queueUrl: string,
		receiptHandle: string | undefined,
		work: () => Promise<R>,
	): Promise<R> {
		if (!receiptHandle) return work();
		const heartbeat = setInterval(() => {
			this._sqsClient
				.send(
					new ChangeMessageVisibilityCommand({
						QueueUrl: queueUrl,
						ReceiptHandle: receiptHandle,
						VisibilityTimeout: VISIBILITY_HEARTBEAT_SECONDS,
					}),
				)
				.catch((err: unknown) => {
					this.log.error?.(
						`AsyncJob "${this._id}" failed to extend visibility: ${err instanceof Error ? err.message : String(err)}`,
					);
				});
		}, VISIBILITY_HEARTBEAT_INTERVAL_MS);
		// Don't let the heartbeat timer keep the process alive on its own.
		if (typeof heartbeat === 'object' && 'unref' in heartbeat) heartbeat.unref();
		try {
			return await work();
		} finally {
			clearInterval(heartbeat);
		}
	}

	/** Validates payload and returns the serialized JSON string for reuse */
	private async validatePayload(payload: T): Promise<string> {
		if (this._schema) {
			const rawResult = this._schema['~standard'].validate(payload);
			const result = rawResult instanceof Promise ? await rawResult : rawResult;
			if (result && typeof result === 'object' && 'issues' in result && result.issues) {
				const msg = result.issues[0]?.message ?? 'Validation failed';
				const err = new Error(`${AsyncJobErrors.ValidationFailed}: ${msg}`);
				err.name = AsyncJobErrors.ValidationFailed;
				throw err;
			}
		}

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

		return serialized;
	}

	async submit(payload: T, options?: SubmitOptions): Promise<{ jobId: string }> {
		this.ensureQueueUrl();
		const messageBody = await this.validatePayload(payload);

		const result = await this._sqsClient.send(new SendMessageCommand({
			QueueUrl: getSdkIdentifiers(this).queueUrl,
			MessageBody: messageBody,
			DelaySeconds: options?.delaySeconds ?? 0,
		}));

		const jobId = result.MessageId;
		if (!jobId) {
			throw new Error('SQS SendMessage succeeded but returned no MessageId');
		}

		// The job id is the SQS message id, so `queued` can only be recorded after the
		// send. SQS may already have delivered the message by now, so the write is
		// conditional on the record not existing: if the handler got there first its
		// backfill already carries the `queued` transition.
		await this._status?.recordQueued(jobId, new Date().toISOString());

		return { jobId };
	}

	/**
	 * Group message indices into `SendMessageBatch` requests bounded by both limits
	 * SQS enforces per request: at most {@link MAX_BATCH_SIZE} entries, and at most
	 * {@link MAX_PAYLOAD_BYTES} of aggregate message body. `validatePayload` has
	 * already rejected any single body over that byte limit, so a message that
	 * would overflow the running chunk simply starts the next one — it can always
	 * fit in a chunk of its own.
	 */
	private chunkBatch(bodies: string[]): number[][] {
		const chunks: number[][] = [];
		let current: number[] = [];
		let currentBytes = 0;

		for (let i = 0; i < bodies.length; i++) {
			const bytes = Buffer.byteLength(bodies[i], 'utf8');
			const wouldOverflow = current.length >= MAX_BATCH_SIZE || currentBytes + bytes > MAX_PAYLOAD_BYTES;
			if (current.length > 0 && wouldOverflow) {
				chunks.push(current);
				current = [];
				currentBytes = 0;
			}
			current.push(i);
			currentBytes += bytes;
		}
		if (current.length > 0) chunks.push(current);

		return chunks;
	}

	/**
	 * Send `chunks` through SQS with at most {@link MAX_BATCH_CONCURRENCY} requests
	 * in flight, writing results into `jobIds` / `failed` (both indexed by the
	 * payload's original position).
	 *
	 * Two failure kinds are handled differently. An *entry-level* failure — SQS
	 * accepts the request but rejects individual messages — is per-index and does
	 * not implicate the rest of the batch. A *transport-level* failure — the
	 * `send()` promise itself rejects (throttling, connection, auth) — cannot be
	 * mapped to individual entries and signals an unhealthy endpoint, so it fails
	 * every index in that chunk and short-circuits the chunks not yet started
	 * rather than hammering a broken endpoint. Chunks already in flight still
	 * settle normally. Either way the caller ends up with a complete `jobIds` /
	 * `failed` picture instead of a raw SDK error with no partial context.
	 */
	private async sendChunksBounded(
		chunks: number[][],
		messageBodies: string[],
		jobIds: Array<string | null>,
		failed: BatchSubmitResult['failed'],
		delaySeconds: number,
	): Promise<void> {
		const queueUrl = getSdkIdentifiers(this).queueUrl;
		let next = 0;
		let aborted = false;

		const worker = async (): Promise<void> => {
			for (;;) {
				const idx = next++;
				if (idx >= chunks.length) return;
				const indices = chunks[idx];

				if (aborted) {
					for (const i of indices) {
						failed.push({ index: i, code: 'BatchSubmitAborted', message: 'Skipped after an earlier chunk failed at the transport level' });
					}
					continue;
				}

				let result: SendMessageBatchCommandOutput;
				try {
					result = await this._sqsClient.send(new SendMessageBatchCommand({
						QueueUrl: queueUrl,
						Entries: indices.map(i => ({ Id: String(i), MessageBody: messageBodies[i], DelaySeconds: delaySeconds })),
					}));
				} catch (err: unknown) {
					aborted = true;
					const code = err instanceof Error ? err.name : 'TransportError';
					const message = err instanceof Error ? err.message : String(err);
					for (const i of indices) failed.push({ index: i, code, message });
					continue;
				}

				for (const s of result.Successful ?? []) {
					jobIds[parseInt(s.Id!, 10)] = s.MessageId!;
				}
				for (const f of result.Failed ?? []) {
					failed.push({ index: parseInt(f.Id!, 10), code: f.Code ?? 'UnknownError', message: f.Message ?? 'Unknown error' });
				}
			}
		};

		const workers = Array.from({ length: Math.min(MAX_BATCH_CONCURRENCY, chunks.length) }, () => worker());
		await Promise.all(workers);
	}

	async submitBatch(payloads: T[], options?: SubmitOptions): Promise<BatchSubmitResult> {
		this.ensureQueueUrl();

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

		// Validate and serialize every payload before enqueuing anything, so one bad
		// payload fails the whole call rather than half-submitting the batch.
		const messageBodies: string[] = [];
		for (const payload of payloads) {
			messageBodies.push(await this.validatePayload(payload));
		}

		// SQS caps a SendMessageBatch at 10 entries and 256 KB, so the batch is split
		// across as many requests as those limits require and sent with bounded
		// concurrency. Each entry's `Id` is the payload's original index, so results
		// map straight back into input order.
		const chunks = this.chunkBatch(messageBodies);
		const jobIds: Array<string | null> = new Array(payloads.length).fill(null);
		const failed: BatchSubmitResult['failed'] = [];

		await this.sendChunksBounded(chunks, messageBodies, jobIds, failed, options?.delaySeconds ?? 0);

		// Defense: SQS should return every entry in Successful or Failed. If one comes
		// back in neither (or with an unparseable Id) its slot stays null; surface that
		// as a failure rather than returning a "success" that contains a null id.
		const failedIndexes = new Set(failed.map(f => f.index));
		for (let i = 0; i < payloads.length; i++) {
			if (jobIds[i] === null && !failedIndexes.has(i)) {
				failed.push({ index: i, code: 'MissingResult', message: 'SQS returned no result for this entry' });
			}
		}

		if (failed.length > 0) {
			// A multi-chunk submit is not atomic: earlier chunks may already be on the
			// queue. `jobIds` still carries their real MessageIds so the caller can
			// look them up, with `null` at each failed index.
			failed.sort((a, b) => a.index - b.index);
			throw new BatchSubmitFailedError(
				`${failed.length} of ${payloads.length} messages failed to send`,
				jobIds,
				failed,
			);
		}

		if (this._status) {
			// Best-effort: every message is already enqueued, and the handler backfills
			// a `queued` record when it first sees a job, so a status-write failure here
			// (e.g. DynamoDB throttling on a large fan-out) must not turn a successful
			// enqueue into a throw that would make the caller re-submit and double-enqueue.
			const submittedAt = new Date().toISOString();
			try {
				await this._status.recordQueuedBatch(
					jobIds.filter((id): id is string => id !== null).map(jobId => ({ jobId, submittedAt })),
				);
			} catch (err: unknown) {
				this.log.error?.(
					`AsyncJob: failed to record queued status for a submitted batch: ${
						err instanceof Error ? err.message : String(err)
					}`,
				);
			}
		}

		return { jobIds, failed: [] };
	}
}
