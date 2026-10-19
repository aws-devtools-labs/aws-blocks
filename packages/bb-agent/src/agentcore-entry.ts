// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * AgentCore Runtime entrypoint for the Agent BB.
 *
 * Hosts the developer's real Agent — the same instance the Lambda handler would build — on
 * the `BedrockAgentCoreApp` harness (implements the `/invocations` + `/ping` contract on port
 * 8080), and runs the agent loop as a **background async task** that streams chunks to the
 * browser over the Realtime BB (exactly as the loop does on Lambda today).
 *
 * Why background + Realtime (not the harness's SSE response): the browser never holds a
 * connection to AgentCore — it subscribes to a Realtime channel by `channelId`. So the
 * invocation must return immediately while the loop keeps running server-side. The harness
 * keeps the microVM alive (up to the 8h session lifetime) while an async task is in flight —
 * `/ping` reports `HealthyBusy` — via `addAsyncTask()`/`completeAsyncTask()`. `runAgent()`
 * publishes every chunk to Realtime under the runtime's execution role.
 *
 * How the developer's agent definition reaches this process:
 *   The `tools` callback in AgentConfig is a JS closure and can't be serialized across a
 *   process boundary. So instead of shipping data, we ship code: this entrypoint imports
 *   the SAME developer backend module the Lambda handler imports (co-bundled with
 *   `--conditions=aws-runtime`, so `new Agent()` resolves to the AWS runtime class). That
 *   construction registers the live Agent in the instance registry (see agent.ts); we look
 *   it up by the `BB_AGENT_ID` the CDK Runtime construct set, and drive its loop.
 *
 * Launched by the CodeZip artifact as: ['main.js'] (the co-bundle from agentcore-bundle.ts).
 */

import { loadConfigToProcessEnv } from '@aws-blocks/core';
import { BedrockAgentCoreApp } from 'bedrock-agentcore/runtime';
import { z } from 'zod';
import { getAgentInstance } from './agent.js';

/** Request contract — mirrors the Lambda jobPayloadSchema, minus transport-only fields. */
const requestSchema = z.object({
	/** User prompt. Empty on resume (interruptResponses drive the turn instead). */
	prompt: z.string().default(''),
	/** Realtime channel the client subscribes to for this turn's chunks. */
	channelId: z.string(),
	/** Conversation to persist to / restore the session from. Falls back to the AgentCore session id. */
	conversationId: z.string().optional(),
	/** Owner of the conversation. Required when persistence is enabled (not inferenceOnly). */
	userId: z.string().optional(),
	/** HITL resume: approval responses to apply instead of a new prompt. */
	interruptResponses: z.array(z.object({ interruptId: z.string(), response: z.string() })).optional(),
	/** Per-call tool context, threaded through to tool handlers. Must be JSON-serializable. */
	context: z.unknown().optional(),
});

/**
 * Serve a registered Agent on the AgentCore harness.
 *
 * The developer's backend must already have been imported in THIS process (so the Agent
 * registered itself in the shared registry) — either by `main()` below (standalone launch
 * via `BB_AGENT_BACKEND_MODULE`) or by the co-bundle (agentcore-bundle.ts) that imports the
 * backend and this `serve` from the same bb-agent module instance. Co-bundling is required
 * because the registry is a module singleton — a split would put the Agent in one map and
 * the lookup in another.
 *
 * @param agentId - fullId of the target Agent (defaults to process.env.BB_AGENT_ID)
 */
export function serve(agentId = process.env.BB_AGENT_ID): void {
	if (!agentId) throw new Error('BB_AGENT_ID is required (fullId of the target Agent).');
	const agent = getAgentInstance(agentId);
	if (!agent) {
		throw new Error(
			`No Agent registered with id '${agentId}'. Ensure the backend module constructs it at import time.`,
		);
	}

	const app = new BedrockAgentCoreApp({
		invocationHandler: {
			requestSchema,
			process: (request, context) => {
				// AgentCore routes every invocation for a session to the same warm microVM.
				// runtimeSessionId maps to the Agent BB's conversationId (session state key).
				const conversationId = request.conversationId ?? context.sessionId;

				// Run the turn as a background async task so this invocation returns immediately.
				// The harness reports `/ping` = HealthyBusy while the task is in flight, keeping
				// the microVM alive (up to the 8h session lifetime) until the loop completes.
				// Chunks are delivered out-of-band via Realtime — this HTTP response is just an ack.
				const taskId = app.addAsyncTask('agent-turn');
				void agent
					.invokeTurn({
						message: request.prompt,
						conversationId,
						channelId: request.channelId,
						userId: request.userId ?? 'anonymous',
						interruptResponses: request.interruptResponses,
						context: request.context,
					})
					.finally(() => app.completeAsyncTask(taskId));

				// The client already has channelId (from the RPC that invoked us) and subscribes
				// to Realtime; it does not consume this response body.
				return { channelId: request.channelId, status: 'accepted' };
			},
		},
	});

	app.run();
}

/**
 * Standalone launch: load config, import the developer backend by path, then serve.
 * Used when the artifact runs this file directly with BB_AGENT_BACKEND_MODULE pointing at the
 * backend. When an app co-bundles the backend with `serve` (agentcore-bundle.ts), it calls
 * `serve()` directly instead and this `main()` is not the entry.
 */
export async function main(): Promise<void> {
	// Same cold-start contract as the Lambda handler: pull BB resource identifiers
	// (table names, bucket names, Realtime callback URL) into process.env before importing
	// the backend, so BB constructors can resolve them.
	await loadConfigToProcessEnv();

	const backendModule = process.env.BB_AGENT_BACKEND_MODULE;
	if (!backendModule)
		throw new Error('BB_AGENT_BACKEND_MODULE env var is required (path to the developer backend module).');

	// Import the developer backend — constructing the real Agent, which registers itself.
	await import(backendModule);

	serve();
}

// Auto-run the standalone launch path ONLY when a backend module path is provided.
// The co-bundle path (agentcore-bundle.ts) imports `serve` and invokes it directly after
// importing the backend inline, and does NOT set BB_AGENT_BACKEND_MODULE — so `main()` must
// not fire there (it would double-serve and throw on the missing env var).
if (process.env.BB_AGENT_BACKEND_MODULE) {
	void main();
}
