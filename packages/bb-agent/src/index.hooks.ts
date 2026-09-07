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
 * Last-resort window (ms) after a reconnect. If neither the terminal chunk on the
 * resubscribed channel nor the getConversation re-sync resolves the turn within this
 * bound, useChat stops the spinner and surfaces an error so the UI can never hang
 * forever. This is a backstop, NOT the primary recovery (which is the done chunk /
 * DB re-sync). Kept generous so it only fires when both of those genuinely fail.
 */
const RECONNECT_FAILSAFE_MS = 30_000;

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
	 * Shared handler for a rejected send path (api.sendMessage / api.resume): reset
	 * loading, drop the dangling empty placeholder, and surface the error via onError
	 * (swallowed, matching how the `error` chunk is handled — no re-throw).
	 */
	function handleSendFailure(err: unknown) {
		loading = false;
		options.onLoadingChange?.(loading);
		removeEmptyAssistantPlaceholder();
		options.onError?.(err instanceof Error ? err.message : String(err));
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
		if (!conversationId) return;
		try {
			const { messages: history } = await options.api.getConversation(conversationId);
			const last = history[history.length - 1];
			const turnComplete = !!last && last.role === 'assistant' && !!last.content;

			if (turnComplete && assistantId) {
				// Turn finished while we were disconnected; the terminal `done` chunk was lost.
				// Replace the in-flight assistant bubble with the persisted final text.
				assistantText = last.content;
				messages = messages.map(m => (m.id === assistantId ? { ...m, content: last.content } : m));
				options.onMessagesChange?.(messages);
				assistantId = null;
				clearFailsafe();
				loading = false;
				options.onLoadingChange?.(loading);
			} else if (loading) {
				// Turn still running server-side — do NOT clear loading. Wait for the terminal
				// chunk on the resubscribed channel, guarded by the bounded failsafe.
				armFailsafe();
			}

			// A pending interrupt may have been raised while the socket was down.
			if (options.api.getPendingInterrupts) {
				const { interrupts } = await options.api.getPendingInterrupts(conversationId);
				if (interrupts.length) options.onInterrupt?.(interrupts);
			}
		} catch (err) {
			// Re-sync itself failed. Surface it, and keep the spinner honest via the failsafe.
			if (loading) armFailsafe();
			options.onError?.(err instanceof Error ? err.message : String(err));
		}
	}

	/** Handle a chunk from the Realtime subscription. */
	function handleChunk(chunk: AgentStreamChunk) {
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
			clearFailsafe();
			loading = false;
			options.onLoadingChange?.(loading);
		}

		if (chunk.type === 'error') {
			clearFailsafe();
			loading = false;
			options.onLoadingChange?.(loading);
			options.onError?.(chunk.error ?? 'Unknown error');
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

		// Pass an options object (not a bare handler) so the transport can notify us on
		// reconnect — we re-sync authoritative state from the DB in handleReconnect().
		const subscribeOptions: ChatSubscribeOptions = {
			onMessage: handleChunk,
			onReconnect: () => { void handleReconnect(); },
		};

		const sub = await options.subscribe(channelId, subscribeOptions);
		try {
			await sub.established;
		} catch (err) {
			console.warn('Subscription failed, retrying with fresh token:', err);
			sub.unsubscribe();
			const retrySub = await options.subscribe(channelId, subscribeOptions);
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
			clearFailsafe();
			if (activeSub) { activeSub.unsubscribe(); activeSub = null; }
		},
	};
}
