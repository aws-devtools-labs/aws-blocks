// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Where a turn records its terminal chunk (`done`, `error` or `interrupt`) just before it
 * publishes it, so `complete()` can still settle when that chunk went out before its Realtime
 * subscription existed. Realtime pub/sub is not durable: a chunk published while nobody is
 * subscribed is dropped. Internal: not in the package's export map.
 *
 * There are two stores, chosen by where the turn runs relative to the caller of `complete()`:
 * - {@link InProcessTurnOutcomes} (local/mock): the turn runs in the caller's process, so a
 *   bounded in-memory map is enough.
 * - {@link BucketTurnOutcomes} (AWS): the turn runs on the AgentCore Runtime and `complete()` in
 *   the Lambda, so the outcome is a small object in the agent's session bucket. S3 reads are
 *   strongly consistent after a write, so a read issued after the write completed sees it.
 */

import type { FileBucket } from '@aws-blocks/bb-file-bucket';
import type { ChildLogger } from '@aws-blocks/bb-logger';
import { agentStreamChunkSchema } from './schemas.js';
import type { AgentStreamChunk } from './types.js';

/** Key prefix of the outcome objects in the session bucket. The CDK layer expires it (index.cdk.ts). */
export const TURN_OUTCOME_PREFIX = 'bb-agent-turn-outcomes/';

/**
 * Days before S3 expires an outcome object. `complete()` reads an outcome when it subscribes,
 * which is moments after the turn ended in the case the record exists for.
 */
export const TURN_OUTCOME_EXPIRATION_DAYS = 1;

/** Outcomes the in-process store keeps for turns whose `complete()` is never called. */
const MAX_IN_PROCESS_OUTCOMES = 1000;

/**
 * How long a turn waits for its outcome write before publishing the terminal chunk anyway.
 * An S3 PutObject takes tens of milliseconds; the bound only keeps a degraded S3 from holding
 * back the chunk every subscriber is waiting for.
 */
const OUTCOME_WRITE_TIMEOUT_MS = 3000;

/** `stream()`/`resume()` mint dispatch ids with `crypto.randomUUID()`; anything else is never used as a key. */
const DISPATCH_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The outcome store a turn writes to and `complete()` reads from. */
export interface TurnOutcomeStore {
	/** Record `chunk` as the outcome of dispatch `dispatchId`. Never rejects: a lost record only loses the fallback. */
	record(dispatchId: string, chunk: AgentStreamChunk): Promise<void>;
	/** The recorded outcome, or null when the turn hasn't ended (or its outcome wasn't recorded). */
	read(dispatchId: string): Promise<AgentStreamChunk | null>;
	/** `complete()` has settled on this dispatch's outcome, so the record is no longer needed. */
	release(dispatchId: string): void;
}

/** Outcomes of turns that run in this process (the local/mock dispatch). */
export class InProcessTurnOutcomes implements TurnOutcomeStore {
	private readonly outcomes = new Map<string, AgentStreamChunk>();

	constructor(private readonly max = MAX_IN_PROCESS_OUTCOMES) {}

	async record(dispatchId: string, chunk: AgentStreamChunk): Promise<void> {
		this.outcomes.set(dispatchId, chunk);
		// Most turns are consumed by a browser and never by complete(), so their records are never
		// released. Drop the oldest beyond the bound; complete() on an evicted turn falls back to the
		// live chunk, as it did before outcomes were recorded.
		if (this.outcomes.size > this.max) {
			const oldest = this.outcomes.keys().next();
			if (!oldest.done) this.outcomes.delete(oldest.value);
		}
	}

	async read(dispatchId: string): Promise<AgentStreamChunk | null> {
		return this.outcomes.get(dispatchId) ?? null;
	}

	release(dispatchId: string): void {
		this.outcomes.delete(dispatchId);
	}
}

/** Outcomes of turns that run on the AgentCore Runtime, kept in the agent's session bucket. */
export class BucketTurnOutcomes implements TurnOutcomeStore {
	constructor(
		private readonly bucket: FileBucket,
		private readonly log: ChildLogger,
		private readonly writeTimeoutMs = OUTCOME_WRITE_TIMEOUT_MS,
	) {}

	async record(dispatchId: string, chunk: AgentStreamChunk): Promise<void> {
		if (!DISPATCH_ID.test(dispatchId)) return;
		const write = this.bucket.put(outcomeKey(dispatchId), JSON.stringify(chunk), {
			contentType: 'application/json',
		});
		let timer: ReturnType<typeof setTimeout> | undefined;
		const timeout = new Promise<never>((_, reject) => {
			timer = setTimeout(
				() => reject(new Error(`timed out after ${this.writeTimeoutMs} ms`)),
				this.writeTimeoutMs,
			);
		});
		try {
			await Promise.race([write, timeout]);
		} catch (err) {
			// A write abandoned at the timeout can still fail later, with nobody left to handle it.
			write.catch(() => {});
			this.log.warn('Failed to record turn outcome', {
				dispatchId,
				error: err instanceof Error ? err.message : String(err),
			});
		} finally {
			clearTimeout(timer);
		}
	}

	async read(dispatchId: string): Promise<AgentStreamChunk | null> {
		if (!DISPATCH_ID.test(dispatchId)) return null;
		const file = await this.bucket.get(outcomeKey(dispatchId));
		if (!file) return null;
		const parsed = agentStreamChunkSchema.safeParse(JSON.parse(file.body.toString()));
		return parsed.success ? parsed.data : null;
	}

	/** No-op: the session bucket's lifecycle rule expires outcome objects (see TURN_OUTCOME_EXPIRATION_DAYS). */
	release(): void {}
}

function outcomeKey(dispatchId: string): string {
	return `${TURN_OUTCOME_PREFIX}${dispatchId}.json`;
}
