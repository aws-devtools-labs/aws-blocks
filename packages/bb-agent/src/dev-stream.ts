// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Local dev SSE attachment for the Agent BB.
 *
 * The dev-server's RPC/RawRoute layer buffers a single response, so it can't stream. This
 * dev-attachment registers a generic dev route handler (see dev-server's
 * `__BLOCKS_DEV_ROUTE_HANDLERS__`) that serves `POST /aws-blocks/agent-stream` as a real
 * `text/event-stream`, driving the mock Agent's `streamSSE()` generator via `res.write`.
 *
 * This makes LOCAL streaming behave exactly like AWS (where AgentCore Runtime serves SSE):
 * the same chunk frames, the same `streamSSE()` loop, the same client SSE parser. Registered
 * by agent.mock.ts via `registerDevAttachment('@aws-blocks/bb-agent/dev-stream')`.
 */

import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { getAgentInstance } from './agent.js';

/** POST body for the local agent-stream route. Mirrors the AgentCore invocation payload. */
interface AgentStreamBody {
	agentId: string;
	prompt?: string;
	conversationId?: string;
	userId?: string;
	interruptResponses?: Array<{ interruptId: string; response: string }>;
	context?: unknown;
}

const ROUTE = '/aws-blocks/agent-stream';

function readBody(req: IncomingMessage): Promise<string> {
	return new Promise((resolve, reject) => {
		let data = '';
		req.on('data', (c) => {
			data += c;
		});
		req.on('end', () => resolve(data));
		req.on('error', reject);
	});
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
	const body = JSON.parse((await readBody(req)) || '{}') as AgentStreamBody;
	const agent = getAgentInstance(body.agentId);
	if (!agent) {
		res.writeHead(404, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: `No Agent registered with id '${body.agentId}'` }));
		return;
	}

	// SSE headers. CORS is already set by the dev-server's inline handler before we run.
	res.writeHead(200, {
		'Content-Type': 'text/event-stream',
		'Cache-Control': 'no-cache',
		Connection: 'keep-alive',
	});

	try {
		for await (const chunk of agent.streamSSE(body.prompt ?? '', {
			conversationId: body.conversationId,
			userId: body.userId,
			interruptResponses: body.interruptResponses,
			context: body.context as never,
		})) {
			const { type, ...data } = chunk;
			res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
		}
	} catch (err) {
		const error = err instanceof Error ? err.message : String(err);
		res.write(`event: error\ndata: ${JSON.stringify({ error })}\n\n`);
	}
	res.end();
}

/** Called by the dev-server for each registered dev attachment. */
export function attach(_server: Server): void {
	const handlers = (globalThis as any).__BLOCKS_DEV_ROUTE_HANDLERS__ as
		| Array<{ method: string; pathname: string; handle: (req: IncomingMessage, res: ServerResponse) => unknown }>
		| undefined;
	if (!handlers) return; // Older dev-server without the route-handler hook — no local streaming.
	// Multiple Agent instances register the same attachment specifier; only add the route once.
	if (handlers.some((h) => h.pathname === ROUTE)) return;
	handlers.push({ method: 'POST', pathname: ROUTE, handle });
}
