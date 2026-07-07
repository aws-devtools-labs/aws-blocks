// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Client hooks for Agent BB.
 *
 * useChat() provides state management for agent conversations.
 * Works with any framework — not React-specific (no JSX, no React imports).
 *
 * Transport: the app supplies a single `streamChunks(...)` function that yields
 * AgentStreamChunk objects for a turn. There is ONE contract for both environments:
 * - AWS: `streamChunks` opens an SSE connection to the AgentCore Runtime and yields
 *   frames as they arrive (true streaming).
 * - Local dev: the dev-server RPC layer can't stream, so `streamChunks` calls the app's
 *   buffered `agentStream`/`agentResume` (backed by `Agent.collect()`) and yields the
 *   returned chunks (optionally with small delays to simulate streaming).
 * Either way the chunks flow through the same `handleChunk` state machine below.
 *
 * Flow:
 * 1. Load existing history from DB (loadConversation)
 * 2. User sends message → iterate streamChunks(), applying each chunk
 * 3. Interrupt → user approves → respondToInterrupt() streams the resume turn
 */

import type { AgentStreamChunk } from './types.js';

export type { AgentStreamChunk } from './types.js';

// Browser WebSocket transport for streaming directly from the AgentCore Runtime on AWS.
// Re-exported here so apps get it from the same `@aws-blocks/bb-agent/client` entry as useChat.
export {
	createAgentCoreWsTransport,
	buildBearerSubprotocols,
	type AgentCoreWsEndpoint,
	type AgentCoreWsTurn,
} from './ws-transport.js';

/** A message in the conversation (for UI rendering). */
export interface ChatMessage {
	id: string;
	role: 'user' | 'assistant' | 'approval';
	content: string;
	metadata?: Record<string, any>;
}

/** An interrupt approval decision from the user. */
export interface InterruptDecision {
	interruptId: string;
	approved: boolean;
	trust?: boolean;
	toolName?: string;
	input?: any;
}

/** Options for creating a chat instance. */
export interface UseChatOptions {
	api: {
		createConversation(): Promise<{ conversationId: string }>;
		getConversation(
			id: string,
		): Promise<{ messages: { role: string; content: string; metadata?: Record<string, any> }[] }>;
		getPendingInterrupts?(
			conversationId: string,
		): Promise<{ interrupts: Array<{ id: string; name: string; reason?: any }> }>;
	};
	/**
	 * Stream a turn's chunks. Called for both the initial message and HITL resume:
	 * - initial: `{ conversationId, message }`
	 * - resume:  `{ conversationId, interruptResponses }`
	 * Must return an async-iterable of chunks. On AWS this wraps an SSE fetch to AgentCore;
	 * locally it wraps the buffered RPC response (see Agent.collect()).
	 */
	streamChunks: (args: {
		conversationId: string;
		message?: string;
		interruptResponses?: Array<{ interruptId: string; response: string }>;
	}) => AsyncIterable<AgentStreamChunk>;
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
	/** Send a message and stream the response. Creates a conversation on first call. */
	sendMessage(text: string): Promise<void>;
	/** Respond to an interrupt (tool approval) and stream the resumed response. */
	respondToInterrupt(responses: Array<InterruptDecision>): Promise<void>;
	/** Current messages. */
	getMessages(): ChatMessage[];
	/** Whether the agent is currently responding. */
	isLoading(): boolean;
	/** Current conversation ID (null until first message). */
	getConversationId(): string | null;
	/** Open a conversation: load history + surface any pending interrupt. */
	loadConversation(conversationId: string): Promise<void>;
	/** No-op; retained for API compatibility (no long-lived subscription to tear down). */
	destroy(): void;
}

let messageCounter = 0;
function nextId(): string {
	return `msg-${++messageCounter}-${Date.now()}`;
}

/** Translate a UI interrupt decision into the wire `response` string the agent expects. */
function decisionToResponse(r: InterruptDecision): string {
	return r.approved ? (r.trust ? 'trust' : 'yes') : 'no';
}

/**
 * Create a chat instance for managing agent conversations.
 *
 * @example
 * ```typescript
 * const chat = useChat({
 *   api: {
 *     createConversation: () => api.agentCreateConversationId(),
 *     getConversation: (id) => api.agentGetConversation(id),
 *   },
 *   streamChunks: (args) => agentStreamTransport(args), // SSE on AWS, buffered locally
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
	let assistantId: string | null = null;
	let assistantText = '';

	/** Apply a single chunk to the message state. Identical for streamed (AWS) and buffered (local) chunks. */
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
				const assistant = messages.find((m) => m.id === assistantId);
				if (assistant && !assistant.content) {
					messages = messages.filter((m) => m.id !== assistantId);
					options.onMessagesChange?.(messages);
				}
			}
			assistantId = null;
			loading = false;
			options.onLoadingChange?.(loading);
			options.onInterrupt?.(chunk.interrupts);
		}
	}

	/** Drive a turn's chunk stream through handleChunk. Surfaces transport errors as an error chunk. */
	async function consume(stream: AsyncIterable<AgentStreamChunk>) {
		try {
			for await (const chunk of stream) handleChunk(chunk);
		} catch (err) {
			handleChunk({ type: 'error', error: err instanceof Error ? err.message : String(err) });
		}
	}

	return {
		async sendMessage(text: string) {
			if (loading) return;
			if (!conversationId) {
				const result = await options.api.createConversation();
				conversationId = result.conversationId;
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

			await consume(options.streamChunks({ conversationId, message: text }));
		},

		async respondToInterrupt(responses: Array<InterruptDecision>) {
			if (loading) return;
			if (!conversationId) throw new Error('No active conversation');
			// Add approval messages to chat immediately
			for (const r of responses) {
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
			// Reuse existing empty assistant placeholder or create one
			const existingEmpty = messages.find((m) => m.role === 'assistant' && !m.content);
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

			const interruptResponses = responses.map((r) => ({
				interruptId: r.interruptId,
				response: decisionToResponse(r),
			}));
			await consume(options.streamChunks({ conversationId, interruptResponses }));
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

		async loadConversation(id: string) {
			conversationId = id;

			const { messages: history } = await options.api.getConversation(id);
			messages = history
				.filter((m) => m.role === 'user' || m.role === 'assistant' || m.role === 'approval')
				.map((m) => ({
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
			// No long-lived subscription in the SSE model — nothing to tear down.
		},
	};
}
