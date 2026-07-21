// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import type { z } from 'zod';
import type { RealtimeChannel } from '@aws-blocks/bb-realtime';
import type { ChildLogger } from '@aws-blocks/bb-logger';

/** Any JSON-serializable value. */
export type JSONValue = string | number | boolean | null | { [key: string]: JSONValue } | JSONValue[];

export interface ModelConfig {
	/**
	 * - `'bedrock'` — Amazon Bedrock (default for AWS deploy)
	 * - `'openai-api'` — any OpenAI-compatible endpoint. Defaults to OpenAI (`api.openai.com`), set `endpoint` for Ollama/vLLM/etc.
	 * - `'canned'` — keyword-based mock, no real model (default for local dev)
	 */
	provider: 'bedrock' | 'openai-api' | 'canned';
	modelId?: string;
	endpoint?: string;
	/** API key for openai-api provider. Accepts a string or an async resolver (e.g., `() => appSetting.get()`). Falls back to OPENAI_API_KEY env var. */
	apiKey?: string | (() => Promise<string>);
	inferenceConfig?: InferenceConfig;
	guardrails?: GuardrailsConfig;
}

export interface InferenceConfig {
	temperature?: number;
	topP?: number;
	maxTokens?: number;
	stopSequences?: string[];
}

export interface GuardrailsConfig {
	contentFilters?: Record<string, string>;
	pii?: Record<string, string>;
	blockedTopics?: string[];
}

/**
 * Default type for the per-call tool context when no `toolContextSchema` is provided.
 * Tools receive this (optional) object carrying request-scoped data passed via `stream`/`resume`.
 */
export type DefaultToolContext = Record<string, any>;

export interface AgentConfig<TContext = DefaultToolContext> {
	/**
	 * When true, disables all persistence (no DistributedTable, no SessionManager).
	 * The agent does inference + tools only — no conversation history.
	 */
	inferenceOnly?: boolean;
	model?: {
		/** Model(s) for AWS deployment. Tries candidates in order; throws if all fail. Defaults to BedrockModels.BALANCED. */
		deployed?: ModelConfig | ModelConfig[];
		/** Model(s) for local development. Tries candidates in order; canned is implicit last fallback. */
		local?: ModelConfig | ModelConfig[];
	};
	systemPrompt: string;
	name?: string;
	description?: string;
	/**
	 * Tools the agent can call, declared as a callback that receives the `tool()`
	 * factory and returns a Record keyed by tool name:
	 *
	 * ```ts
	 * tools: (tool) => ({ getOrder: tool({ description, parameters, handler }) })
	 * ```
	 *
	 * The callback form lets TypeScript infer each tool's `input` from its
	 * `parameters` and types `context` from `toolContextSchema` — without importing a
	 * separate helper. A plain object/array is rejected at compile time.
	 */
	tools?: ToolsConfig<TContext>;
	/**
	 * Optional Zod schema for the per-call tool context — the object you pass through
	 * `invoke`/`stream`/`resume` and that every tool handler receives as `context`.
	 *
	 * When set:
	 * - `stream()`/`resume()` require a matching `context` (validated at call time)
	 * - tool `handler`/`interrupt` functions receive `context` typed as `z.infer<typeof toolContextSchema>`
	 *
	 * When omitted, `context` is optional and typed as `Record<string, any>`.
	 *
	 * Use this to carry request-scoped data (e.g. `userId`, tenant, auth claims) into tools
	 * so they can scope their behaviour to the caller.
	 */
	toolContextSchema?: z.ZodType<TContext>;
	conversation?: ConversationManagerConfig;
	structuredOutput?: z.ZodType;
	/** Controls how text chunks are published to the client via Realtime.
	 * - `'token'`: publish every text delta immediately
	 * - `'block'` (default): buffer text and publish when a full content block completes
	 */
	// TODO: add 'sentence' mode — regex-based sentence boundary detection ([.!?]\s)
	streamingMode?: 'token' | 'block';
	/**
	 * CDK removal behavior for the inner sessions FileBucket. When omitted,
	 * CDK's default applies (RETAIN — session blobs persist on `cdk destroy`).
	 * Pass `'destroy'` for sandbox / ephemeral stacks where the bucket
	 * should be dropped on teardown (also enables `autoDeleteObjects`).
	 *
	 * Templates that apply `RemovalPolicies.of(stack).destroy()` at the
	 * top level override this; for cleanly-deletable test stacks, set
	 * `'destroy'` here so the sessions bucket gets paired with
	 * `autoDeleteObjects: true` at construct time.
	 *
	 * Ignored by the mock and browser runtimes.
	 */
	removalPolicy?: 'destroy' | 'retain';
	/** Optional logger for internal operations. When omitted, a default Logger at error level is created. */
	logger?: ChildLogger;
}

/**
 * How to manage message history when the context window fills up.
 *
 * - `'sliding-window'` (default) — keeps the last N messages, drops older ones
 * - `'summarizing'` — summarizes older messages, keeps recent ones intact
 */
export type ConversationManagerConfig =
	| { strategy?: 'sliding-window'; /** Number of messages to keep */ windowSize?: number }
	| { strategy: 'summarizing'; /** Fraction of messages to summarize */ summaryRatio?: number; /** Recent messages to always preserve */ preserveRecentMessages?: number };

/** Context passed to tool handlers and interrupt functions. */
export interface ToolHandlerArgs<TInput = any, TContext = DefaultToolContext> {
	/** The validated tool input, typed from the tool's `parameters` schema. */
	input: TInput;
	/**
	 * Per-call context passed through from `stream`/`resume`. Carries request-scoped
	 * data (e.g. `userId`, tenant, auth claims) so tools can scope behaviour to the caller.
	 *
	 * Typed via the Agent's `toolContextSchema` when provided; otherwise `Record<string, any>`.
	 */
	context: TContext;
	/** Pause the agent and request user input. Returns the user's response when resumed.
	 * @param params.name - Unique identifier for this interrupt (e.g., 'confirm-transfer'). Used to match responses on resume.
	 * @param params.reason - JSON-serializable context sent to the client. Use this to provide display information (message, tool name, input values) for rendering the approval/question UI.
	 */
	interrupt: <T = JSONValue>(params: { name: string; reason?: any }) => T;
}

/** A single response to an interrupt, passed to `agent.resume()`. */
export interface InterruptResponse {
	/** Which interrupt to respond to. */
	interruptId: string;
	/** Approve the tool. Mutually exclusive with `response`. */
	approved?: boolean;
	/** Trust the tool for the rest of the conversation. Only used with `approved: true`. */
	trust?: boolean;
	/** Freeform response (for custom interrupts). Overrides approved/trust if set. */
	response?: JSONValue;
	/** Optional — saved to conversation history for audit purposes only. Does not affect behavior. */
	toolName?: string;
	/** Optional — saved to conversation history for audit purposes only. Does not affect behavior. */
	input?: any;
}

export interface ToolDefinition<TContext = DefaultToolContext, TParams extends z.ZodType = z.ZodType<any>> {
	/**
	 * Optional explicit tool name. When tools are declared as a Record (the key is
	 * the tool name), this is unnecessary and the key wins.
	 */
	name?: string;
	description: string;
	parameters: TParams;
	/** When true, the agent pauses for user approval before executing this tool. Defaults to false. Mutually exclusive with `interrupt`. */
	needsApproval?: boolean;
	/** When true (and `needsApproval` is true), user can respond "trust" to auto-approve this tool for the rest of the conversation. */
	trustable?: boolean;
	/** General interrupt logic — called before tool execution with `{ input, context, interrupt }`. Call `interrupt()` to pause the agent. Mutually exclusive with `needsApproval`. */
	interrupt?: (args: ToolHandlerArgs<z.infer<TParams>, TContext>) => void;
	/**
	 * Tool implementation. Receives a single argument object with:
	 * - `input` — the validated tool input, typed from `parameters`
	 * - `context` — the per-call context passed through `stream`/`resume` (typed via `toolContextSchema`)
	 * - `interrupt` — pause the agent for human input
	 */
	handler: (args: ToolHandlerArgs<z.infer<TParams>, TContext>) => Promise<JSONValue>;
}

/**
 * @internal Brand applied by the per-call `tool()` factory. Not forgeable by a plain
 * object literal, so `AgentConfig.tools` only accepts factory-produced tools — which
 * is what forces every tool through the factory (and recovers precise `input` typing).
 */
declare const AGENT_TOOL_BRAND: unique symbol;

/**
 * A tool produced by the `tool()` factory handed to the `tools` callback. This is the
 * only shape the `tools` Record accepts.
 */
export type AgentTool<TContext = DefaultToolContext> = ToolDefinition<TContext, any> & {
	readonly [AGENT_TOOL_BRAND]: true;
};

/**
 * The per-call tool factory passed into the `tools` callback. Generic over each
 * tool's `parameters` so `input` is inferred individually, while `context` is fixed
 * to the Agent's `TContext` (from `toolContextSchema`). Declaring tools through this
 * factory is what makes both `input` and `context` type-safe — a plain object literal
 * cannot produce the branded {@link AgentTool} the Record requires.
 */
export type ToolFactory<TContext = DefaultToolContext> = <TParams extends z.ZodType>(
	tool: ToolDefinition<TContext, TParams>,
) => AgentTool<TContext>;

/**
 * How tools are declared on an Agent: a callback that receives the `tool()` factory
 * and returns a Record keyed by tool name.
 *
 * The callback form is what lets TypeScript infer each tool's `input` from its
 * `parameters` (a plain inline array/object collapses `input` to `any`), without
 * making the customer import a separate helper. The Record key is the tool's name.
 *
 * @example
 * ```typescript
 * new Agent(scope, 'support', {
 *   systemPrompt: '...',
 *   tools: (tool) => ({
 *     getOrderStatus: tool({
 *       description: 'Look up an order',
 *       parameters: z.object({ orderId: z.string() }),
 *       handler: async ({ input }) => db.getOrder(input.orderId), // input.orderId: string
 *     }),
 *   }),
 * });
 * ```
 */
export type ToolsConfig<TContext = DefaultToolContext> = (
	tool: ToolFactory<TContext>,
) => Record<string, AgentTool<TContext>>;

export interface AgentResult {
	text: string;
	toolCalls: ToolCallRecord[];
	usage?: TokenUsage;
}

export interface TokenUsage {
	inputTokens: number;
	outputTokens: number;
	totalTokens: number;
}

export interface ToolCallRecord {
	toolUseId: string;
	toolName: string;
	input: JSONValue;
	output: JSONValue;
	error?: string;
}

export interface StreamOptions<TContext = DefaultToolContext> {
	conversationId?: string;
	/** Channel ID for Realtime delivery. Defaults to conversationId or a random UUID. Empty strings are treated as unset. */
	channelId?: string;
	/** User ID for conversation scoping. Defaults to 'anonymous'. */
	userId?: string;
	/**
	 * Per-call context forwarded to every tool invocation as `context`. Use it to pass
	 * request-scoped data (e.g. `userId`, tenant, auth claims) into tools.
	 *
	 * Required when the Agent declares a `toolContextSchema`; validated against it at call time.
	 */
	context?: TContext;
}

/**
 * Returned by stream(). Provides the channelId and server-side convenience methods.
 *
 * Safe to return directly from API methods — `toJSON()` serializes to
 * `{ channelId, channel: null }`. Only `channelId` is meaningful client-side;
 * `channel` is explicitly `null` to signal the live handle is server-side only,
 * and the `complete()` helper is dropped (functions don't serialize).
 */
export interface AgentStreamResult {
	/** Realtime channel ID where chunks are published. */
	channelId: string;
	/**
	 * Realtime channel handle (server-side only). Nulled by `toJSON()` — clients subscribe from `channelId` instead.
	 *
	 * @remarks
	 * Unlike `RealtimeChannel.toJSON()` which produces a hydratable descriptor, this is nulled
	 * because it's a `Promise` that can't round-trip. Clients reconstruct a subscribe-only
	 * channel from `channelId` via the `useChat` `subscribe` callback.
	 */
	channel: Promise<RealtimeChannel<AgentStreamChunk>>;
	/** Wait for the complete response (server-side). Resolves when the done chunk arrives. */
	complete: () => Promise<AgentStreamChunk>;
	/** Only `{ channelId, channel: null }` is serialized when this object crosses the RPC boundary. */
	toJSON(): { channelId: string; channel: null };
}

export interface AgentStreamChunk {
	type: 'text-delta' | 'tool-call' | 'tool-result' | 'done' | 'error' | 'interrupt';
	text?: string;
	toolName?: string;
	input?: JSONValue;
	usage?: TokenUsage;
	error?: string;
	interrupts?: Array<{ id: string; name: string; reason?: any }>;
}


export interface MessageMetadata {
	toolName?: string;
	toolInput?: string;
	toolOutput?: string;
	usage?: TokenUsage;
	latencyMs?: number;
	error?: string;
}

export interface Message {
	messageId: string;
	role: 'user' | 'assistant' | 'tool-call' | 'tool-result' | 'approval' | 'interrupt';
	content: string;
	contentType: 'text' | 'image' | 'audio' | 'video' | 'document';
	createdAt: number;
	metadata: MessageMetadata;
}

export interface Conversation {
	conversationId: string;
	name: string;
	createdAt: number;
	updatedAt: number;
}
