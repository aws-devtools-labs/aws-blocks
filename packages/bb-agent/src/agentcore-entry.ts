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

import { loadConfigToProcessEnv } from '@aws-cdk-blocks/core';
import { isConfigResolved } from '@aws-cdk-blocks/core/internal';
import { BedrockAgentCoreApp } from 'bedrock-agentcore/runtime';
import { getAgentInstance } from './agent.js';
import {
	backendLoader,
	ConfigNotReadyError,
	handleInvocation,
	type InvocationAck,
	requestSchema,
	type TurnRunner,
} from './agentcore-invocation.js';

function registeredAgent(agentId: string): TurnRunner {
	const agent = getAgentInstance(agentId);
	if (!agent) {
		throw new Error(
			`No Agent registered with id '${agentId}'. Ensure the backend module constructs it at import time.`,
		);
	}
	return agent;
}

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
	const agent = registeredAgent(agentId);

	const app = new BedrockAgentCoreApp({
		invocationHandler: {
			requestSchema,
			process: (request, context): InvocationAck => handleInvocation(agent, app, request, context),
		},
	});

	app.run();
}

/**
 * Load the app config, import the developer's backend, and serve its Agent on the AgentCore
 * harness. This is what the co-bundle (agentcore-bundle.ts) and `main()` run.
 *
 * Same cold-start contract as the Lambda handler: the config (BB resource identifiers, the
 * Realtime callback URL) goes into process.env BEFORE the backend is imported, so BB
 * constructors can resolve it.
 *
 * The config file is uploaded by a deployment that is not ordered before the Runtime, so this
 * process can start before the file is readable. The harness therefore starts at once, and the
 * config + backend load is repeated on each invocation until the config is readable. An
 * invocation that arrives before that fails (the caller's `stream()` rejects) instead of running
 * a turn that has no Realtime callback URL to publish to.
 *
 * `loadBackend` must import the backend into the same bb-agent module instance as this
 * function (see {@link serve} for why).
 *
 * @param loadBackend - imports the developer's backend module, which constructs the Agent
 * @param agentId - fullId of the target Agent (defaults to process.env.BB_AGENT_ID)
 */
export function serveBackend(loadBackend: () => Promise<unknown>, agentId = process.env.BB_AGENT_ID): void {
	if (!agentId) throw new Error('BB_AGENT_ID is required (fullId of the target Agent).');
	const loadAgent = backendLoader({
		loadConfig: loadConfigToProcessEnv,
		// An app without a config location, or with an empty config file, is resolved; only a
		// file that is not readable yet leaves the config unresolved after a load.
		configMissing: () =>
			Boolean(process.env.BLOCKS_CONFIG_BUCKET && process.env.BLOCKS_CONFIG_KEY) && !isConfigResolved(),
		loadBackend: async () => {
			await loadBackend();
			return registeredAgent(agentId);
		},
	});

	const app = new BedrockAgentCoreApp({
		invocationHandler: {
			requestSchema,
			process: async (request, context): Promise<InvocationAck> =>
				handleInvocation(await loadAgent(), app, request, context),
		},
	});

	// Load now so the first invocation does not pay for it. A config that is not readable yet
	// is retried by the invocations; any other failure (a backend that does not import, no
	// registered Agent) is rethrown and stops the process, as it did before the harness started.
	loadAgent().catch((err: unknown) => {
		if (!(err instanceof ConfigNotReadyError)) throw err;
		console.warn(`[Blocks] ${err.message}`);
	});

	app.run();
}

/**
 * Standalone launch: load config, import the developer backend by path, then serve.
 * Used when the artifact runs this file directly with BB_AGENT_BACKEND_MODULE pointing at the
 * backend. When an app co-bundles the backend with `serveBackend` (agentcore-bundle.ts), it
 * calls `serveBackend()` directly instead and this `main()` is not the entry.
 */
export async function main(): Promise<void> {
	const backendModule = process.env.BB_AGENT_BACKEND_MODULE;
	if (!backendModule)
		throw new Error('BB_AGENT_BACKEND_MODULE env var is required (path to the developer backend module).');

	// Import the developer backend — constructing the real Agent, which registers itself.
	serveBackend(() => import(backendModule));
}

// Auto-run the standalone launch path ONLY when a backend module path is provided.
// The co-bundle path (agentcore-bundle.ts) imports `serveBackend` and invokes it directly,
// and does NOT set BB_AGENT_BACKEND_MODULE — so `main()` must
// not fire there (it would double-serve and throw on the missing env var).
if (process.env.BB_AGENT_BACKEND_MODULE) {
	void main();
}
