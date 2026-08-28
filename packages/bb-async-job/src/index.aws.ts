// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { SQSClient, SendMessageCommand, SendMessageBatchCommand } from '@aws-sdk/client-sqs';
import type { SendMessageBatchCommandOutput } from '@aws-sdk/client-sqs';
import { Scope, registerSdkIdentifiers, getSdkIdentifiers } from '@aws-blocks/core';
import { EventSourceMapping } from '@aws-blocks/core/bb-utils';
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

		const envKey = `BLOCKS_QUEUE_URL_${this.fullId.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
		const queueUrl = process.env[envKey] ?? '';
		this._envKey = envKey;

		registerSdkIdentifiers(this.fullId, { queueUrl });

		if (options.trackStatus) {
			this._status = new JobStatusTracker(this, this.log);
		}

		// Only register handler if queue URL is available (i.e., running in Lambda, not codegen)
		if (queueUrl) {
			const queueName = queueUrl.split('/').pop()!;
			this.registerLambdaEventHandler(EventSourceMapping.SQS, queueName, (record) => this._processRecord(record));
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
	}): Promise<void> {
		const payload = JSON.parse(record.body) as T;
		const ctx: AsyncJobContext = {
			jobId: record.messageId,
			receiveCount: parseInt(record.attributes.ApproximateReceiveCount, 10),
			sentAt: new Date(parseInt(record.attributes.SentTimestamp, 10)).toISOString(),
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
