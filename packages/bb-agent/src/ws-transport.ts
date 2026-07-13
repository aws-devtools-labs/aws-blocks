// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Browser WebSocket transport for the Agent BB.
 *
 * On AWS the browser streams DIRECTLY from the AgentCore Runtime over a WebSocket, bypassing
 * Lambda — so a turn isn't bounded by the API-Gateway ~30s cap and long-running / streaming
 * agents work. This helper adapts that socket to `useChat`'s `streamChunks` seam: it returns a
 * transport `(args) => AsyncIterable<AgentStreamChunk>` that opens `/ws`, sends one turn, and
 * yields chunks as they arrive.
 *
 * Auth: browsers can't set WebSocket headers, so the JWT rides the `Sec-WebSocket-Protocol`
 * subprotocol (the documented AgentCore browser mechanism). The token must be one the runtime's
 * JWT authorizer accepts — for AuthCognito that's the ACCESS token (it carries the `client_id`
 * claim the authorizer validates; the ID token does not). The app supplies the endpoint +
 * token via `getEndpoint` (typically a backend API method pairing `Agent.getStreamEndpoint()`
 * with `AuthCognito.getAgentCoreToken()`). Keep the token in memory only.
 *
 * Wire contract mirrors agentcore-entry.ts's `websocketHandler`: the server sends one JSON
 * message per chunk, `{ event, data }`, where `event` is the chunk `type` and `data` is the
 * rest; a final `{ event: 'turn-complete' }` ends the turn. We reconstruct `{ type, ...data }`.
 */

import type { AgentStreamChunk } from './types.js';

/** Where + how to open the socket for a turn. Assembled by the app from its Agent + auth BBs. */
export interface AgentCoreWsEndpoint {
	/** `wss://…/runtimes/<arn>/ws?X-Amzn-…-Session-Id=<sid>` — from `Agent.getStreamEndpoint()`. */
	wsUrl: string;
	/** JWT the runtime's authorizer accepts (Cognito ACCESS token). Held in memory only. */
	token: string;
	/**
	 * Conversation owner. The runtime's JWT authorizer validates the caller's token at the
	 * gateway but does NOT forward it to the container, so the runtime can't re-derive identity
	 * from the token — the client sends it in the turn payload. The app MUST source this from its
	 * authenticated backend session (the same session that minted `token`), NOT from user input,
	 * so a browser can't name another user's conversation. Omit for inferenceOnly agents.
	 */
	userId?: string;
}

/** Turn arguments — same shape `useChat` passes to `streamChunks`. */
export interface AgentCoreWsTurn {
	conversationId: string;
	message?: string;
	interruptResponses?: Array<{ interruptId: string; response: string }>;
}

/** base64url-encode a JWT for the `Sec-WebSocket-Protocol` subprotocol (browser-safe). */
function base64UrlEncode(token: string): string {
	// JWTs are ASCII, so btoa is safe here. Convert standard base64 → base64url.
	return btoa(token).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Build the two subprotocols AgentCore expects: the encoded bearer token + the scheme marker. */
export function buildBearerSubprotocols(token: string): [string, string] {
	return [`base64UrlBearerAuthorization.${base64UrlEncode(token)}`, 'base64UrlBearerAuthorization'];
}

/**
 * Create a `streamChunks` transport that streams a turn over a direct WebSocket to AgentCore.
 *
 * @param getEndpoint - resolves the `{ wsUrl, token }` for a turn (app wires Agent + auth BBs).
 * @param deps - injectable WebSocket ctor for testing; defaults to the global `WebSocket`.
 *
 * @example
 * ```typescript
 * const streamChunks = createAgentCoreWsTransport(({ conversationId }) =>
 *   api.agentGetStreamEndpoint(conversationId), // returns { wsUrl, token }
 * );
 * const chat = useChat({ api: {...}, streamChunks });
 * ```
 */
export function createAgentCoreWsTransport(
	getEndpoint: (args: { conversationId: string }) => Promise<AgentCoreWsEndpoint>,
	deps: { WebSocketImpl?: typeof WebSocket } = {},
): (args: AgentCoreWsTurn) => AsyncIterable<AgentStreamChunk> {
	const WebSocketImpl = deps.WebSocketImpl ?? (globalThis as { WebSocket?: typeof WebSocket }).WebSocket;
	if (!WebSocketImpl) {
		throw new Error('createAgentCoreWsTransport requires a WebSocket implementation (none found on globalThis).');
	}

	return (args) => streamTurnOverWs(args, getEndpoint, WebSocketImpl);
}

/** Adapt one WebSocket turn to an async generator, bridging events → pull-based iteration. */
async function* streamTurnOverWs(
	args: AgentCoreWsTurn,
	getEndpoint: (args: { conversationId: string }) => Promise<AgentCoreWsEndpoint>,
	WebSocketImpl: typeof WebSocket,
): AsyncIterable<AgentStreamChunk> {
	const { wsUrl, token, userId } = await getEndpoint({ conversationId: args.conversationId });
	const socket = new WebSocketImpl(wsUrl, buildBearerSubprotocols(token));

	// Bridge event callbacks to the generator: a queue of ready chunks plus a single
	// waiter the generator parks on when the queue is empty. `done`/`failure` are terminal.
	const queue: AgentStreamChunk[] = [];
	let wake: (() => void) | null = null;
	let done = false;
	let failure: Error | null = null;

	const signal = () => {
		if (wake) {
			const w = wake;
			wake = null;
			w();
		}
	};

	socket.onopen = () => {
		// One message per turn: prompt for the initial call, interruptResponses on resume.
		// userId comes from the endpoint (app's authed backend), not the turn args — the runtime
		// can't derive it from the gateway-validated token, so we carry it in the payload.
		socket.send(
			JSON.stringify({
				prompt: args.message ?? '',
				interruptResponses: args.interruptResponses,
				userId,
			}),
		);
	};
	socket.onmessage = (event: MessageEvent) => {
		let frame: { event: string; data?: Record<string, unknown> };
		try {
			frame = JSON.parse(String(event.data));
		} catch {
			failure = new Error('Malformed WebSocket frame from AgentCore Runtime');
			done = true;
			signal();
			return;
		}
		if (frame.event === 'turn-complete') {
			done = true;
			signal();
			return;
		}
		// Reconstruct the chunk: server split `{ type, ...data }` into `{ event, data }`.
		queue.push({ type: frame.event, ...(frame.data ?? {}) } as AgentStreamChunk);
		signal();
	};
	socket.onerror = () => {
		// The browser Event carries no detail; surface a generic transport error.
		failure = new Error('WebSocket connection to AgentCore Runtime failed');
		done = true;
		signal();
	};
	socket.onclose = () => {
		done = true;
		signal();
	};

	try {
		while (true) {
			while (queue.length > 0) {
				yield queue.shift() as AgentStreamChunk;
			}
			// Read through a widening cast: the callbacks that set `failure` are opaque to TS's
			// control-flow analysis, so it would otherwise narrow this to `null`.
			const err = failure as Error | null;
			if (err) {
				// Emit a terminal error chunk so useChat's handleChunk surfaces it, matching SSE.
				yield { type: 'error', error: err.message } as AgentStreamChunk;
				return;
			}
			if (done) return;
			await new Promise<void>((resolve) => {
				wake = resolve;
			});
		}
	} finally {
		// Consumer stopped early (or turn ended) — close the socket unless already closed.
		if (socket.readyState === socket.OPEN || socket.readyState === socket.CONNECTING) {
			socket.close();
		}
	}
}
