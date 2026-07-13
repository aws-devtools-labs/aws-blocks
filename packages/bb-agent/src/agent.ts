// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { DistributedTable } from '@aws-blocks/bb-distributed-table';
import { FileBucket } from '@aws-blocks/bb-file-bucket';
import type { ChildLogger } from '@aws-blocks/bb-logger';
import { Logger } from '@aws-blocks/bb-logger';
import type { ScopeParent } from '@aws-blocks/core';
import { getSdkIdentifiers, registerSdkIdentifiers, Scope } from '@aws-blocks/core';
import type { AgentResult, SnapshotStorage } from '@strands-agents/sdk';
import {
	AfterToolCallEvent,
	AgentResultEvent,
	BeforeToolCallEvent,
	InterruptEvent,
	InterruptResponseContent,
	ModelStreamUpdateEvent,
	SessionManager,
	SlidingWindowConversationManager,
	Agent as StrandsAgent,
	SummarizingConversationManager,
	tool,
} from '@strands-agents/sdk';
import { ulid } from 'ulid';
import type { z } from 'zod';
import { AgentErrors, blocksAgentError, InterruptError } from './errors.js';
import { checkModelHealth, createStrandsModel } from './model-factory.js';
import { conversationSchema, messageSchema } from './schemas.js';
import type {
	AgentConfig,
	AgentCoreStreamResult,
	AgentStreamChunk,
	AgentStreamResult,
	AgentTool,
	Conversation,
	ConversationManagerConfig,
	DefaultToolContext,
	InterruptResponse,
	JSONValue,
	Message,
	ModelConfig,
	StreamOptions,
	TokenUsage,
	ToolDefinition,
} from './types.js';
import { BB_NAME, BB_VERSION } from './version.js';

/** Key under which the per-call tool context is threaded through Strands `invocationState`. */
const TOOL_CONTEXT_KEY = '__bbAgentToolContext';

/**
 * Registry of live Agent instances keyed by `fullId`. Populated by the AgentBase
 * constructor. The AgentCore entrypoint (agentcore-entry.ts) imports the developer's
 * backend module — which constructs the real Agent (tools closure and all) — then looks
 * up the target instance here by the `BB_AGENT_ID` env var the CDK Runtime construct sets.
 * The tool handlers never cross the process boundary as data; the same backend code runs
 * inside the AgentCore process, exactly as it does inside the Lambda handler.
 */
const agentRegistry = new Map<string, AgentBase<any>>();

/** Register a live Agent instance so the AgentCore entrypoint can find it by fullId. */
export function registerAgentInstance(fullId: string, agent: AgentBase<any>): void {
	agentRegistry.set(fullId, agent);
}

/** Look up a registered Agent instance by fullId (used by the AgentCore entrypoint). */
export function getAgentInstance(fullId: string): AgentBase<any> | undefined {
	return agentRegistry.get(fullId);
}

/**
 * The per-call tool factory handed to the `tools` callback. At runtime it's an identity
 * function whose only job is to give TypeScript a single call site per tool where it can
 * infer `TParams` (hence `input`) and apply the unforgeable brand. See `ToolFactory`.
 */
const makeTool = <TContext>(tool: ToolDefinition<TContext, any>): AgentTool<TContext> => tool as AgentTool<TContext>;

/**
 * Resolve the developer's `tools` callback into a name→tool map.
 * The Record key is the canonical tool name (overrides any `name` on the definition).
 */
function resolveTools<TContext>(toolsConfig: AgentConfig<TContext>['tools']): Map<string, AgentTool<TContext>> {
	const map = new Map<string, AgentTool<TContext>>();
	if (!toolsConfig) return map;
	const record = toolsConfig(makeTool as never);
	for (const [name, def] of Object.entries(record)) {
		// Record key is the source of truth for the tool name.
		map.set(name, { ...def, name } as AgentTool<TContext>);
	}
	return map;
}

/**
 * Maps ConversationManagerConfig to Strands' ConversationManager.
 * Controls how message history is trimmed in-memory before sending to the model. Does not handle persistence.
 * @see https://strandsagents.com/docs/user-guide/concepts/agents/conversation-management/
 */
function createConversationManager(config?: ConversationManagerConfig) {
	if (!config || !config.strategy || config.strategy === 'sliding-window') {
		const windowSize = config && 'windowSize' in config ? config.windowSize : undefined;
		return new SlidingWindowConversationManager({ windowSize });
	}
	if (config.strategy === 'summarizing') {
		return new SummarizingConversationManager({
			summaryRatio: config.summaryRatio,
			preserveRecentMessages: config.preserveRecentMessages,
		});
	}
}

/**
 * Base class for the Agent BB. Extended by agent.mock.ts (model.local) and agent.aws.ts (model.deployed).
 *
 * Transport-agnostic: the base owns the Strands loop (`streamAgent`/`streamSSE`), model,
 * session manager, persistence, and conversation CRUD. It does NOT own a streaming transport
 * — chunks are consumed by the AgentCore Runtime entrypoint (agentcore-entry.ts) on AWS and by
 * the dev-server SSE route (dev-stream.ts) locally.
 *
 * Creates internal BBs depending on mode:
 * - FileBucket: session snapshot storage for Strands SessionManager (always)
 * - DistributedTable: conversation + message history (when inferenceOnly = false)
 */
export class AgentBase<TContext = DefaultToolContext> extends Scope {
	/** Developer-facing agent configuration. */
	protected config: AgentConfig<TContext>;
	/** Tools resolved from the `tools` callback into a name→tool map (name = Record key). */
	private toolMap: Map<string, AgentTool<TContext>>;
	/** Conversation metadata table. */
	private conversations?: DistributedTable<
		z.infer<typeof conversationSchema>,
		{ partitionKey: 'userId'; sortKey: 'conversationId' }
	>;
	/** Message history table. */
	private messages?: DistributedTable<
		z.infer<typeof messageSchema>,
		{ partitionKey: 'conversationId'; sortKey: 'messageId' }
	>;
	/** Which model provider to use. */
	private modelConfig: ModelConfig | ModelConfig[] | undefined;
	/** Where to persist Strands agent state (snapshots). */
	private snapshotStorage: SnapshotStorage;
	/** Internal FileBucket for session storage. */
	private sessionBucket: FileBucket;
	/** @internal Logger for internal operations. Defaults to error-level when not provided. */
	protected log: ChildLogger;

	/**
	 * @param scope - Blocks scope parent (determines resource naming and CDK discovery)
	 * @param id - unique agent ID (used in resource names, keep short for AppSync namespace limits)
	 * @param config - developer-facing agent configuration
	 * @param modelConfig - which model to use, picked by subclass (model.local or model.deployed)
	 * @param createSnapshotStorage - factory that receives the internal FileBucket and returns the appropriate SnapshotStorage
	 */
	constructor(
		scope: ScopeParent,
		id: string,
		config: AgentConfig<TContext>,
		modelConfig: ModelConfig | ModelConfig[] | undefined,
		createSnapshotStorage: (bucket: FileBucket) => SnapshotStorage,
	) {
		super(id, { parent: scope, bbName: BB_NAME, bbVersion: BB_VERSION });
		this.log = config?.logger ?? new Logger(this, 'logger', { level: 'error' });
		this.config = config;
		this.toolMap = resolveTools<TContext>(config.tools);
		this.modelConfig = modelConfig;

		// IDs shortened to keep S3 bucket names within the 63-char limit
		this.sessionBucket = new FileBucket(this, 'sn');
		this.snapshotStorage = createSnapshotStorage(this.sessionBucket);

		if (!config.inferenceOnly) {
			this.conversations = new DistributedTable(this, 'convos', {
				schema: conversationSchema,
				key: { partitionKey: 'userId', sortKey: 'conversationId' },
			});
			this.messages = new DistributedTable(this, 'messages', {
				schema: messageSchema,
				key: { partitionKey: 'conversationId', sortKey: 'messageId' },
			});
		}

		const identifiers: Record<string, string> = {};
		if (this.conversations) {
			identifiers.conversationsTableName = getSdkIdentifiers(this.conversations).tableName;
		}
		if (this.messages) {
			identifiers.messagesTableName = getSdkIdentifiers(this.messages).tableName;
		}
		identifiers.sessionBucketName = getSdkIdentifiers(this.sessionBucket).bucketName;
		registerSdkIdentifiers(this.fullId, identifiers);

		// Register this instance so the streaming transports (AgentCore entrypoint on AWS,
		// dev-server SSE route locally) can find it by fullId and drive its Strands loop.
		registerAgentInstance(this.fullId, this);
	}

	/**
	 * Drives the Strands agent loop and YIELDS stream chunks, persisting messages to
	 * DynamoDB along the way. This is the shared core of the agent loop, transport-agnostic:
	 * it knows nothing about the wire format. `streamSSE()` wraps it for the SSE consumers
	 * (AgentCore entrypoint on AWS, dev-server route locally).
	 *
	 * Persistence (user/tool-call/tool-result/interrupt/assistant messages + conversation
	 * touch) happens here so it is identical regardless of transport.
	 */
	protected async *streamAgent(
		message: string,
		conversationId: string | undefined,
		userId: string,
		interruptResponses?: Array<{ interruptId: string; response: string }>,
		context?: TContext,
	): AsyncGenerator<AgentStreamChunk> {
		const strandsAgent = await this.createStrandsAgent(conversationId, context);
		const startTime = Date.now();

		// Only persist user message on initial path (not resume)
		if (!interruptResponses && conversationId && this.messages) {
			await this.messages.put({
				conversationId,
				messageId: ulid(),
				role: 'user' as const,
				content: message,
				contentType: 'text' as const,
				userId,
				createdAt: Date.now(),
				metadata: '{}',
			});
		}

		let fullText = '';
		let usage: TokenUsage | undefined;
		let blockBuffer = '';
		let interrupted = false;
		const isBlockMode = this.config.streamingMode !== 'token';

		// Determine input: resume with responses or initial message
		const input = interruptResponses
			? interruptResponses.map(
					(r) => new InterruptResponseContent({ interruptId: r.interruptId, response: r.response }),
				)
			: message;

		this.log.info('streamAgent started', { resume: !!interruptResponses, conversationId });
		// Thread the per-call context through Strands invocationState so it reaches
		// tool callbacks and the interrupt hook (see createStrandsAgent).
		const invocationState = { [TOOL_CONTEXT_KEY]: context ?? {} };
		try {
			for await (const event of strandsAgent.stream(input, { invocationState })) {
				if (event instanceof ModelStreamUpdateEvent) {
					if (event.event.type === 'modelContentBlockDeltaEvent' && event.event.delta.type === 'textDelta') {
						fullText += event.event.delta.text;
						if (isBlockMode) {
							blockBuffer += event.event.delta.text;
						} else {
							yield { type: 'text-delta', text: event.event.delta.text };
						}
					} else if (isBlockMode && event.event.type === 'modelContentBlockStopEvent' && blockBuffer) {
						yield { type: 'text-delta', text: blockBuffer };
						blockBuffer = '';
					}
				} else if (event instanceof BeforeToolCallEvent) {
					yield { type: 'tool-call', toolName: event.toolUse.name, input: event.toolUse.input };
					if (conversationId && this.messages) {
						await this.messages.put({
							conversationId,
							messageId: ulid(),
							role: 'tool-call' as const,
							content: '',
							contentType: 'text' as const,
							userId,
							createdAt: Date.now(),
							metadata: JSON.stringify({ toolName: event.toolUse.name, toolInput: event.toolUse.input }),
						});
					}
				} else if (event instanceof AfterToolCallEvent) {
					yield { type: 'tool-result', toolName: event.toolUse.name };
					if (conversationId && this.messages) {
						await this.messages.put({
							conversationId,
							messageId: ulid(),
							role: 'tool-result' as const,
							content: '',
							contentType: 'text' as const,
							userId,
							createdAt: Date.now(),
							metadata: JSON.stringify({
								toolName: event.toolUse.name,
								toolOutput: event.result?.content,
							}),
						});
					}
				} else if (event instanceof AgentResultEvent) {
					const u = event.result.metrics?.toJSON()?.accumulatedUsage;
					if (u)
						usage = {
							inputTokens: u.inputTokens,
							outputTokens: u.outputTokens,
							totalTokens: u.totalTokens,
						};
					// Check if agent was interrupted
					if (event.result.stopReason === 'interrupt' && event.result.interrupts?.length) {
						interrupted = true;
						// Flush partial block buffer before the interrupt chunk
						if (blockBuffer) {
							yield { type: 'text-delta', text: blockBuffer };
							blockBuffer = '';
						}
						// Yield interrupt chunk with pending approvals
						const pendingInterrupts = event.result.interrupts.map((i) => ({
							id: i.id,
							name: i.name,
							reason: i.reason,
						}));
						yield { type: 'interrupt', interrupts: pendingInterrupts };
						// Persist interrupt to DynamoDB for reload/audit
						if (conversationId && this.messages) {
							await this.messages.put({
								conversationId,
								messageId: ulid(),
								role: 'interrupt' as const,
								content: '',
								contentType: 'text' as const,
								userId,
								createdAt: Date.now(),
								metadata: JSON.stringify({ interrupts: pendingInterrupts }),
							});
						}
					}
				}
			}
		} catch (err) {
			// Flush partial block buffer so the consumer gets whatever text was generated before the error
			if (blockBuffer) {
				yield { type: 'text-delta', text: blockBuffer };
				blockBuffer = '';
			}
			// Yield a terminal error chunk (rather than re-throwing) so ALL consumers — the SSE
			// transports and a direct `for await`/`collect` — see a uniform error frame. Best-effort
			// persist the error to history, mirroring the old AsyncJob handler.
			const errorMessage = err instanceof Error ? err.message : String(err);
			this.log.error('streamAgent error', { error: errorMessage });
			if (conversationId && this.messages) {
				try {
					await this.messages.put({
						conversationId,
						messageId: ulid(),
						role: 'assistant' as const,
						content: '',
						contentType: 'text' as const,
						userId,
						createdAt: Date.now(),
						metadata: JSON.stringify({ error: errorMessage }),
					});
				} catch (persistErr) {
					this.log.error('Failed to persist error to history', { error: persistErr });
				}
			}
			yield { type: 'error', error: errorMessage };
			return;
		}
		// Normal flush (stream completed successfully)
		if (blockBuffer) {
			yield { type: 'text-delta', text: blockBuffer };
		}

		const latencyMs = Date.now() - startTime;
		this.log.info('streamAgent done', { textLength: fullText.length, latencyMs, interrupted });

		// If interrupted, don't persist final message or yield done — agent is paused
		if (interrupted) return;

		if (conversationId && this.messages) {
			await this.messages.put({
				conversationId,
				messageId: ulid(),
				role: 'assistant' as const,
				content: fullText,
				contentType: 'text' as const,
				userId,
				createdAt: Date.now(),
				metadata: JSON.stringify({ usage, latencyMs }),
			});
		}

		// TODO: use partial update when DistributedTable supports it (DynamoDB UpdateItem)
		if (conversationId && this.conversations) {
			const existing = await this.conversations.get({ userId, conversationId });
			if (existing) {
				await this.conversations.put({ ...existing, updatedAt: Date.now() });
			}
		}

		yield { type: 'done', text: fullText, usage };
	}

	/**
	 * Executes the Strands agent and YIELDS chunks directly (SSE path).
	 *
	 * Called by the AgentCore Runtime entrypoint (agentcore-entry.ts) on AWS and by the
	 * dev-server SSE route (dev-stream.ts) locally. Thin wrapper over the shared streamAgent()
	 * generator that validates the caller inputs (userId/context) before streaming.
	 *
	 * @param message - the user prompt (empty string on resume)
	 * @param options.conversationId - maps to the AgentCore runtimeSessionId (session state key)
	 * @param options.userId - defaults to 'anonymous' when persistence is disabled
	 * @param options.interruptResponses - HITL approval responses (resume path)
	 * @param options.context - per-call tool context, validated against toolContextSchema
	 */
	async *streamSSE(
		message: string,
		options?: {
			conversationId?: string;
			userId?: string;
			interruptResponses?: Array<{ interruptId: string; response: string }>;
			context?: TContext;
		},
	): AsyncGenerator<AgentStreamChunk> {
		if (!options?.userId && !this.config.inferenceOnly)
			throw blocksAgentError(
				AgentErrors.PersistenceRequired,
				'userId is required when persistence is enabled. Pass it via options.userId.',
			);
		const userId = options?.userId ?? 'anonymous';
		const context = this.resolveContext(options?.context);

		// On the resume path, persist each approval decision to history BEFORE streaming so
		// getPendingInterrupts() can tell which interrupts have been answered. (Previously the
		// AsyncJob-backed resume() did this; that path is gone.)
		if (options?.interruptResponses?.length && options.conversationId && this.messages) {
			for (const r of options.interruptResponses) {
				await this.messages.put({
					conversationId: options.conversationId,
					messageId: ulid(),
					role: 'approval' as const,
					content: String(r.response),
					contentType: 'text' as const,
					userId,
					createdAt: Date.now(),
					metadata: JSON.stringify({ interruptId: r.interruptId, response: r.response }),
				});
			}
		}

		yield* this.streamAgent(message, options?.conversationId, userId, options?.interruptResponses, context);
	}

	/**
	 * Wrap a `streamSSE()` generator as an {@link AgentStreamResult}: an async-iterable that
	 * also exposes `complete()`. Shared by the deprecated `stream()`/`resume()` wrappers.
	 */
	private toStreamResult(gen: AsyncGenerator<AgentStreamChunk>): AgentStreamResult {
		return {
			[Symbol.asyncIterator]: () => gen,
			async complete(): Promise<AgentStreamChunk> {
				let last: AgentStreamChunk | undefined;
				for await (const chunk of gen) {
					last = chunk;
					if (chunk.type === 'error') {
						throw blocksAgentError(AgentErrors.StreamFailed, chunk.error ?? 'Agent error');
					}
					if (chunk.type === 'interrupt') {
						throw new InterruptError('Agent requires approval to continue', chunk.interrupts ?? []);
					}
					if (chunk.type === 'done') return chunk;
				}
				return last ?? { type: 'done', text: '' };
			},
		};
	}

	/**
	 * @deprecated Use {@link streamSSE} (or, on AWS, stream directly from the AgentCore endpoint).
	 *
	 * Compatibility wrapper preserved so existing callers keep working after the Realtime/AsyncJob
	 * removal. Runs the agent and returns an async-iterable result with a `complete()` helper.
	 * The former Realtime `channel`/`channelId` surface is gone — iterate the result or call
	 * `complete()` instead.
	 */
	stream(message: string, options?: StreamOptions<TContext>): AgentStreamResult {
		return this.toStreamResult(this.streamSSE(message, options));
	}

	/**
	 * @deprecated Use {@link streamSSE} with `interruptResponses` instead.
	 *
	 * Compatibility wrapper for resuming an interrupted agent. Translates the approval
	 * decisions and drives `streamSSE()`. The old leading `channelId` argument is gone
	 * (channels no longer exist); pass `conversationId` via `options`.
	 */
	resume(responses: Array<InterruptResponse>, options?: StreamOptions<TContext>): AgentStreamResult {
		if (!responses.length)
			throw blocksAgentError(AgentErrors.InterruptRequired, 'resume() requires at least one interrupt response.');
		const interruptResponses = responses.map((r) => ({
			interruptId: r.interruptId,
			response: r.response != null ? String(r.response) : r.approved ? (r.trust ? 'trust' : 'yes') : 'no',
		}));
		return this.toStreamResult(this.streamSSE('', { ...options, interruptResponses }));
	}

	private async createStrandsAgent(conversationId?: string, fallbackContext?: TContext): Promise<StrandsAgent> {
		const toolDefs = [...this.toolMap.values()];
		// Validate mutual exclusivity of needsApproval/trustable and interrupt
		for (const t of toolDefs) {
			if ((t.needsApproval !== undefined || t.trustable !== undefined) && t.interrupt) {
				throw blocksAgentError(
					AgentErrors.InvalidModelConfig,
					`Cannot specify 'needsApproval' or 'trustable' alongside 'interrupt' on tool '${t.name}'. Use 'interrupt' for custom logic, or 'needsApproval'/'trustable' for simple approval.`,
				);
			}
		}

		// Reads the per-call context threaded through invocationState, falling back to the
		// context captured at runAgent time (defensive — Strands always provides invocationState).
		const readContext = (strandsCtx: { invocationState?: Record<string, unknown> } | undefined): TContext =>
			(strandsCtx?.invocationState?.[TOOL_CONTEXT_KEY] as TContext) ?? fallbackContext ?? ({} as TContext);

		const strandsTools = toolDefs.map((t) =>
			tool({
				// `name` is always set by resolveTools() from the Record key.
				name: t.name!,
				description: t.description,
				inputSchema: t.parameters,
				callback: (input, context) =>
					t.handler({
						input,
						context: readContext(context),
						interrupt: (params) => context!.interrupt(params),
					}),
			}),
		);

		const configs = Array.isArray(this.modelConfig) ? this.modelConfig : this.modelConfig ? [this.modelConfig] : [];
		let resolvedConfig: ModelConfig | undefined;
		for (const config of configs) {
			if (await checkModelHealth(config, this.log)) {
				resolvedConfig = config;
				break;
			}
		}
		if (!resolvedConfig && configs.length > 0) {
			const tried = configs.map((c) => `${c.provider}${c.modelId ? ` (${c.modelId})` : ''}`).join(', ');
			throw blocksAgentError(
				AgentErrors.ModelUnavailable,
				`No model available. Tried: ${tried}. Check logs for details.`,
			);
		}
		const model = await createStrandsModel(resolvedConfig, this.log);

		// SessionManager restores/saves agent state across invocations.
		// undefined when no conversationId (inference-only calls — no state to persist).
		const sessionManager = conversationId
			? new SessionManager({ sessionId: conversationId, storage: { snapshot: this.snapshotStorage } })
			: undefined;

		const agent = new StrandsAgent({
			model,
			// Forward the optional agent identity from AgentConfig. Strands' Agent
			// supports name/description (e.g. for multi-agent routing and tracing);
			// previously these AgentConfig fields were accepted but never passed
			// through, so they silently had no effect. Spread conditionally so we
			// don't override Strands defaults with `undefined` when unset.
			...(this.config.name !== undefined && { name: this.config.name }),
			...(this.config.description !== undefined && { description: this.config.description }),
			systemPrompt: this.config.systemPrompt,
			tools: strandsTools,
			conversationManager: createConversationManager(this.config.conversation),
			sessionManager,
			printer: false, //disable Strands automatic printing
		});

		// Register interrupt hook for HITL — checks needsApproval or custom interrupt function before execution
		const toolConfigs = this.toolMap;
		agent.addHook(BeforeToolCallEvent, (event) => {
			const toolDef = toolConfigs.get(event.toolUse.name);
			if (!toolDef) return;

			// Custom interrupt function — developer has full control
			if (toolDef.interrupt) {
				toolDef.interrupt({
					input: event.toolUse.input,
					context: readContext(event),
					interrupt: (params) => event.interrupt(params),
				});
				return;
			}

			// Built-in approval check
			const needsApproval = toolDef.needsApproval ?? false;
			if (!needsApproval) return;
			if (toolDef.trustable && event.agent.appState.get(`trusted:${event.toolUse.name}`)) return;

			this.log.info('Tool approval required, interrupting', {
				tool: event.toolUse.name,
				trustable: !!toolDef.trustable,
			});
			const response = event.interrupt({
				name: `approve:${event.toolUse.name}:${event.toolUse.toolUseId}`,
				reason: { tool: event.toolUse.name, input: event.toolUse.input, trustable: !!toolDef.trustable },
			});

			if (response === 'trust') {
				event.agent.appState.set(`trusted:${event.toolUse.name}`, true);
				this.log.info('Tool trusted for session', { tool: event.toolUse.name });
			} else if (response !== 'yes') {
				event.cancel = `User denied permission to run ${event.toolUse.name}`;
				this.log.info('Tool denied by user', { tool: event.toolUse.name });
			}
		});

		return agent;
	}

	/**
	 * Validates the per-call tool context against `toolContextSchema` (when set) and returns it.
	 * Throws InvalidModelConfig when the schema is declared but the context is missing or invalid.
	 */
	protected resolveContext(context?: TContext): TContext | undefined {
		const schema = this.config.toolContextSchema;
		if (!schema) return context;
		const result = schema.safeParse(context);
		if (!result.success) {
			throw blocksAgentError(
				AgentErrors.InvalidModelConfig,
				`Invalid tool context: ${result.error.message}. This agent declares a 'toolContextSchema', so a matching 'context' must be passed to stream()/resume().`,
			);
		}
		return result.data;
	}

	/** Generate a new conversation ID and create the conversation record. */
	async createConversationId(userId: string): Promise<string> {
		if (!this.conversations)
			throw blocksAgentError(
				AgentErrors.PersistenceRequired,
				'createConversationId() requires persistence. Set inferenceOnly: false (default).',
			);
		const conversationId = crypto.randomUUID();
		const now = Date.now();
		await this.conversations.put({ userId, conversationId, name: conversationId, createdAt: now, updatedAt: now });
		return conversationId;
	}

	/** Check if a conversation has pending (unanswered) interrupts by checking DynamoDB history.
	 *
	 * ⚠️ Does NOT verify ownership — it reads by conversationId alone. The caller must
	 * authorize the request (e.g. confirm the conversation belongs to the authenticated
	 * user via listConversations(userId)) before exposing the result. See the
	 * "Authorization (caller responsibility)" section in the README.
	 *
	 * TODO: optimize — query in reverse with limit instead of loading all messages.
	 */
	async getPendingInterrupts(conversationId: string): Promise<Array<{ id: string; name: string; reason?: any }>> {
		if (!this.messages) return [];
		// Single pass in reverse: collect approval IDs until we hit the interrupt
		const approvedIds = new Set<string>();
		let lastInterrupt: any = null;
		for await (const msg of this.messages.query({
			where: { conversationId: { equals: conversationId } },
			order: 'desc',
		})) {
			if (msg.role === 'approval') {
				approvedIds.add(JSON.parse(msg.metadata).interruptId);
			} else if (msg.role === 'interrupt') {
				lastInterrupt = msg;
				break;
			} else if (msg.role === 'assistant') {
				return [];
			}
		}
		if (!lastInterrupt) return [];
		const interrupts: Array<{ id: string; name: string; reason?: any }> = JSON.parse(
			lastInterrupt.metadata,
		).interrupts;
		return interrupts.filter((i) => !approvedIds.has(i.id));
	}

	/** List all conversations for a user. */
	async listConversations(userId: string): Promise<Conversation[]> {
		if (!this.conversations)
			throw blocksAgentError(
				AgentErrors.PersistenceRequired,
				'listConversations() requires persistence. Set inferenceOnly: false (default).',
			);
		const result: Conversation[] = [];
		for await (const item of this.conversations.query({ where: { userId: { equals: userId } } })) {
			result.push({
				conversationId: item.conversationId,
				name: item.name,
				createdAt: item.createdAt,
				updatedAt: item.updatedAt,
			});
		}
		return result.sort((a, b) => b.updatedAt - a.updatedAt);
	}

	/** Get messages in a conversation (for frontend display).
	 * Returns the most recent messages when `limit` is specified.
	 *
	 * ⚠️ Does NOT verify ownership — it reads by conversationId alone. The caller must
	 * authorize the request (e.g. confirm the conversation belongs to the authenticated
	 * user via listConversations(userId)) before returning messages. See the
	 * "Authorization (caller responsibility)" section in the README.
	 *
	 * @param options.limit - Maximum number of (most recent) messages to return.
	 *   A `limit` of `0` returns an empty array, and any negative value is treated
	 *   the same as `0` (returns no messages). Omit `limit` to return all messages.
	 * TODO: support pagination
	 */
	async getConversation(id: string, options?: { limit?: number }): Promise<Message[]> {
		if (!this.messages)
			throw blocksAgentError(
				AgentErrors.PersistenceRequired,
				'getConversation() requires persistence. Set inferenceOnly: false (default).',
			);
		// A limit of 0 means "zero messages", and a negative limit is nonsensical
		// for a message count. The previous `options?.limit && ...` guard treated 0
		// (and never reached the negative case usefully) as falsy, so the cap was
		// ignored and ALL messages were returned. Treat any limit <= 0 as "return no
		// messages" so neither 0 nor a negative value is silently read as "no limit".
		if (options?.limit !== undefined && options.limit <= 0) return [];
		const result: Message[] = [];
		for await (const item of this.messages.query({ where: { conversationId: { equals: id } }, order: 'desc' })) {
			result.push({
				messageId: item.messageId,
				role: item.role,
				content: item.content,
				contentType: item.contentType,
				createdAt: item.createdAt,
				metadata: JSON.parse(item.metadata),
			});
			// Explicit undefined check so a valid positive limit caps results; 0 and
			// negatives are already handled above.
			if (options?.limit !== undefined && result.length >= options.limit) break;
		}
		return result.reverse();
	}

	/** Delete a conversation and its agent state. */
	async deleteConversation(id: string, userId: string): Promise<void> {
		if (!this.messages || !this.conversations)
			throw blocksAgentError(
				AgentErrors.PersistenceRequired,
				'deleteConversation() requires persistence. Set inferenceOnly: false (default).',
			);
		// Verify ownership before any destructive work. The messages table is
		// partitioned by conversationId (not userId) and snapshot storage is keyed
		// by sessionId alone, so deleting them is NOT user-scoped on its own. The
		// conversation record IS keyed by { userId, conversationId }, so its absence
		// means the caller is not the owner (or the conversation doesn't exist).
		// Without this guard, a non-owner could wipe another user's message history
		// and session state while the owner's conversation record (a no-op keyed
		// delete) survived. Bail out unless the caller owns the conversation.
		const owned = await this.conversations.get({ userId, conversationId: id });
		if (!owned) return;
		// Delete conversation record first — if it fails mid-way, orphaned messages are invisible (better than broken conversation with missing messages)
		await this.conversations.delete({ userId, conversationId: id });
		// Delete all messages in batch
		const toDelete: { conversationId: string; messageId: string }[] = [];
		for await (const item of this.messages.query({ where: { conversationId: { equals: id } } })) {
			toDelete.push({ conversationId: item.conversationId, messageId: item.messageId });
		}
		if (toDelete.length > 0) await this.messages.deleteBatch(toDelete);
		// Delete agent session data
		await this.snapshotStorage.deleteSession({ sessionId: id });
	}

	/**
	 * Return the AgentCore Runtime endpoint the browser should open a WebSocket to for direct
	 * streaming. AWS-only: only meaningful once the agent runs on a deployed AgentCore Runtime,
	 * so the AWS runtime (`agent.aws.ts`) overrides this. The base/mock throws — locally there is
	 * no runtime to connect to; use the dev-server SSE route (registerDevAttachment) instead.
	 */
	async getStreamEndpoint(_options?: { conversationId?: string }): Promise<AgentCoreStreamResult> {
		throw blocksAgentError(
			AgentErrors.StreamFailed,
			'getStreamEndpoint() is only available on the deployed (AWS) Agent runtime. Locally, stream via the dev-server route instead.',
		);
	}
}
