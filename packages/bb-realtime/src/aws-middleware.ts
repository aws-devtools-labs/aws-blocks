// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * @aws-blocks/bb-realtime/aws-middleware
 *
 * Self-registering client middleware for AWS (production).
 * Hydrates { __blocks: 'realtime/channel' } descriptors into live channel
 * clients over a plain WebSocket to API Gateway.
 *
 * Uses a single shared WebSocket per API Gateway endpoint, multiplexing
 * channel subscriptions with per-subscribe auth tokens. Sends periodic
 * keep-alive pings to prevent the 10-minute idle timeout.
 */

import { registerMiddleware } from '@aws-blocks/core/client';
import type { RealtimeChannelDescriptor, RealtimeSubscription, SubscribeOptions, DisconnectReason } from './types.js';

/** Callback for receiving realtime messages. */
export type MessageHandler<T = unknown> = (message: T) => void;

/** Client-side realtime channel handle. */
export interface RealtimeChannelClient<T = unknown> {
	subscribe(handler: MessageHandler<T>): RealtimeSubscription;
	subscribe(options: SubscribeOptions<T>): RealtimeSubscription;
}

// ── Keep-alive interval (~9 minutes, under 10-min idle timeout) ─────────────

const KEEP_ALIVE_MS = 9 * 60 * 1000;

// ── Shared connection pool — keyed by wsUrl ─────────────────────────────────

interface PendingSubscribe {
	resolve: () => void;
	reject: (err: Error) => void;
}

interface Connection {
	ws: WebSocket | undefined;
	connected: boolean;
	/** Per-channel message handlers. */
	subscriptions: Map<string, Set<MessageHandler>>;
	/** Per-channel established promise callbacks. */
	pendingEstablished: Map<string, PendingSubscribe[]>;
	/** Subscriptions queued before WebSocket is open. */
	pendingSubs: { channel: string; token: string }[];
	/** Keep-alive interval handle. */
	keepAliveTimer: ReturnType<typeof setInterval> | null;
	/** Registered onDisconnect callbacks (called on unexpected close). */
	disconnectHandlers: Set<(reason: DisconnectReason) => void>;
}

const connections = new Map<string, Connection>();

function getOrCreateConnection(wsUrl: string, connectToken: string): Connection {
	let conn = connections.get(wsUrl);
	if (conn) {
		return conn;
	}


	conn = {
		ws: undefined,
		connected: false,
		subscriptions: new Map(),
		pendingEstablished: new Map(),
		pendingSubs: [],
		keepAliveTimer: null,
		disconnectHandlers: new Set(),
	};
	connections.set(wsUrl, conn);

	const url = `${wsUrl}?token=${encodeURIComponent(connectToken)}`;
	const ws = new WebSocket(url);
	conn.ws = ws;

	ws.onopen = () => {
		conn!.connected = true;
		// Flush queued subscribes
		for (const sub of conn!.pendingSubs) {
			ws.send(JSON.stringify({ action: 'subscribe', channel: sub.channel, token: sub.token }));
		}
		conn!.pendingSubs.length = 0;
		// Start keep-alive
		conn!.keepAliveTimer = setInterval(() => {
			if (ws.readyState === WebSocket.OPEN) {
				ws.send(JSON.stringify({ action: 'ping' }));
			}
		}, KEEP_ALIVE_MS);
	};

	ws.onmessage = (event) => {
		try {
			const msg = JSON.parse(event.data as string);
			if (msg.type === 'subscribe_success' && msg.channel) {
				const pending = conn!.pendingEstablished.get(msg.channel);
				if (pending) {
					pending.forEach(p => p.resolve());
					conn!.pendingEstablished.delete(msg.channel);
				}
			} else if (msg.type === 'error' && msg.channel) {
				const pending = conn!.pendingEstablished.get(msg.channel);
				if (pending) {
					const err = new Error(msg.message || 'Subscription rejected');
					err.name = 'ConnectionFailedException';
					pending.forEach(p => p.reject(err));
					conn!.pendingEstablished.delete(msg.channel);
				}
				conn!.subscriptions.delete(msg.channel);
			} else if (msg.type === 'message' && msg.channel) {
				const handlers = conn!.subscriptions.get(msg.channel);
				if (handlers) {
					handlers.forEach(h => { try { h(msg.data); } catch {} });
				}
			}
		} catch {}
	};

	ws.onerror = () => {
		const err = new Error('WebSocket connection failed');
		err.name = 'ConnectionFailedException';
		for (const pending of conn!.pendingEstablished.values()) {
			pending.forEach(p => p.reject(err));
		}
		conn!.pendingEstablished.clear();
		conn!.disconnectHandlers.forEach(h => { try { h('error'); } catch {} });
	};

	ws.onclose = (event) => {
		const err = new Error('WebSocket closed');
		err.name = 'ConnectionFailedException';
		for (const pending of conn!.pendingEstablished.values()) {
			pending.forEach(p => p.reject(err));
		}
		conn!.pendingEstablished.clear();
		conn!.connected = false;
		if (conn!.keepAliveTimer) { clearInterval(conn!.keepAliveTimer); conn!.keepAliveTimer = null; }
		// 1001 = going away (server timeout), 1006 = abnormal closure
		const reason: DisconnectReason = event.code === 1001 ? 'timeout' : event.code === 1006 ? 'error' : 'unknown';
		conn!.disconnectHandlers.forEach(h => { try { h(reason); } catch {} });
		conn!.disconnectHandlers.clear();
		connections.delete(wsUrl);
	};

	return conn;
}

function subscribeTo(
	wsUrl: string,
	connectToken: string,
	channel: string,
	token: string,
	handler: MessageHandler,
	onDisconnect?: (reason: DisconnectReason) => void,
): RealtimeSubscription {
	const conn = getOrCreateConnection(wsUrl, connectToken);

	if (!conn.subscriptions.has(channel)) {
		conn.subscriptions.set(channel, new Set());
	}
	conn.subscriptions.get(channel)!.add(handler);
	if (onDisconnect) conn.disconnectHandlers.add(onDisconnect);

	let establishedResolve: () => void;
	let establishedReject: (err: Error) => void;
	const established = new Promise<void>((resolve, reject) => {
		establishedResolve = resolve;
		establishedReject = reject;
	});

	if (!conn.pendingEstablished.has(channel)) {
		conn.pendingEstablished.set(channel, []);
	}
	conn.pendingEstablished.get(channel)!.push({ resolve: establishedResolve!, reject: establishedReject! });

	if (conn.connected && conn.ws?.readyState === WebSocket.OPEN) {
		conn.ws.send(JSON.stringify({ action: 'subscribe', channel, token }));
	} else {
		conn.pendingSubs.push({ channel, token });
	}

	return {
		unsubscribe() {
			if (onDisconnect) {
				try { onDisconnect('client'); } catch {}
				conn.disconnectHandlers.delete(onDisconnect);
			}
			const handlers = conn.subscriptions.get(channel);
			if (handlers) {
				handlers.delete(handler);
				if (handlers.size === 0) {
					conn.subscriptions.delete(channel);
					if (conn.connected && conn.ws?.readyState === WebSocket.OPEN) {
						conn.ws.send(JSON.stringify({ action: 'unsubscribe', channel }));
					}
				}
			}
			// Close shared connection if no subscriptions remain
			if (conn.subscriptions.size === 0 && conn.ws) {
				if (conn.keepAliveTimer) { clearInterval(conn.keepAliveTimer); conn.keepAliveTimer = null; }
				conn.ws.onmessage = null;
				conn.ws.onerror = null;
				conn.ws.onclose = null;
				conn.ws.close();
				conn.connected = false;
				// Remove pool entry so next subscribe creates a fresh connection
				for (const [url, c] of connections) {
					if (c === conn) { connections.delete(url); break; }
				}
			}
		},
		established,
		connection: conn.ws!,
	};
}

// ── Hydration ───────────────────────────────────────────────────────────────

type AwsRealtimeDescriptor = RealtimeChannelDescriptor & {
	wsUrl: string;
	connectToken: string;
	token: string;
};

function isRealtimeDescriptor(data: unknown): data is AwsRealtimeDescriptor {
	return typeof data === 'object' && data !== null
		&& (data as any).__blocks === 'realtime/channel'
		&& typeof (data as any).wsUrl === 'string'
		&& typeof (data as any).connectToken === 'string'
		&& typeof (data as any).token === 'string';
}

function hydrate(data: unknown): unknown {
	if (isRealtimeDescriptor(data)) {
		const { channel, wsUrl, connectToken, token } = data;
		return {
			subscribe(handlerOrOptions: MessageHandler | SubscribeOptions) {
				const handler = typeof handlerOrOptions === 'function' ? handlerOrOptions : handlerOrOptions.onMessage;
				const onDisconnect = typeof handlerOrOptions === 'function' ? undefined : handlerOrOptions.onDisconnect;
				return subscribeTo(wsUrl, connectToken, channel, token, handler, onDisconnect);
			},
		} satisfies RealtimeChannelClient;
	}
	if (Array.isArray(data)) return data.map(hydrate);
	if (typeof data === 'object' && data !== null) {
		const result: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(data)) result[k] = hydrate(v);
		return result;
	}
	return data;
}

registerMiddleware({ onResponse: hydrate });
