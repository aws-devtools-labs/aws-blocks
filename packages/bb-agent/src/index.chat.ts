// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * createChat() — the compute-agnostic client-facing chat API.
 *
 * The common case (one user, one conversation, stream the reply) is **one call**:
 *
 * ```typescript
 * const chat = createChat({ transport, api: { ...conversationCRUD } });
 * await chat.sendMessage('Hello');
 * ```
 *
 * `sendMessage` fuses *subscribe* + *run* (§3 primitives) into a single call, so
 * the consumer is attached for the whole turn by construction — the
 * subscribe-before-send race can't surface. The same call resumes a paused turn:
 * `sendMessage({ interruptResponses })`.
 *
 * The easy default is sugar over the flexible primitives, never a parallel API —
 * `run()` (produce only) and `subscribe()` (consume only) are exposed for the
 * power cases (fan-out, observer-only attach, decoupled produce/consume).
 *
 * The ONE variable piece is the {@link ChatTransport} (`transport`), which hides
 * the runtime. `api` is the ordinary conversation CRUD (create/load/interrupts),
 * unchanged across runtimes. Framework-agnostic — no React, drive the UI from the
 * `on*` callbacks.
 */

import type { ChatTransport, ChunkStream } from './transport.js';
import type { AgentStreamChunk, InterruptResponse, JSONValue } from './types.js';
import { AgentErrors, blocksAgentError } from './errors.js';

export type { ChatTransport, ChunkStream, TurnRequest } from './transport.js';
export { realtimeTransport } from './transport.js';
export type { AgentStreamChunk } from './types.js';

/** Typed metadata carried by an `approval` message — the recorded decision for a
 * resumed interrupt. All fields optional: a message records only what was set. */
export interface ApprovalMetadata {
	approved?: boolean;
	trust?: boolean;
	toolName?: string;
	/** The tool input the decision applied to (audit-only), coerced to a JSON value. */
	input?: JSONValue;
}

/**
 * A message in the conversation (for UI rendering), as a discriminated union on
 * `role`. Narrowing on `role === 'approval'` types `metadata` as {@link ApprovalMetadata}
 * — so a consumer reads `m.metadata?.approved` with no cast — while a plain
 * user/assistant message carries free-form JSON metadata.
 */
export type ChatMessage =
	| { id: string; role: 'user' | 'assistant'; content: string; metadata?: Record<string, JSONValue> }
	| { id: string; role: 'approval'; content: string; metadata?: ApprovalMetadata };

/** Conversation CRUD — plain request/response RPC to the backend, the same across every runtime. */
export interface ChatConversationApi {
	/** Create a new conversation and return its id. Called lazily on the first turn of a fresh chat. */
	createConversation(): Promise<{ conversationId: string }>;
	/** Load a conversation's message history for rendering. `metadata` is `unknown`:
	 * pass your backend's message metadata straight through — no per-call mapping or
	 * adapter. createChat narrows it internally when rendering an approval message. */
	getConversation(
		id: string,
	): Promise<{ messages: { role: string; content: string; metadata?: unknown }[] }>;
	/** Check whether a conversation has unanswered interrupts (e.g. the user left mid-approval). */
	getPendingInterrupts?(
		conversationId: string,
	): Promise<{ interrupts: { id: string; name: string; reason?: unknown }[] }>;
}

/** Options for {@link createChat}. */
export interface CreateChatOptions {
	/** The transport — the one runtime-specific piece. Configure it once (e.g. `realtimeTransport(...)`). */
	transport: ChatTransport;
	/** Conversation CRUD. Unchanged across runtimes. */
	api: ChatConversationApi;
	/** Called whenever the message list changes. */
	onMessagesChange?: (messages: ChatMessage[]) => void;
	/** Called whenever loading state changes. */
	onLoadingChange?: (isLoading: boolean) => void;
	/** Called on each streaming chunk. */
	onChunk?: (chunk: AgentStreamChunk) => void;
	/**
	 * Called when the agent encounters an error. `error` is the message; `cause` is the
	 * original error object when the failure was a rejected attach/run (undefined for a
	 * stream `error` chunk, which carries only a message), so a call site can
	 * `isBlocksError(cause, ...)` to branch on error type.
	 */
	onError?: (error: string, cause?: unknown) => void;
	/** Called when the agent pauses for human approval. Continue with `sendMessage({ interruptResponses })`.
	 *  Each interrupt's `interruptId` is the same field you pass back in `InterruptResponse` — no remap. */
	onInterrupt?: (interrupts: { interruptId: string; name: string; reason?: unknown }[]) => void;
}

/** A message to start a turn, or the interrupt responses that resume a paused one. */
export type SendInput = string | { interruptResponses: InterruptResponse[] };

/** Returned by {@link createChat}. */
export interface ChatController {
	/**
	 * Drive the current turn — start a new message OR resume a paused one. Fuses
	 * subscribe + run (no race). Resolves `true` when the turn was accepted, `false`
	 * when it was dropped because a turn is already in flight (so the caller can tell
	 * "sent" from "ignored" without pre-checking {@link isLoading}).
	 */
	sendMessage(input: SendInput): Promise<boolean>;
	/** Primitive: run a turn (produce only; chunks go to subscribers). Lazily creates the conversation if new. */
	run(input: SendInput): Promise<{ channelId: string }>;
	/**
	 * Primitive: attach a consumer to a channel (the current one, or a shared/observed id).
	 * On an inference-only chat the live channel is internal (a random UUID, not the null
	 * `conversationId`), so pass an explicit `channelId` — the id returned by `run()` — rather
	 * than relying on the current-channel fallback.
	 */
	subscribe(opts?: { channelId?: string; observer?: boolean }): ChunkStream;
	/** Start a fresh conversation — the next turn lazily creates one. */
	newConversation(): void;
	/** Switch to an existing conversation and load its history. */
	loadConversation(conversationId: string): Promise<void>;
	/** Current rendered messages, for the UI. */
	getMessages(): ChatMessage[];
	/** Whether a turn is currently in flight. */
	isLoading(): boolean;
	/** Current conversation id (null until the first turn). */
	getConversationId(): string | null;
	/** Cancel any in-flight turn subscription. */
	destroy(): void;
}

let messageCounter = 0;
function nextId(): string {
	return `msg-${++messageCounter}-${Date.now()}`;
}

/**
 * Coerce an arbitrary value into a {@link JSONValue} for audit metadata. A value that
 * is already JSON-round-trippable is kept as-is; anything else (a function, a symbol,
 * a cyclic object) becomes its string form, so metadata stays a clean JSONValue.
 */
function toJSONValue(value: unknown): JSONValue {
	try {
		// JSON.parse returns `any`, which is assignable to JSONValue without an
		// assertion — annotate the local so the type comes from the declaration,
		// not a cast. The round-trip guarantees the result is JSON-shaped.
		const parsed: JSONValue = JSON.parse(JSON.stringify(value));
		return parsed;
	} catch {
		return String(value);
	}
}

/**
 * Narrow an `unknown` message metadata value (customers pass their backend shape
 * straight through) into a JSON record for rendering. A plain object is round-tripped
 * to a clean {@link JSONValue} record via {@link toJSONValue}; a non-object (null,
 * string, array, undefined) yields `undefined`. This is the one narrow createChat
 * does so the customer never writes a per-call adapter.
 */
function asJSONRecord(value: unknown): Record<string, JSONValue> | undefined {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
	const json = toJSONValue(value);
	return typeof json === 'object' && json !== null && !Array.isArray(json) ? json : undefined;
}

/**
 * Create a chat controller for driving agent conversations over a {@link ChatTransport}.
 *
 * @example One call to stream a reply
 * ```typescript
 * const chat = createChat({
 *   transport,                                   // realtimeTransport(...) — the seam
 *   api: {
 *     createConversation:   () => api.agentCreateConversationId(),
 *     getConversation:      (id) => api.agentGetConversation(id),
 *     getPendingInterrupts: (id) => api.agentGetPendingInterrupts(id),
 *   },
 *   onMessagesChange: (msgs) => render(msgs),
 *   onInterrupt: async (interrupts) => {
 *     const decisions = await promptUser(interrupts);
 *     await chat.sendMessage({ interruptResponses: decisions }); // same call resumes
 *   },
 * });
 *
 * await chat.sendMessage('Plan our offsite');
 * ```
 */
export function createChat(options: CreateChatOptions): ChatController {
	const { transport, api } = options;
	let messages: ChatMessage[] = [];
	let loading = false;
	let conversationId: string | null = null;
	let activeStream: ChunkStream | null = null;
	let assistantId: string | null = null;
	let assistantText = '';
	// Inference-only chats have no persisted id, so the channel is a random UUID.
	// Remember it so a resume reuses the interrupted turn's channel. Reset on new chat.
	let lastChannelId: string | null = null;

	function setLoading(next: boolean) {
		// Idempotent: only notify on an actual change. A turn ends by BOTH the done/
		// error/interrupt handler and the background consumer's finally, so without this
		// guard a normal turn would fire onLoadingChange(false) twice.
		if (loading === next) return;
		loading = next;
		options.onLoadingChange?.(loading);
	}

	/**
	 * Resolve the channel for a **sendMessage** turn. The ONLY writer of `lastChannelId`
	 * (run() resolves without mutating it), so interleaving run() with sendMessage can't
	 * corrupt an inference-only resume target.
	 */
	function resolveChannelId(id: string | null, input: SendInput): string {
		if (id) return id;
		const isResume = typeof input !== 'string';
		if (isResume && lastChannelId) return lastChannelId;
		lastChannelId = crypto.randomUUID();
		return lastChannelId;
	}

	/** Drive UI state from a single chunk. Mirrors the useChat state machine. */
	function handleChunk(chunk: AgentStreamChunk) {
		options.onChunk?.(chunk);

		if (chunk.type === 'text-delta' && chunk.text && assistantId) {
			assistantText += chunk.text;
			messages = messages.map((m) => (m.id === assistantId ? { ...m, content: assistantText } : m));
			options.onMessagesChange?.(messages);
		}

		if (chunk.type === 'done') {
			if (chunk.text && assistantId) {
				messages = messages.map((m) => (m.id === assistantId ? { ...m, content: chunk.text! } : m));
				options.onMessagesChange?.(messages);
			}
			setLoading(false);
		}

		if (chunk.type === 'error') {
			// Drop the empty assistant placeholder if the error arrived before any text
			// (mirror the interrupt branch), so a failed turn leaves no blank bubble.
			if (assistantId) {
				const assistant = messages.find((m) => m.id === assistantId);
				if (assistant && !assistant.content) {
					messages = messages.filter((m) => m.id !== assistantId);
					options.onMessagesChange?.(messages);
				}
				assistantId = null;
			}
			setLoading(false);
			options.onError?.(chunk.error ?? 'Unknown error');
		}

		if (chunk.type === 'interrupt' && chunk.interrupts) {
			// Remove the empty assistant placeholder (no text generated before the interrupt).
			if (assistantId) {
				const assistant = messages.find((m) => m.id === assistantId);
				if (assistant && !assistant.content) {
					messages = messages.filter((m) => m.id !== assistantId);
					options.onMessagesChange?.(messages);
				}
			}
			assistantId = null;
			setLoading(false);
			// The stream chunk carries `id`; expose it as `interruptId` so it matches the
			// field the caller passes back in InterruptResponse (no remap at the call site).
			options.onInterrupt?.(chunk.interrupts.map((i) => ({ interruptId: i.id, name: i.name, reason: i.reason })));
		}
	}

	/** Lazily create the conversation on the first turn; returns the id (null stays null for inference-only). */
	async function ensureConversation(): Promise<string | null> {
		if (conversationId) return conversationId;
		const { conversationId: id } = await api.createConversation();
		conversationId = id;
		return conversationId;
	}

	/** Subscribe fresh, await confirmation, then run — the fused ordering that removes the race. */
	async function startTurn(input: SendInput) {
		const id = await ensureConversation();
		const channelId = resolveChannelId(id, input);

		// Attach the consumer BEFORE running — no early chunk can be dropped.
		if (activeStream) activeStream.unsubscribe();
		const stream = transport.subscribe(channelId);
		activeStream = stream;
		await stream.established;

		if (typeof input === 'string') {
			await transport.run({ channelId, conversationId: id, message: input });
		} else {
			await transport.run({ channelId, conversationId: id, interruptResponses: input.interruptResponses });
		}

		// Consume in the background; the stream ends on done/error/interrupt.
		void (async () => {
			try {
				for await (const chunk of stream) handleChunk(chunk);
			} catch (err) {
				setLoading(false);
				options.onError?.(err instanceof Error ? err.message : String(err), err);
			} finally {
				// Tear down the underlying subscription (e.g. the WebSocket) when the
				// turn ends — otherwise resuming on the same channel would re-subscribe
				// over a still-open subscription and never see a fresh confirmation.
				stream.unsubscribe();
				if (activeStream === stream) activeStream = null;
				// Clear loading unconditionally: a terminal chunk already cleared it, but a
				// stream ended by unsubscribe() (newConversation()/destroy() mid-turn) sees
				// no terminal chunk, so without this `loading` would stay true and the
				// `if (loading) return` guard in sendMessage would drop every future send.
				setLoading(false);
			}
		})();
	}

	return {
		async sendMessage(input: SendInput) {
			if (loading) return false;

			if (typeof input === 'string') {
				const userMsg: ChatMessage = { id: nextId(), role: 'user', content: input };
				const aMsg: ChatMessage = { id: nextId(), role: 'assistant', content: '' };
				assistantId = aMsg.id;
				assistantText = '';
				messages = [...messages, userMsg, aMsg];
			} else {
				// Resuming a paused turn — record the decisions, reuse/insert an assistant placeholder.
				for (const r of input.interruptResponses) {
					// Build the approval decision as typed ApprovalMetadata (no `any`, no cast):
					// include only the fields that are set. `input` is InterruptResponse.input
					// (audit-only) — coerce to a JSON value when it isn't already one.
					const metadata: ApprovalMetadata = {};
					if (r.approved !== undefined) metadata.approved = r.approved;
					if (r.trust !== undefined) metadata.trust = r.trust;
					if (r.toolName !== undefined) metadata.toolName = r.toolName;
					if (r.input !== undefined) metadata.input = toJSONValue(r.input);
					messages = [
						...messages,
						{
							id: nextId(),
							role: 'approval' as const,
							content: r.approved ? 'Approved' : 'Denied',
							metadata,
						},
					];
				}
				const existingEmpty = messages.find((m) => m.role === 'assistant' && !m.content);
				if (existingEmpty) {
					assistantId = existingEmpty.id;
				} else {
					const aMsg: ChatMessage = { id: nextId(), role: 'assistant', content: '' };
					assistantId = aMsg.id;
					messages = [...messages, aMsg];
				}
				assistantText = '';
			}
			options.onMessagesChange?.(messages);
			setLoading(true);
			// startTurn's attach + submit run before the background consumer's try/catch,
			// so a rejection here must clear loading (else the guard wedges future sends).
			try {
				await startTurn(input);
			} catch (err) {
				if (assistantId) {
					const assistant = messages.find((m) => m.id === assistantId);
					if (assistant && !assistant.content) {
						messages = messages.filter((m) => m.id !== assistantId);
						options.onMessagesChange?.(messages);
					}
					assistantId = null;
				}
				setLoading(false);
				options.onError?.(err instanceof Error ? err.message : String(err), err);
			}
			return true;
		},

		async run(input: SendInput): Promise<{ channelId: string }> {
			const id = await ensureConversation();
			// run() does NOT touch `lastChannelId` (sendMessage owns it). Persisted chat →
			// conversationId; inference-only → a fresh channel per call. Resume an
			// inference-only turn through the same entry point that started it.
			const channelId = id ?? crypto.randomUUID();
			if (typeof input === 'string') {
				return transport.run({ channelId, conversationId: id, message: input });
			}
			return transport.run({ channelId, conversationId: id, interruptResponses: input.interruptResponses });
		},

		subscribe(opts?: { channelId?: string; observer?: boolean }): ChunkStream {
			const channelId = opts?.channelId ?? conversationId;
			if (!channelId)
				throw blocksAgentError(
					AgentErrors.InvalidUsage,
					'subscribe() needs a channelId — start a conversation first or pass one explicitly.',
				);
			return transport.subscribe(channelId, opts?.observer ? { observer: true } : undefined);
		},

		newConversation() {
			if (activeStream) {
				activeStream.unsubscribe();
				activeStream = null;
			}
			conversationId = null;
			lastChannelId = null;
			messages = [];
			assistantId = null;
			assistantText = '';
			options.onMessagesChange?.(messages);
		},

		async loadConversation(id: string) {
			conversationId = id;
			const { messages: history } = await api.getConversation(id);
			messages = history.flatMap<ChatMessage>((m) => {
				// metadata arrives as `unknown` (customers pass their backend shape
				// straight through — no adapter). Narrow it HERE, once, so the customer
				// never writes this: a plain object becomes the JSON record, anything
				// else is dropped.
				const record = asJSONRecord(m.metadata);
				if (m.role === 'user' || m.role === 'assistant') {
					return [{ id: nextId(), role: m.role, content: m.content, metadata: record }];
				}
				if (m.role === 'approval') {
					// Project the narrowed record into the typed ApprovalMetadata shape:
					// read the known keys, keep the JSON-safe types.
					const meta: ApprovalMetadata = {};
					const src = record ?? {};
					if (typeof src.approved === 'boolean') meta.approved = src.approved;
					if (typeof src.trust === 'boolean') meta.trust = src.trust;
					if (typeof src.toolName === 'string') meta.toolName = src.toolName;
					if (src.input !== undefined) meta.input = src.input;
					return [{ id: nextId(), role: 'approval', content: m.content, metadata: meta }];
				}
				return [];
			});
			options.onMessagesChange?.(messages);

			if (api.getPendingInterrupts) {
				const { interrupts } = await api.getPendingInterrupts(id);
				if (interrupts.length)
					options.onInterrupt?.(interrupts.map((i) => ({ interruptId: i.id, name: i.name, reason: i.reason })));
			}
		},

		getMessages() {
			return messages;
		},
		isLoading() {
			return loading;
		},
		getConversationId() {
			return conversationId;
		},

		destroy() {
			if (activeStream) {
				activeStream.unsubscribe();
				activeStream = null;
			}
		},
	};
}
