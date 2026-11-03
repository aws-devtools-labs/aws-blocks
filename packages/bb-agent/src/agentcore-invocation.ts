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
	/** Owner of the conversation. Required when persistence is enabled (not inferenceOnly). */
	userId: z.string().optional(),
	/** HITL resume: approval responses to apply instead of a new prompt. */
	interruptResponses: z.array(z.object({ interruptId: z.string(), response: z.string() })).optional(),
	/** Per-call tool context, threaded through to tool handlers. Must be JSON-serializable. */
	context: z.unknown().optional(),
});

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
	agent: { invokeTurn(payload: AgentTurnPayload<unknown>): Promise<void> },
	tasks: { addAsyncTask(name: string): number; completeAsyncTask(taskId: number): unknown },
	request: z.infer<typeof requestSchema>,
	_context: { sessionId?: string },
): { channelId: string; status: 'accepted' } {
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
			userId: request.userId ?? 'anonymous',
			interruptResponses: request.interruptResponses,
			context: request.context,
		})
		.finally(() => tasks.completeAsyncTask(taskId));

	// The client already has channelId (from the RPC that invoked us) and subscribes
	// to Realtime; it does not consume this response body.
	return { channelId: request.channelId, status: 'accepted' };
}
