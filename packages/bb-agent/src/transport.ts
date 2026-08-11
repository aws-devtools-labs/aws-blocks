// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The compute-agnostic transport seam for the client-facing chat API.
 *
 * A `ChatTransport` is the ONE variable piece across runtimes: it knows how to
 * *run* a turn (produce chunks) and how to *subscribe* to a turn's chunks
 * (consume them). Everything runtime-specific — Lambda + Realtime today, an
 * AgentCore socket or a container tomorrow — lives inside a transport, so the
 * client API (`createChat`) never names a runtime.
 *
 * The transport exposes exactly the two primitives the flexible API (§3) is
 * built from: `run` (produce) and `subscribe` (consume). `createChat`'s easy
 * default fuses them into one call so the common case is correct by construction
 * (no subscribe-before-send race); the primitives stay reachable for fan-out,
 * observer-only attach, and decoupled produce/consume.
 */

import type { AgentStreamChunk, InterruptResponse } from './types.js';

/**
 * A request to run one turn on the backend.
 *
 * Either `message` (a new turn) or `interruptResponses` (resume a paused turn)
 * is set — never both. `conversationId` may be null for inference-only chats
 * that don't persist history; `channelId` is where chunks are delivered.
 */
export interface TurnRequest {
	/** Channel the turn's chunks are delivered on. Defaults to `conversationId` in the easy path. */
	channelId: string;
	/** Persisted conversation this turn belongs to, or null for inference-only chats. */
	conversationId: string | null;
	/** A new user message. Mutually exclusive with `interruptResponses`. */
	message?: string;
	/** Responses that resume a paused (interrupted) turn. Mutually exclusive with `message`. */
	interruptResponses?: InterruptResponse[];
}

/**
 * An async stream of chunks for one channel. Iterate it with `for await`; it
 * ends when the turn reaches `done`/`error`/`interrupt`. `established` resolves
 * once the consumer is attached (e.g. the WebSocket subscription is confirmed),
 * which is what lets `createChat` guarantee no early chunk is dropped.
 */
export interface ChunkStream extends AsyncIterable<AgentStreamChunk> {
	/** Resolves when the consumer is attached (subscribe confirmed); rejects if attach fails. */
	established: Promise<void>;
	/** Detach the consumer and end the iterator. */
	unsubscribe(): void;
}

/**
 * The seam. A transport turns a runtime's streaming mechanism into two
 * primitives the client API composes.
 */
export interface ChatTransport {
	/**
	 * Attach a consumer to a channel and return its chunk stream. Attaching does
	 * not run a turn — call `run` (or let `createChat.sendMessage` fuse the two).
	 * `observer: true` is a hint that this consumer only watches (never drives).
	 */
	subscribe(channelId: string, opts?: { observer?: boolean }): ChunkStream;
	/**
	 * Run a turn. Produces chunks on `turn.channelId`; it does NOT return them —
	 * they flow to whoever is subscribed. Resolves once the turn is accepted.
	 */
	run(turn: TurnRequest): Promise<{ channelId: string }>;
}

/**
 * A minimal single-consumer push queue that adapts a callback source (the
 * Realtime channel's `subscribe(handler)`) into an `AsyncIterable`. Chunks
 * pushed before the consumer pulls are buffered in `queue`; pulls that arrive
 * first park in `pending`. `close()` ends iteration once the buffer drains.
 */
class ChunkQueue implements AsyncIterable<AgentStreamChunk> {
	private queue: AgentStreamChunk[] = [];
	private pending: ((r: IteratorResult<AgentStreamChunk>) => void)[] = [];
	private closed = false;

	push(chunk: AgentStreamChunk): void {
		if (this.closed) return;
		const waiter = this.pending.shift();
		if (waiter) waiter({ value: chunk, done: false });
		else this.queue.push(chunk);
	}

	close(): void {
		if (this.closed) return;
		this.closed = true;
		for (const waiter of this.pending.splice(0)) waiter({ value: undefined, done: true });
	}

	async *[Symbol.asyncIterator](): AsyncGenerator<AgentStreamChunk> {
		while (true) {
			if (this.queue.length) {
				yield this.queue.shift()!;
				continue;
			}
			if (this.closed) return;
			const next = await new Promise<IteratorResult<AgentStreamChunk>>((resolve) => this.pending.push(resolve));
			if (next.done) return;
			yield next.value;
		}
	}
}

/** Chunk types that end a turn — after any of these no more chunks arrive on the channel. */
const TERMINAL_TYPES: ReadonlySet<AgentStreamChunk['type']> = new Set(['done', 'error', 'interrupt']);

/**
 * The Realtime + Lambda implementation of {@link ChatTransport} — the current
 * runtime's transport. It bridges the Realtime channel's callback `subscribe`
 * into a {@link ChunkStream} and maps `run` onto the app's `sendMessage`/`resume`
 * RPCs (which submit the backend AsyncJob that runs Strands and publishes chunks).
 *
 * This is the one piece of boilerplate an app wires per runtime — ship it as a
 * copy-paste snippet (see README). The `io` callbacks are ordinary RPC calls the
 * app already exposes on its `ApiNamespace`:
 *
 * @example
 * ```typescript
 * const transport = realtimeTransport({
 *   subscribe: async (channelId, handler) => {
 *     const { channel } = await api.agentGetChannel(channelId);
 *     return channel.subscribe(handler);
 *   },
 *   sendMessage: (channelId, message, conversationId) =>
 *     api.agentStream(message, conversationId ?? undefined, channelId),
 *   resume: (channelId, responses, conversationId) =>
 *     api.agentResume(channelId, responses, conversationId ?? undefined),
 * });
 * ```
 */
export function realtimeTransport(io: {
	/** Subscribe to a Realtime channel; return the subscription handle (unsubscribe + established). */
	subscribe: (
		channelId: string,
		handler: (chunk: AgentStreamChunk) => void,
	) => Promise<{ unsubscribe(): void; established: Promise<void> }>;
	/** Start a new turn — submits the backend job that publishes chunks to `channelId`. */
	sendMessage: (channelId: string, message: string, conversationId: string | null) => Promise<void>;
	/** Resume a paused turn with the user's interrupt responses. */
	resume: (channelId: string, responses: InterruptResponse[], conversationId: string | null) => Promise<void>;
}): ChatTransport {
	return {
		subscribe(channelId: string): ChunkStream {
			const q = new ChunkQueue();
			let unsub: (() => void) | null = null;

			// Attach immediately so chunks published after this point are captured;
			// `established` surfaces the subscription-confirmed signal to the caller.
			const established = io
				.subscribe(channelId, (chunk) => {
					q.push(chunk);
					if (TERMINAL_TYPES.has(chunk.type)) q.close();
				})
				.then((sub) => {
					unsub = sub.unsubscribe;
					return sub.established;
				});

			return {
				established,
				unsubscribe() {
					unsub?.();
					q.close();
				},
				[Symbol.asyncIterator]: () => q[Symbol.asyncIterator](),
			};
		},

		async run(turn: TurnRequest): Promise<{ channelId: string }> {
			if (turn.interruptResponses?.length) {
				await io.resume(turn.channelId, turn.interruptResponses, turn.conversationId);
			} else {
				await io.sendMessage(turn.channelId, turn.message ?? '', turn.conversationId);
			}
			return { channelId: turn.channelId };
		},
	};
}
