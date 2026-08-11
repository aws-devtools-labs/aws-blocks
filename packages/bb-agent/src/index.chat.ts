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
import type { AgentStreamChunk, InterruptResponse } from './types.js';

export type { ChatTransport, ChunkStream, TurnRequest } from './transport.js';
export { realtimeTransport } from './transport.js';
export type { AgentStreamChunk } from './types.js';

/** A message in the conversation (for UI rendering). */
export interface ChatMessage {
	id: string;
	role: 'user' | 'assistant' | 'approval';
	content: string;
	metadata?: Record<string, any>;
}

/** Conversation CRUD — plain request/response RPC to the backend, the same across every runtime. */
export interface ChatConversationApi {
	/** Create a new conversation and return its id. Called lazily on the first turn of a fresh chat. */
	createConversation(): Promise<{ conversationId: string }>;
	/** Load a conversation's message history for rendering. */
	getConversation(
		id: string,
	): Promise<{ messages: { role: string; content: string; metadata?: Record<string, any> }[] }>;
	/** Check whether a conversation has unanswered interrupts (e.g. the user left mid-approval). */
	getPendingInterrupts?(
		conversationId: string,
	): Promise<{ interrupts: Array<{ id: string; name: string; reason?: any }> }>;
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
	/** Called when the agent encounters an error. */
	onError?: (error: string) => void;
	/** Called when the agent pauses for human approval. Continue with `sendMessage({ interruptResponses })`. */
	onInterrupt?: (interrupts: Array<{ id: string; name: string; reason?: any }>) => void;
}

/** A message to start a turn, or the interrupt responses that resume a paused one. */
export type SendInput = string | { interruptResponses: InterruptResponse[] };

/** Returned by {@link createChat}. */
export interface ChatController {
	/** Drive the current turn — start a new message OR resume a paused one. Fuses subscribe + run (no race). */
	sendMessage(input: SendInput): Promise<void>;
	/** Primitive: run a turn (produce only; chunks go to subscribers). Lazily creates the conversation if new. */
	run(input: SendInput): Promise<{ channelId: string }>;
	/** Primitive: attach a consumer to a channel (the current one, or a shared/observed id). */
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

	function setLoading(next: boolean) {
		loading = next;
		options.onLoadingChange?.(loading);
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
			options.onInterrupt?.(chunk.interrupts);
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
		const channelId = id ?? crypto.randomUUID();

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
				options.onError?.(err instanceof Error ? err.message : String(err));
			} finally {
				// Tear down the underlying subscription (e.g. the WebSocket) when the
				// turn ends — otherwise resuming on the same channel would re-subscribe
				// over a still-open subscription and never see a fresh confirmation.
				stream.unsubscribe();
				if (activeStream === stream) activeStream = null;
			}
		})();
	}

	return {
		async sendMessage(input: SendInput) {
			if (loading) return;

			if (typeof input === 'string') {
				const userMsg: ChatMessage = { id: nextId(), role: 'user', content: input };
				const aMsg: ChatMessage = { id: nextId(), role: 'assistant', content: '' };
				assistantId = aMsg.id;
				assistantText = '';
				messages = [...messages, userMsg, aMsg];
			} else {
				// Resuming a paused turn — record the decisions, reuse/insert an assistant placeholder.
				for (const r of input.interruptResponses) {
					messages = [
						...messages,
						{
							id: nextId(),
							role: 'approval' as const,
							content: r.approved ? 'Approved' : 'Denied',
							metadata: { approved: r.approved, trust: r.trust, toolName: r.toolName, input: r.input },
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
			await startTurn(input);
		},

		async run(input: SendInput): Promise<{ channelId: string }> {
			const id = await ensureConversation();
			const channelId = id ?? crypto.randomUUID();
			if (typeof input === 'string') {
				return transport.run({ channelId, conversationId: id, message: input });
			}
			return transport.run({ channelId, conversationId: id, interruptResponses: input.interruptResponses });
		},

		subscribe(opts?: { channelId?: string; observer?: boolean }): ChunkStream {
			const channelId = opts?.channelId ?? conversationId;
			if (!channelId)
				throw new Error('subscribe() needs a channelId — start a conversation first or pass one explicitly.');
			return transport.subscribe(channelId, opts?.observer ? { observer: true } : undefined);
		},

		newConversation() {
			if (activeStream) {
				activeStream.unsubscribe();
				activeStream = null;
			}
			conversationId = null;
			messages = [];
			assistantId = null;
			assistantText = '';
			options.onMessagesChange?.(messages);
		},

		async loadConversation(id: string) {
			conversationId = id;
			const { messages: history } = await api.getConversation(id);
			messages = history
				.filter((m) => m.role === 'user' || m.role === 'assistant' || m.role === 'approval')
				.map((m) => ({
					id: nextId(),
					role: m.role as 'user' | 'assistant' | 'approval',
					content: m.content,
					metadata: m.metadata,
				}));
			options.onMessagesChange?.(messages);

			if (api.getPendingInterrupts) {
				const { interrupts } = await api.getPendingInterrupts(id);
				if (interrupts.length) options.onInterrupt?.(interrupts);
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
