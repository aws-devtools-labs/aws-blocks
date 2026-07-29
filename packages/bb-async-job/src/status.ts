// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { DistributedTable, DistributedTableErrors } from '@aws-blocks/bb-distributed-table';
import { isBlocksError } from '@aws-blocks/core';
import type { ScopeParent } from '@aws-blocks/core';
import type { ChildLogger } from '@aws-blocks/bb-logger';
import type { StandardSchemaV1 } from '@standard-schema/spec';
import type {
	AsyncJobState,
	AsyncJobStatus,
	AsyncJobTransition,
	WaitUntilCompleteOptions,
} from './types.js';
import { AsyncJobErrors } from './errors.js';

/** Child scope id of the status table. Must match between the runtime and CDK entry points. */
export const STATUS_TABLE_ID = 'status';

/** How long a status record survives after its last transition. */
export const STATUS_RETENTION_SECONDS = 86_400;

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_POLL_INTERVAL_MS = 250;

/** Attempts allowed for the compare-and-swap in {@link JobStatusTracker.recordTransition}. */
const MAX_CAS_ATTEMPTS = 5;
const CAS_BACKOFF_MS = 20;

/** Stored shape: the public record plus bookkeeping the caller never sees. */
interface StatusRecord extends AsyncJobStatus {
	/** Epoch seconds at which DynamoDB may delete this record. */
	expiresAt: number;
	/** Incremented on every write; the compare value for optimistic concurrency. */
	version: number;
}

const STRING_FIELDS = ['jobId', 'state', 'submittedAt', 'updatedAt', 'error'] as const;

/**
 * Runtime validation for status records.
 *
 * This schema is deliberately explicit about field types rather than passing
 * values through: the CDK layer infers a key's DynamoDB attribute type by
 * probing `validate({ jobId: 0 })` and treats "no issue for that field" as
 * numeric. A pass-through schema would therefore provision `jobId` as `N`.
 */
export const statusSchema: StandardSchemaV1<StatusRecord> = {
	'~standard': {
		version: 1,
		vendor: 'blocks',
		validate: (value: unknown) => {
			if (typeof value !== 'object' || value === null || Array.isArray(value)) {
				return { issues: [{ message: 'status record must be an object' }] };
			}
			const record = value as Record<string, unknown>;
			const issues: Array<{ message: string; path: [string] }> = [];

			for (const field of STRING_FIELDS) {
				if (field in record && typeof record[field] !== 'string') {
					issues.push({ message: `${field} must be a string`, path: [field] });
				}
			}
			for (const field of ['attempts', 'expiresAt', 'version'] as const) {
				if (field in record && typeof record[field] !== 'number') {
					issues.push({ message: `${field} must be a number`, path: [field] });
				}
			}
			if ('transitions' in record && !Array.isArray(record.transitions)) {
				issues.push({ message: 'transitions must be an array', path: ['transitions'] });
			}

			return issues.length > 0 ? { issues } : { value: record as unknown as StatusRecord };
		},
	},
};

/** Options for the status table, shared by the runtime and CDK entry points. */
export const statusTableOptions = {
	schema: statusSchema,
	key: { partitionKey: 'jobId' },
	ttl: 'expiresAt',
} as const;

function blocksError(name: string, message: string): Error {
	const err = new Error(`${name}: ${message}`);
	err.name = name;
	return err;
}

/**
 * Resolve after `ms` milliseconds, rejecting early with the signal's abort
 * reason if `signal` aborts while waiting.
 */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		if (signal?.aborted) {
			reject(signal.reason);
			return;
		}
		let onAbort: (() => void) | undefined;
		const timer = setTimeout(() => {
			if (signal && onAbort) signal.removeEventListener('abort', onAbort);
			resolve();
		}, ms);
		if (signal) {
			onAbort = () => {
				clearTimeout(timer);
				reject(signal.reason);
			};
			signal.addEventListener('abort', onAbort, { once: true });
		}
	});
}

/**
 * Apply ±20% random jitter to a poll interval so that many concurrent waiters
 * do not synchronize into lockstep against the same table.
 */
function jitterInterval(ms: number): number {
	const factor = 1 + (Math.random() * 2 - 1) * 0.2;
	return Math.max(1, Math.round(ms * factor));
}

function isTerminal(state: AsyncJobState): boolean {
	return state === 'complete' || state === 'failed';
}

function expiresAt(): number {
	return Math.floor(Date.now() / 1000) + STATUS_RETENTION_SECONDS;
}

/**
 * Records and reads AsyncJob state transitions.
 *
 * Backed by a nested {@link DistributedTable}, provisioned as a child scope so
 * it becomes its own DynamoDB table in AWS and a JSON file locally. The same
 * code path runs in both runtimes.
 *
 * Transitions are appended rather than overwritten: a reader that polls once,
 * long after the job finished, still observes that the job passed through
 * `processing`. That is what makes intermediate states observable without
 * padding the handler with an artificial delay.
 *
 * @internal
 */
export class JobStatusTracker {
	private table: DistributedTable<StatusRecord, { partitionKey: 'jobId' }>;
	private log?: ChildLogger;

	constructor(scope: ScopeParent, log?: ChildLogger) {
		this.table = new DistributedTable<StatusRecord, { partitionKey: 'jobId' }>(
			scope,
			STATUS_TABLE_ID,
			statusTableOptions as never,
		);
		this.log = log;
	}

	/** Build the initial `queued` record for a freshly submitted job. */
	private queuedRecord(jobId: string, submittedAt: string): StatusRecord {
		return {
			jobId,
			state: 'queued',
			transitions: [{ state: 'queued', at: submittedAt, attempt: 0 }],
			attempts: 0,
			submittedAt,
			updatedAt: submittedAt,
			expiresAt: expiresAt(),
			version: 0,
		};
	}

	/**
	 * Record a job as `queued`.
	 *
	 * Conditional on the record not existing yet. In AWS the job id *is* the SQS
	 * message id, so this write can only happen after `SendMessage` returns — by
	 * which point SQS may already have delivered the message and the handler may
	 * already have created the record via {@link recordTransition}. An
	 * unconditional write would clobber that `processing` entry and strand the job
	 * at `queued` forever. Losing the race is therefore success, not failure: the
	 * handler's backfill already contains the `queued` transition.
	 */
	async recordQueued(jobId: string, submittedAt: string): Promise<void> {
		try {
			await this.table.put(this.queuedRecord(jobId, submittedAt), { ifNotExists: true });
		} catch (err: unknown) {
			if (!isBlocksError(err, DistributedTableErrors.ConditionalCheckFailed)) throw err;
		}
	}

	/**
	 * Record several jobs as `queued`.
	 *
	 * Deliberately individual conditional writes rather than one `putBatch`:
	 * DynamoDB's `BatchWriteItem` cannot carry a condition expression, so a batch
	 * write would reintroduce the clobber described on {@link recordQueued}. A
	 * batch is at most 10 items, so the puts are issued in parallel.
	 */
	async recordQueuedBatch(jobs: Array<{ jobId: string; submittedAt: string }>): Promise<void> {
		if (jobs.length === 0) return;
		await Promise.all(jobs.map(j => this.recordQueued(j.jobId, j.submittedAt)));
	}

	/**
	 * Append a transition to a job's history.
	 *
	 * Appending is a read-modify-write, so it is guarded by a compare-and-swap on
	 * `version`. SQS standard queues are at-least-once, and the block's own
	 * contract tells handlers to expect more than one delivery, so two invocations
	 * can hold the same record concurrently. Without the guard the later
	 * full-item `put` would silently drop the other's transition — and if the
	 * dropped entry were the terminal one, `waitUntilComplete()` would time out on
	 * a job that had actually finished. On a lost swap the record is re-read and
	 * the transition re-applied, so no entry is lost.
	 */
	async recordTransition(
		jobId: string,
		state: AsyncJobState,
		attempt: number,
		error?: string,
	): Promise<void> {
		for (let cas = 1; ; cas++) {
			const existing = await this.table.get({ jobId });
			const now = new Date().toISOString();
			const base = existing ?? this.queuedRecord(jobId, now);
			const transition: AsyncJobTransition = { state, at: now, attempt };

			const next: StatusRecord = {
				...base,
				state,
				transitions: [...base.transitions, transition],
				attempts: Math.max(base.attempts, attempt),
				updatedAt: now,
				expiresAt: expiresAt(),
				version: base.version + 1,
			};
			if (error !== undefined) next.error = error;

			try {
				await this.table.put(
					next,
					existing ? { ifFieldEquals: { version: existing.version } } : { ifNotExists: true },
				);
				return;
			} catch (err: unknown) {
				const lostRace = isBlocksError(err, DistributedTableErrors.ConditionalCheckFailed);
				if (!lostRace || cas >= MAX_CAS_ATTEMPTS) throw err;
				await sleep(jitterInterval(CAS_BACKOFF_MS));
			}
		}
	}

	/**
	 * Append a transition, swallowing and logging any failure.
	 *
	 * Used on the handler path only. A status write must never decide the fate of
	 * a job: throwing before the handler would retry work that was fine, and
	 * throwing after it succeeded would re-run work that already completed.
	 */
	async tryRecordTransition(
		jobId: string,
		state: AsyncJobState,
		attempt: number,
		error?: string,
	): Promise<void> {
		try {
			await this.recordTransition(jobId, state, attempt, error);
		} catch (err: unknown) {
			this.log?.error?.(
				`AsyncJob: failed to record "${state}" status for job ${jobId}: ${
					err instanceof Error ? err.message : String(err)
				}`,
			);
		}
	}

	/** Read a job's status, or `null` when nothing is recorded for that id. */
	async get(jobId: string): Promise<AsyncJobStatus | null> {
		const record = await this.table.get({ jobId });
		if (!record) return null;
		const { expiresAt: _ttl, version: _version, ...status } = record;
		return status;
	}

	/** Poll until the job reaches `complete` or `failed`, or the budget runs out. */
	async waitUntilComplete(
		jobId: string,
		options?: WaitUntilCompleteOptions,
	): Promise<AsyncJobStatus> {
		const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
		const pollIntervalMs = Math.max(1, options?.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS);
		const signal = options?.signal;
		const deadline = Date.now() + timeoutMs;

		let last: AsyncJobStatus | null = null;
		for (;;) {
			signal?.throwIfAborted();

			last = await this.get(jobId);
			if (last && isTerminal(last.state)) return last;

			if (Date.now() >= deadline) {
				throw blocksError(
					AsyncJobErrors.Timeout,
					`Job ${jobId} did not reach a terminal state within ${timeoutMs}ms ` +
						`(last observed state: ${last?.state ?? 'unknown'})`,
				);
			}

			const remaining = Math.max(deadline - Date.now(), 0);
			await sleep(Math.min(jitterInterval(pollIntervalMs), remaining), signal);
		}
	}
}

/** Error thrown when a status method is called on a job that is not tracking status. */
export function statusNotTrackedError(id: string): Error {
	return blocksError(
		AsyncJobErrors.StatusNotTracked,
		`AsyncJob "${id}" is not tracking job status. ` +
			`Pass { trackStatus: true } to the AsyncJob constructor to record state transitions.`,
	);
}
