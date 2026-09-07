// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Client hooks for Agent BB.
 *
 * useChat() provides state management for agent conversations.
 * Works with any framework — not React-specific (no JSX, no React imports).
 *
 * Flow:
 * 1. Subscribe to Realtime channel + await established
 * 2. Load existing history from DB
 * 3. Show history — any in-flight chunks are caught by the subscription
 * 4. User sends message — chunks arrive via the already-open subscription
 */

import type { AgentStreamChunk } from './types.js';

export type { AgentStreamChunk } from './types.js';

/** A message in the conversation (for UI rendering). */
export interface ChatMessage {
	id: string;
	role: 'user' | 'assistant' | 'approval';
	content: string;
	metadata?: Record<string, any>;
}

/** Handler invoked for each streaming chunk delivered over the Realtime channel. */
export type ChatChunkHandler = (chunk: AgentStreamChunk) => void;

/**
 * Options form accepted by {@link UseChatOptions.subscribe}.
 *
 * Mirrors bb-realtime's `SubscribeOptions` shape so an app's `subscribe` adapter can
 * forward this object straight to `channel.subscribe(...)`. useChat passes this object
 * (rather than a bare handler) so it can react to a mid-turn transport disconnect and,
 * on reconnect, re-sync authoritative state from the DB — the correctness backstop for
 * chunks lost while the socket was down.
 */
export interface ChatSubscribeOptions {
	/** Called for each incoming chunk (the streaming handler). */
	onMessage: ChatChunkHandler;
	/**
	 * Called when the connection is lost for any reason (including a client-initiated
	 * `unsubscribe()`). Optional — useChat does not require it, but forwards it so an
	 * adapter can surface drops.
	 */
	onDisconnect?: (reason: string) => void;
	/**
	 * Called after the transport transparently reconnects and this channel has been
	 * resubscribed. useChat uses this to re-sync from the DB (see {@link UseChatOptions.subscribe}).
	 */
	onReconnect?: () => void;
}

/** Options for creating a chat instance. */
export interface UseChatOptions {
	api: {
		sendMessage(conversationId: string, message: string, channelId: string): Promise<void>;
		createConversation(): Promise<{ conversationId: string }>;
		getConversation(id: string): Promise<{ messages: { role: string; content: string; metadata?: Record<string, any> }[] }>;
		resume?(channelId: string, responses: Array<{ interruptId: string; approved: boolean; trust?: boolean; toolName?: string; input?: any }>, conversationId?: string): Promise<void>;
		getPendingInterrupts?(conversationId: string): Promise<{ interrupts: Array<{ id: string; name: string; reason?: any }> }>;
	};
	/**
	 * Subscribe to a Realtime channel. Called with the channel id and either a bare
	 * chunk handler or a {@link ChatSubscribeOptions} object — useChat always passes the
	 * options object so it can react to disconnect/reconnect, but the bare-handler form
	 * is still accepted for backward compatibility. Adapters typically forward the second
	 * argument straight to `channel.subscribe(...)`, which accepts both shapes.
	 *
	 * Must return an object with:
	 * - unsubscribe(): stop receiving messages
	 * - established: Promise that resolves when the WS subscription is confirmed
	 */
	subscribe: (channelId: string, handlerOrOptions: ChatChunkHandler | ChatSubscribeOptions) => Promise<{ unsubscribe(): void; established: Promise<void> }>;
	/** Called whenever the message list changes. */
	onMessagesChange?: (messages: ChatMessage[]) => void;
	/** Called whenever loading state changes. */
	onLoadingChange?: (isLoading: boolean) => void;
	/** Called on each streaming chunk. */
	onChunk?: (chunk: AgentStreamChunk) => void;
	/** Called when the agent encounters an error. */
	onError?: (error: string) => void;
	/** Called when the agent needs human approval before continuing. */
	onInterrupt?: (interrupts: Array<{ id: string; name: string; reason?: any }>) => void;
}

/** Returned by useChat(). */
export interface ChatInstance {
	/** Send a message. Creates a conversation and subscribes if needed. */
	sendMessage(text: string): Promise<void>;
	/** Respond to an interrupt (tool approval). Resumes the agent. */
	respondToInterrupt(responses: Array<{ interruptId: string; approved: boolean; trust?: boolean; toolName?: string; input?: any }>): Promise<void>;
	/** Current messages. */
	getMessages(): ChatMessage[];
	/** Whether the agent is currently responding. */
	isLoading(): boolean;
	/** Current conversation ID (null until first message). */
	getConversationId(): string | null;
	/** Open a conversation: subscribe to Realtime, then load history. */
	loadConversation(conversationId: string): Promise<void>;
	/** Clean up the active subscription. */
	destroy(): void;
}

let messageCounter = 0;
function nextId(): string {
	return `msg-${++messageCounter}-${Date.now()}`;
}

/**
 * Last-resort window (ms) of COMPLETE SILENCE after a reconnect. The failsafe is a
 * backstop, NOT the primary recovery (which is the done chunk / DB re-sync). It is
 * re-armed by every received chunk (see handleChunk), so it only fires after a window
 * in which NO chunk at all arrived — not during a long tool-call/thinking gap or a slow
 * post-reconnect stream. On the multi-hour turns this feature targets, such gaps are
 * normal.
 *
 * This MUST comfortably exceed the Realtime transport's idle-timeout + reconnect budget
 * (API Gateway WebSocket: 10-min idle timeout, 2h max connection duration), otherwise a
 * perfectly normal idle → disconnect → reconnect cycle would trip a spurious 'Timed out'.
 * 11 minutes sits just above the 10-min idle timeout with margin for the reconnect.
 */
const RECONNECT_FAILSAFE_MS = 660_000;

/**
 * Create a chat instance for managing agent conversations.
 *
 * @example
 * ```typescript
 * const chat = useChat({
 *   api: {
 *     sendMessage: (convId, msg, chId) => api.agentStream(msg, convId, chId),
 *     createConversation: () => api.agentCreateConversationId(),
 *     getConversation: (id) => api.agentGetConversation(id),
 *   },
 *   subscribe: async (channelId, sub) => {
 *     const result = await api.agentGetChannel(channelId);
 *     // `sub` is a ChatSubscribeOptions object (onMessage/onReconnect/onDisconnect);
 *     // channel.subscribe accepts it directly and wires reconnect handling for us.
 *     return result.channel.subscribe(sub);
 *   },
 *   onMessagesChange: (msgs) => renderMessages(msgs),
 *   onLoadingChange: (loading) => updateSpinner(loading),
 * });
 *
 * await chat.loadConversation('conv-123');
 * await chat.sendMessage('Hello!');
 * ```
 */
export function useChat(options: UseChatOptions): ChatInstance {
	let messages: ChatMessage[] = [];
	let loading = false;
	let conversationId: string | null = null;
	let activeSub: { unsubscribe(): void } | null = null;
	let assistantId: string | null = null;
	let assistantText = '';
	/** Timer id for the post-reconnect failsafe (see RECONNECT_FAILSAFE_MS). null when disarmed. */
	let failsafeTimer: ReturnType<typeof setTimeout> | null = null;
	/**
	 * True once destroy() has run. Guards async callbacks (the reconnect re-sync and the
	 * failsafe timer) so no onLoadingChange/onError/onMessagesChange fires after teardown.
	 */
	let destroyed = false;
	/**
	 * Whether onError has already been reported for the CURRENT turn. A send-path
	 * rejection (e.g. a 504) may mean the turn actually STARTED server-side, so a later
	 * `error` chunk can arrive for the same turn; this guard reports onError at most once
	 * per turn. Reset when a new turn begins (sendMessage / respondToInterrupt).
	 */
	let errorReported = false;

	/** Cancel the post-reconnect failsafe timer if one is armed. */
	function clearFailsafe() {
		if (failsafeTimer !== null) {
			clearTimeout(failsafeTimer);
			failsafeTimer = null;
		}
	}

	/**
	 * Arm the bounded post-reconnect failsafe. If the turn is still running after a
	 * reconnect and the terminal chunk never arrives (lost a second time), this stops
	 * the spinner and surfaces an error rather than hanging loading=true forever.
	 */
	function armFailsafe() {
		clearFailsafe();
		failsafeTimer = setTimeout(() => {
			failsafeTimer = null;
			// Teardown guard: destroy() may have run while the timer was pending.
			if (destroyed) return;
			if (loading) {
				loading = false;
				options.onLoadingChange?.(loading);
				options.onError?.('Timed out waiting for the agent to respond after reconnect.');
			}
		}, RECONNECT_FAILSAFE_MS);
	}

	/**
	 * Drop the optimistic empty assistant placeholder (if present and still empty).
	 * Used on a send-path failure so no orphaned empty bubble is left in the UI.
	 */
	function removeEmptyAssistantPlaceholder() {
		if (!assistantId) return;
		const placeholder = messages.find(m => m.id === assistantId);
		if (placeholder && !placeholder.content) {
			messages = messages.filter(m => m.id !== assistantId);
			options.onMessagesChange?.(messages);
		}
		assistantId = null;
	}

	/**
	 * Surface an error to the consumer at most ONCE per turn (see errorReported). A 504
	 * send-rejection and a later `error` chunk can both describe the same failed turn; we
	 * must not fire onError twice for it.
	 */
	function reportError(message: string) {
		if (errorReported) return;
		errorReported = true;
		options.onError?.(message);
	}

	/**
	 * Shared handler for a rejected send path (api.sendMessage / api.resume): reset
	 * loading, drop the dangling empty placeholder, and surface the error via onError
	 * (swallowed, matching how the `error` chunk is handled — no re-throw).
	 *
	 * NOTE: a 504 (or similar) rejection often means the turn DID start server-side, so a
	 * later done/delta/error chunk may still arrive for it. Recovery of such a started
	 * turn happens via the normal reconnect → getConversation re-sync path; here we only
	 * guard against a DOUBLE onError (reportError) if that later chunk is an `error`.
	 */
	function handleSendFailure(err: unknown) {
		loading = false;
		options.onLoadingChange?.(loading);
		removeEmptyAssistantPlaceholder();
		reportError(err instanceof Error ? err.message : String(err));
	}

	/**
	 * Re-sync authoritative state from the DB after the transport transparently
	 * reconnects. Any chunks published while the socket was down were missed, so the
	 * persisted conversation is the source of truth:
	 * - If the turn completed server-side (history ends with a non-empty assistant
	 *   message), adopt that final text into the in-flight bubble and clear loading —
	 *   the `done` chunk was lost in the gap.
	 * - If the turn is still running (no final assistant message yet), keep loading
	 *   true and wait for the terminal chunk on the resubscribed channel, arming a
	 *   bounded failsafe so the spinner can't hang if that chunk is also lost.
	 * Also re-checks pending interrupts, which may have been raised during the gap.
	 */
	async function handleReconnect() {
		if (destroyed) return;
		if (!conversationId) return;
		// Capture the in-flight turn identity BEFORE the await. getConversation reads
		// DynamoDB, which is eventually consistent, so this read can (a) resolve LATE —
		// after a terminal chunk already resolved the turn on the resubscribed channel —
		// and (b) reflect a STALE view whose last row is a previous turn's assistant
		// message. Both are guarded against once the read resolves, using this snapshot.
		const turnAtStart = assistantId;
		try {
			const { messages: history } = await options.api.getConversation(conversationId);
			if (destroyed) return;
			const last = history[history.length - 1];
			const turnComplete = !!last && last.role === 'assistant' && !!last.content;

			// Turn-identity + liveness guard: only act on the persisted read if the turn we
			// captured is STILL the in-flight one and we're still loading. If a terminal
			// chunk (done/error) resolved the turn while getConversation was in flight, it
			// already nulled assistantId (and set the authoritative final text), so we must
			// ignore this — possibly stale — DB result rather than clobber a live outcome.
			const stillSameInFlightTurn = assistantId !== null && assistantId === turnAtStart && loading;

			if (turnComplete && stillSameInFlightTurn) {
				// Adopt the persisted final text ONLY if it extends what we've already
				// streamed this turn (nothing streamed yet, or the stream is a prefix of the
				// persisted text). If it does NOT extend our stream, `last` is a stale /
				// previous-turn assistant row that does not continue the current bubble;
				// adopting it would overwrite live text with prior-turn content and halt
				// streaming, so we treat the turn as still running and wait for the terminal
				// chunk instead.
				const extendsStream = assistantText === '' || last.content.startsWith(assistantText);
				if (extendsStream) {
					// Turn finished while we were disconnected; the terminal `done` chunk was lost.
					// Replace the in-flight assistant bubble with the persisted final text.
					assistantText = last.content;
					messages = messages.map(m => (m.id === assistantId ? { ...m, content: last.content } : m));
					options.onMessagesChange?.(messages);
					assistantId = null;
					clearFailsafe();
					loading = false;
					options.onLoadingChange?.(loading);
				} else {
					// Snapshot doesn't extend our stream — keep waiting for the terminal chunk,
					// guarded by the bounded failsafe.
					armFailsafe();
				}
			} else if (stillSameInFlightTurn) {
				// Turn still running server-side (no final assistant message yet) — do NOT clear
				// loading. Wait for the terminal chunk on the resubscribed channel, guarded by
				// the bounded failsafe.
				armFailsafe();
			}
			// else: the turn was already resolved by a terminal chunk during the await
			// (assistantId nulled / loading cleared) — nothing to adopt.

			// A pending interrupt may have been raised while the socket was down.
			if (options.api.getPendingInterrupts) {
				const { interrupts } = await options.api.getPendingInterrupts(conversationId);
				if (destroyed) return;
				if (interrupts.length) options.onInterrupt?.(interrupts);
			}
		} catch (err) {
			if (destroyed) return;
			// Re-sync itself failed. Surface it via onError only. We deliberately do NOT also
			// arm the failsafe here (NIT): the channel is resubscribed, so a terminal chunk can
			// still resolve the turn; arming would fire a second, misleading 'Timed out' error
			// ~11min later on top of the error we just surfaced.
			options.onError?.(err instanceof Error ? err.message : String(err));
		}
	}

	/** Handle a chunk from the Realtime subscription. */
	function handleChunk(chunk: AgentStreamChunk) {
		// Liveness: ANY received chunk proves the stream is alive. If the post-reconnect
		// failsafe is armed, re-arm it (reset its countdown) so it only ever fires after a
		// window of COMPLETE silence — not during a long tool-call/thinking gap or a slow
		// post-reconnect stream. Terminal chunks below still clearFailsafe outright.
		if (failsafeTimer !== null) armFailsafe();

		options.onChunk?.(chunk);

		if (chunk.type === 'text-delta' && chunk.text && assistantId) {
			assistantText += chunk.text;
			messages = messages.map(m => m.id === assistantId ? { ...m, content: assistantText } : m);
			options.onMessagesChange?.(messages);
		}

		if (chunk.type === 'done') {
			if (chunk.text && assistantId) {
				messages = messages.map(m => m.id === assistantId ? { ...m, content: chunk.text! } : m);
				options.onMessagesChange?.(messages);
			}
			// Null assistantId so it is a reliable in-flight signal: a later-resolving
			// reconnect re-sync must not adopt a (possibly stale) DB snapshot over this
			// already-resolved turn (see handleReconnect's turn-identity guard).
			assistantId = null;
			clearFailsafe();
			loading = false;
			options.onLoadingChange?.(loading);
		}

		if (chunk.type === 'error') {
			// Null assistantId (mirroring done/interrupt) so a later reconnect re-sync treats
			// the turn as resolved and won't clobber the bubble with a stale getConversation read.
			assistantId = null;
			clearFailsafe();
			loading = false;
			options.onLoadingChange?.(loading);
			// Report at most once per turn: a prior send-rejection may have already surfaced
			// onError for this same (server-started) turn.
			reportError(chunk.error ?? 'Unknown error');
		}

		if (chunk.type === 'interrupt' && chunk.interrupts) {
			// Remove empty assistant placeholder (no text was generated before interrupt)
			if (assistantId) {
				const assistant = messages.find(m => m.id === assistantId);
				if (assistant && !assistant.content) {
					messages = messages.filter(m => m.id !== assistantId);
					options.onMessagesChange?.(messages);
				}
			}
			assistantId = null;
			clearFailsafe();
			loading = false;
			options.onLoadingChange?.(loading);
			options.onInterrupt?.(chunk.interrupts);
		}
	}

	/** Subscribe to a conversation's Realtime channel and wait for WS confirmation. Retries with fresh token on auth failure. */
	async function ensureSubscribed(channelId: string) {
		if (activeSub) { activeSub.unsubscribe(); activeSub = null; }

		// Pass a plain options object (NOT a callable-with-props). Both bb-realtime
		// middlewares resolve subscribe with `typeof handlerOrOptions === 'function'`
		// FIRST — a function is treated as a bare handler and its onMessage/onReconnect/
		// onDisconnect properties are never read. A hybrid callable would therefore
		// silently drop onReconnect, making the reconnect re-sync + failsafe dead on the
		// real transport. The options object hits the transport's object branch.
		const subscribeArg: ChatSubscribeOptions = {
			onMessage: handleChunk,
			onReconnect: () => { void handleReconnect(); },
		};

		const sub = await options.subscribe(channelId, subscribeArg);
		try {
			await sub.established;
		} catch (err) {
			console.warn('Subscription failed, retrying with fresh token:', err);
			sub.unsubscribe();
			const retrySub = await options.subscribe(channelId, subscribeArg);
			await retrySub.established;
			activeSub = retrySub;
			return;
		}
		activeSub = sub;
	}

	return {
		async sendMessage(text: string) {
			if (loading) return;
			// Create conversation + subscribe on first message
			if (!conversationId) {
				const result = await options.api.createConversation();
				conversationId = result.conversationId;
				await ensureSubscribed(conversationId);
			}

			// Subscribe if not already (e.g., sendMessage without loadConversation)
			if (!activeSub) {
				await ensureSubscribed(conversationId);
			}

			// Add user message + assistant placeholder
			const userMsg: ChatMessage = { id: nextId(), role: 'user', content: text };
			const aMsg: ChatMessage = { id: nextId(), role: 'assistant', content: '' };
			assistantId = aMsg.id;
			assistantText = '';
			messages = [...messages, userMsg, aMsg];
			options.onMessagesChange?.(messages);
			errorReported = false; // fresh turn — allow one onError report
			loading = true;
			options.onLoadingChange?.(loading);

			// Submit — chunks arrive via the already-open subscription
			try {
				await options.api.sendMessage(conversationId, text, conversationId);
			} catch (err) {
				// Send failed (e.g. 504) — the turn never started server-side. Reset loading,
				// drop the empty assistant placeholder, and surface the error via onError.
				handleSendFailure(err);
			}
		},

		async respondToInterrupt(responses: Array<{ interruptId: string; approved: boolean; trust?: boolean; toolName?: string; input?: any }>) {
			if (loading) return;
			if (!conversationId) throw new Error('No active conversation');
			// Add approval messages to chat immediately
			for (const r of responses) {
				messages = [...messages, { id: nextId(), role: 'approval' as const, content: r.approved ? 'Approved' : 'Denied', metadata: { approved: r.approved, trust: r.trust, toolName: r.toolName, input: r.input } }];
			}
			// Reuse existing empty assistant placeholder or create one
			const existingEmpty = messages.find(m => m.role === 'assistant' && !m.content);
			if (existingEmpty) {
				assistantId = existingEmpty.id;
			} else {
				const aMsg: ChatMessage = { id: nextId(), role: 'assistant', content: '' };
				assistantId = aMsg.id;
				messages = [...messages, aMsg];
			}
			assistantText = '';
			options.onMessagesChange?.(messages);
			errorReported = false; // fresh turn — allow one onError report
			loading = true;
			options.onLoadingChange?.(loading);
			if (!options.api.resume) throw new Error('respondToInterrupt requires api.resume to be configured');
			try {
				await options.api.resume(conversationId, responses, conversationId);
			} catch (err) {
				// Resume failed — reset loading, drop the empty assistant placeholder, and
				// surface the error via onError (consistent with the sendMessage failsafe).
				handleSendFailure(err);
			}
		},

		getMessages() { return messages; },
		isLoading() { return loading; },
		getConversationId() { return conversationId; },

		async loadConversation(id: string) {
			conversationId = id;

			// 1. Subscribe FIRST — catch any in-flight chunks
			await ensureSubscribed(id);

			// 2. THEN load history from DB
			// TODO: buffer chunks received between subscribe and history load, then deduplicate/merge
			const { messages: history } = await options.api.getConversation(id);
			messages = history
				.filter(m => m.role === 'user' || m.role === 'assistant' || m.role === 'approval')
				.map(m => ({
					id: nextId(),
					role: m.role as 'user' | 'assistant' | 'approval',
					content: m.content,
					metadata: m.metadata,
				}));
			options.onMessagesChange?.(messages);

			// Check for pending interrupts (e.g., user left mid-approval)
			if (options.api.getPendingInterrupts) {
				const { interrupts } = await options.api.getPendingInterrupts(id);
				if (interrupts.length) options.onInterrupt?.(interrupts);
			}
		},

		destroy() {
			destroyed = true;
			clearFailsafe();
			if (activeSub) { activeSub.unsubscribe(); activeSub = null; }
		},
	};
}
