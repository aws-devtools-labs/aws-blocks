// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The AgentCore invocation contract and handler, split out of agentcore-entry.ts so it can be
 * unit-tested without starting the harness. Internal: not in the package's export map.
 */

import { z } from 'zod';
import type { AgentTurnPayload } from './agent.js';

/** Request contract — mirrors the Lambda jobPayloadSchema, minus transport-only fields. */
export const requestSchema = z.object({
	/** User prompt. Empty on resume (interruptResponses drive the turn instead). */
	prompt: z.string().default(''),
	/** Realtime channel the client subscribes to for this turn's chunks. */
	channelId: z.string(),
	/** Conversation to persist to / restore the session from. Absent means no persistence (as in the mock). */
	conversationId: z.string().optional(),
	/** Owner of the conversation. Required when persistence is enabled (not inferenceOnly), and for an inferenceOnly agent with `sessionScope: 'user'` (the default). */
	userId: z.string().optional(),
	/** HITL resume: approval responses to apply instead of a new prompt. */
	interruptResponses: z.array(z.object({ interruptId: z.string(), response: z.string() })).optional(),
	/** Per-call tool context, threaded through to tool handlers. Must be JSON-serializable. */
	context: z.unknown().optional(),
});

/** The part of an Agent the AgentCore entry drives. */
export interface TurnRunner {
	invokeTurn(payload: Omit<AgentTurnPayload<unknown>, 'userId'> & { userId?: string }): Promise<void>;
}

/** The response to an AgentCore invocation: the turn was started. */
export interface InvocationAck {
	channelId: string;
	status: 'accepted';
}

/**
 * Handle one AgentCore invocation: start the turn as a background async task and ack.
 *
 * AgentCore routes every invocation for a session to the same warm microVM, and for a
 * conversation the session id is the conversationId (agent.aws.ts dispatchTurn). The session
 * id (`_context.sessionId`) is deliberately NOT used as a fallback conversationId: a turn
 * without one has no persisted session, exactly as in the mock, and the ownership check in
 * stream()/resume() only covers turns that carry a conversationId.
 */
export function handleInvocation(
	agent: TurnRunner,
	tasks: { addAsyncTask(name: string): number; completeAsyncTask(taskId: number): unknown },
	request: z.infer<typeof requestSchema>,
	_context: { sessionId?: string },
): InvocationAck {
	// Run the turn as a background async task so this invocation returns immediately.
	// The harness reports `/ping` = HealthyBusy while the task is in flight, keeping
	// the microVM alive (up to the 8h session lifetime) until the loop completes.
	// Chunks are delivered out-of-band via Realtime — this HTTP response is just an ack.
	const taskId = tasks.addAsyncTask('agent-turn');
	void agent
		.invokeTurn({
			message: request.prompt,
			conversationId: request.conversationId,
			channelId: request.channelId,
			// Passed through as-is: the agent decides what a missing userId means (the 'anonymous'
			// default, or a refused turn for an inferenceOnly agent with sessionScope: 'user', its default).
			userId: request.userId,
			interruptResponses: request.interruptResponses,
			context: request.context,
		})
		.finally(() => tasks.completeAsyncTask(taskId));

	// The client already has channelId (from the RPC that invoked us) and subscribes
	// to Realtime; it does not consume this response body.
	return { channelId: request.channelId, status: 'accepted' };
}

/** An invocation arrived before the app config file was readable. The next one tries again. */
export class ConfigNotReadyError extends Error {
	constructor() {
		super('The app config is not readable yet; the AgentCore Runtime loads it again on the next invocation.');
		this.name = 'ConfigNotReadyError';
	}
}

/**
 * Load the app config, then the backend, once per process.
 *
 * The backend is imported only after the config is readable, because its Building Blocks read
 * that config. While the config is missing each call fails with {@link ConfigNotReadyError} and
 * the next call loads the config again. A failed config load is retried the same way. Once the
 * backend import has started its result is final: a module is not imported twice.
 */
export function backendLoader<T>(steps: {
	loadConfig(): Promise<void>;
	/** After `loadConfig()`: true while the config file exists in the deployment but is not readable yet. */
	configMissing(): boolean;
	loadBackend(): Promise<T>;
}): () => Promise<T> {
	let loaded: Promise<T> | null = null;
	return () => {
		if (loaded) return loaded;
		let importing = false;
		const attempt = (async () => {
			await steps.loadConfig();
			if (steps.configMissing()) throw new ConfigNotReadyError();
			importing = true;
			return steps.loadBackend();
		})();
		loaded = attempt;
		attempt.catch(() => {
			if (!importing && loaded === attempt) loaded = null;
		});
		return attempt;
	};
}
