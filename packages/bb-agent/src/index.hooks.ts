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
	 * Subscribe to a Realtime channel. Must return an object with:
	 * - unsubscribe(): stop receiving messages
	 * - established: Promise that resolves when the WS subscription is confirmed
	 */
	subscribe: (channelId: string, handler: (chunk: AgentStreamChunk) => void) => Promise<{ unsubscribe(): void; established: Promise<void> }>;
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
 *   subscribe: async (channelId, handler) => {
 *     const result = await api.agentGetChannel(channelId);
 *     return result.channel.subscribe(handler);
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
	let loadingHistory = false;
	let bufferedChunks: AgentStreamChunk[] = [];

	/** Handle a chunk from the Realtime subscription. */
	function handleChunk(chunk: AgentStreamChunk) {
		if (loadingHistory) {
			bufferedChunks.push(chunk);
			return;
		}
		applyChunk(chunk);
	}

	function ensureAssistantMessage() {
		if (assistantId) return;
		const message: ChatMessage = { id: nextId(), role: 'assistant', content: '' };
		assistantId = message.id;
		assistantText = '';
		messages = [...messages, message];
		options.onMessagesChange?.(messages);
	}

	function applyChunk(chunk: AgentStreamChunk, skipTextUpdate = false) {
		options.onChunk?.(chunk);

		if (chunk.type === 'text-delta' && chunk.text && !skipTextUpdate) {
			ensureAssistantMessage();
			assistantText += chunk.text;
			messages = messages.map(m => m.id === assistantId ? { ...m, content: assistantText } : m);
			options.onMessagesChange?.(messages);
		}

		if (chunk.type === 'done') {
			const text = chunk.text;
			if (text && !skipTextUpdate) {
				ensureAssistantMessage();
				assistantText = text;
				messages = messages.map(m => m.id === assistantId ? { ...m, content: text } : m);
				options.onMessagesChange?.(messages);
			}
			loading = false;
			options.onLoadingChange?.(loading);
		}

		if (chunk.type === 'error') {
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
			loading = false;
			options.onLoadingChange?.(loading);
			options.onInterrupt?.(chunk.interrupts);
		}
	}

	/** Subscribe to a conversation's Realtime channel and wait for WS confirmation. Retries with fresh token on auth failure. */
	async function ensureSubscribed(channelId: string) {
		if (activeSub) { activeSub.unsubscribe(); activeSub = null; }

		const sub = await options.subscribe(channelId, handleChunk);
		try {
			await sub.established;
		} catch (err) {
			console.warn('Subscription failed, retrying with fresh token:', err);
			sub.unsubscribe();
			const retrySub = await options.subscribe(channelId, handleChunk);
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
			await options.api.sendMessage(conversationId, text, conversationId);
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
			await options.api.resume(conversationId, responses, conversationId);
		},

		getMessages() { return messages; },
		isLoading() { return loading; },
		getConversationId() { return conversationId; },

		async loadConversation(id: string) {
			conversationId = id;
			assistantId = null;
			assistantText = '';
			bufferedChunks = [];
			loadingHistory = true;

			try {
				// 1. Subscribe FIRST — catch any in-flight chunks
				await ensureSubscribed(id);

				// 2. THEN load history from DB. Chunks can arrive while this request is in flight,
				// so replay them after the history establishes the message list they extend.
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

				const chunks = bufferedChunks;
				bufferedChunks = [];
				loadingHistory = false;

				const completion = [...chunks].reverse().find(chunk => chunk.type === 'done' && chunk.text);
				const latestMessage = messages.at(-1);
				const historyAlreadyHasCompletion = completion?.text !== undefined
					&& latestMessage?.role === 'assistant'
					&& latestMessage.content === completion.text;

				for (const chunk of chunks) {
					applyChunk(chunk, historyAlreadyHasCompletion && (chunk.type === 'text-delta' || chunk.type === 'done'));
				}
			} finally {
				loadingHistory = false;
				bufferedChunks = [];
			}

			// Check for pending interrupts (e.g., user left mid-approval)
			if (options.api.getPendingInterrupts) {
				const { interrupts } = await options.api.getPendingInterrupts(id);
				if (interrupts.length) options.onInterrupt?.(interrupts);
			}
		},

		destroy() {
			if (activeSub) { activeSub.unsubscribe(); activeSub = null; }
		},
	};
}
