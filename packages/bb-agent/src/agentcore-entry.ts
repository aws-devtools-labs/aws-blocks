// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * AgentCore Runtime entrypoint for the Agent BB.
 *
 * This is the AgentCore-native replacement for the Lambda + SQS + AppSync/Realtime
 * side-channel. It hosts the developer's real Agent — the same instance the Lambda
 * handler would build — on the `BedrockAgentCoreApp` harness (Fastify, implements the
 * `/invocations` + `/ping` + SSE contract on port 8080), and streams chunks directly.
 *
 * Two transports, one agent loop:
 *   - `/invocations` (HTTP + SSE) — request/response streaming; used by the buffered RPC path.
 *   - `/ws` (WebSocket) — the browser-direct path. Browsers can't open the SSE endpoint
 *     cross-origin (no CORS), but WebSocket isn't subject to CORS and its session idle-timeout
 *     resets on every message, so a chat/HITL conversation streams with no API-Gateway 30s cap.
 * Both drive the SAME `agent.streamSSE()` generator and emit the SAME chunk frames.
 *
 * How the developer's agent definition reaches this process:
 *   The `tools` callback in AgentConfig is a JS closure and cannot be serialized across a
 *   process boundary. So instead of shipping data, we ship code: this entrypoint imports
 *   the SAME developer backend module the Lambda handler imports (bundled with
 *   `--conditions=aws-runtime`, so `new Agent()` resolves to the AWS runtime class). That
 *   construction registers the live Agent in the instance registry (see agent.ts); we look
 *   it up by the `BB_AGENT_ID` the CDK Runtime construct set, and drive its Strands loop.
 *
 * Launched by the CodeZip artifact as: ['node', 'agentcore-entry.js'].
 */

import { loadConfigToProcessEnv } from '@aws-blocks/core';
import { BedrockAgentCoreApp } from 'bedrock-agentcore/runtime';
import { z } from 'zod';
import { getAgentInstance } from './agent.js';

/** Request contract — mirrors the Lambda jobPayloadSchema, minus transport-only fields. */
const requestSchema = z.object({
	/** User prompt. Empty on resume (interruptResponses drive the turn instead). */
	prompt: z.string().default(''),
	/**
	 * Owner of the conversation. Required when persistence is enabled (not inferenceOnly).
	 *
	 * This is a FALLBACK. When the runtime uses a JWT authorizer and forwards the caller's token
	 * (CDK sets `requestHeaderConfiguration: { allowlistedHeaders: ['Authorization'] }`), the
	 * server prefers the token's `sub` claim over this value — see `userIdFromContext`. The
	 * client-supplied `userId` is used only when no token reaches the container: IAM/SigV4
	 * runtimes (no caller JWT), or if header forwarding isn't available on a given path.
	 */
	userId: z.string().optional(),
	/** HITL resume: approval responses to apply instead of a new prompt. */
	interruptResponses: z.array(z.object({ interruptId: z.string(), response: z.string() })).optional(),
	/** Per-call tool context, threaded through to tool handlers. Must be JSON-serializable. */
	context: z.unknown().optional(),
});

/**
 * Derive the conversation owner from the request's validated JWT, if one was forwarded.
 *
 * When the runtime has a JWT authorizer AND `requestHeaderConfiguration` allowlists
 * `Authorization`, AgentCore forwards the gateway-validated caller token to the container as an
 * `Authorization` header (the SDK surfaces it on `context.headers`). Because the gateway already
 * validated the signature, we trust the payload and read `sub` without re-verifying — giving a
 * userId the client cannot forge. Returns `undefined` when no bearer token is present (IAM
 * runtimes, or a path where the header wasn't forwarded), so the caller can fall back to the
 * client-supplied `userId`.
 */
export function userIdFromContext(headers: Record<string, string> | undefined): string | undefined {
	const auth = headers?.Authorization ?? headers?.authorization;
	const token = auth?.replace(/^Bearer\s+/i, '');
	const payload = token?.split('.')[1];
	if (!payload) return undefined;
	try {
		const claims = JSON.parse(Buffer.from(payload, 'base64url').toString()) as { sub?: string };
		return typeof claims.sub === 'string' ? claims.sub : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Serve a registered Agent on the AgentCore harness.
 *
 * The developer's backend must already have been imported in THIS process (so the Agent
 * registered itself in the shared registry) — either by `main()` below (standalone launch
 * via `BB_AGENT_BACKEND_MODULE`) or by an app-level bundle that imports the backend and
 * this `serve` from the same bb-agent module instance (co-bundled). Co-bundling is required
 * whenever the backend and this entrypoint would otherwise resolve to different bb-agent
 * copies — the registry is a module singleton, so a split would put the Agent in one map
 * and the lookup in another.
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
			process: async function* (request, context) {
				// AgentCore routes every invocation for a session to the same warm microVM.
				// runtimeSessionId maps to the Agent BB's conversationId (session state key).
				// Prefer the gateway-validated JWT's `sub` (unforgeable); fall back to the payload.
				const jwtUserId = userIdFromContext(context.headers);
				for await (const chunk of agent.streamSSE(request.prompt, {
					conversationId: context.sessionId,
					userId: jwtUserId ?? request.userId,
					interruptResponses: request.interruptResponses,
					context: request.context,
				})) {
					// The chunk's `type` is the SSE event name; the rest is the data payload.
					const { type, ...data } = chunk;
					yield { event: type, data };
				}
			},
		},
		// Browser-direct transport. The browser opens `wss://.../ws` (JWT via the
		// Sec-WebSocket-Protocol subprotocol — see ws-transport client helper) and sends one
		// JSON message per turn with the same payload shape as `/invocations`. We drive the
		// same streamSSE() loop and send each chunk back as a JSON WS message, then close.
		websocketHandler: async (socket, context) => {
			// Prefer the gateway-validated JWT's `sub` (unforgeable) over the client payload.
			// On the WS path the token arrives via the Sec-WebSocket-Protocol subprotocol; whether
			// AgentCore forwards it as an Authorization header here is confirmed at deploy time —
			// if absent, jwtUserId is undefined and we fall back to request.userId.
			const jwtUserId = userIdFromContext(context.headers);
			socket.on('message', async (raw: unknown) => {
				try {
					const request = requestSchema.parse(JSON.parse(String(raw)));
					for await (const chunk of agent.streamSSE(request.prompt, {
						conversationId: context.sessionId,
						userId: jwtUserId ?? request.userId,
						interruptResponses: request.interruptResponses,
						context: request.context,
					})) {
						const { type, ...data } = chunk;
						socket.send(JSON.stringify({ event: type, data }));
					}
					// Signal end-of-turn so the client's async iterator completes. The socket
					// stays open for follow-up turns / HITL resume on the same session.
					socket.send(JSON.stringify({ event: 'turn-complete', data: {} }));
				} catch (err) {
					const error = err instanceof Error ? err.message : String(err);
					socket.send(JSON.stringify({ event: 'error', data: { error } }));
				}
			});
		},
	});

	app.run();
}

/**
 * Standalone launch: load config, import the developer backend by path, then serve.
 * Used when the artifact runs this file directly (entrypoint ['node','agentcore-entry.js'])
 * with BB_AGENT_BACKEND_MODULE pointing at the backend. When an app co-bundles the backend
 * with `serve`, it calls `serve()` directly instead and this `main()` is not the entry.
 */
export async function main(): Promise<void> {
	// Same cold-start contract as the Lambda handler: pull BB resource identifiers
	// (table names, bucket names, runtime ARNs) into process.env before importing the
	// backend, so BB constructors can resolve them.
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
// not fire there (it would double-serve and throw on the missing env var). Gating on the
// env var is more robust than an `import.meta.url === argv[1]` check, which is unreliable
// once this module is inlined into a bundle under the CJS `import.meta.url` shim.
if (process.env.BB_AGENT_BACKEND_MODULE) {
	void main();
}
