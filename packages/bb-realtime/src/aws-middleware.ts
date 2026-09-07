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

// ── Auto-reconnect caps (mirrors mock-middleware.ts) ────────────────────────

/** Maximum reconnect attempts after an unexpected drop before giving up. */
const MAX_RECONNECT = 5;
/** Ceiling for exponential backoff between reconnect attempts. */
const MAX_DELAY_MS = 30_000;

// ── Shared connection pool — keyed by wsUrl ─────────────────────────────────

interface PendingSubscribe {
	resolve: () => void;
	reject: (err: Error) => void;
}

interface Connection {
	ws: WebSocket | undefined;
	connected: boolean;
	/** API Gateway endpoint, retained so a reconnect can rebuild the socket URL. */
	wsUrl: string;
	/** Connection-level auth token, replayed in the URL on every (re)connect. */
	connectToken: string;
	/** Per-channel message handlers. */
	subscriptions: Map<string, Set<MessageHandler>>;
	/** Per-channel auth token, replayed on resubscribe after a reconnect. */
	channelTokens: Map<string, string>;
	/** Per-channel established promise callbacks. */
	pendingEstablished: Map<string, PendingSubscribe[]>;
	/** Subscriptions queued before WebSocket is open. */
	pendingSubs: { channel: string; token: string }[];
	/** Keep-alive interval handle. */
	keepAliveTimer: ReturnType<typeof setInterval> | null;
	/** Registered onDisconnect callbacks (called on unexpected close). */
	disconnectHandlers: Set<(reason: DisconnectReason) => void>;
	/** Registered onReconnect callbacks (called after a successful resubscribe). */
	reconnectHandlers: Set<() => void>;
	/** Consecutive reconnect attempts since the last successful open. */
	reconnectAttempts: number;
	/** Pending reconnect timer, tracked so it can be cleared on teardown. */
	reconnectTimer: ReturnType<typeof setTimeout> | null;
	/** Channels awaiting resubscribe confirmation after a reconnect; when it drains, onReconnect fires. `null` outside a reconnect. */
	resubscribePending: Set<string> | null;
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
		wsUrl,
		connectToken,
		subscriptions: new Map(),
		channelTokens: new Map(),
		pendingEstablished: new Map(),
		pendingSubs: [],
		keepAliveTimer: null,
		disconnectHandlers: new Set(),
		reconnectHandlers: new Set(),
		reconnectAttempts: 0,
		reconnectTimer: null,
		resubscribePending: null,
	};
	connections.set(wsUrl, conn);

	openSocket(conn, false);
	return conn;
}

/**
 * Open (or re-open) the shared WebSocket for a connection and wire up its
 * handlers. Called on the first subscribe (`isReconnect = false`) and again by
 * `scheduleReconnect` after an unexpected drop (`isReconnect = true`). On a
 * reconnect the open handler resubscribes every stored channel with its
 * replayed token, re-arms the keep-alive ping, and fires each subscription's
 * onReconnect once the server re-confirms — mirroring mock-middleware.ts.
 */
function openSocket(conn: Connection, isReconnect: boolean): void {
	const wsUrl = conn.wsUrl;
	const url = `${wsUrl}?token=${encodeURIComponent(conn.connectToken)}`;
	const ws = new WebSocket(url);
	conn.ws = ws;

	ws.onopen = () => {
		conn.connected = true;
		conn.reconnectAttempts = 0;
		// Resubscribe every stored channel, replaying its stored token so the
		// server can re-authorize. This covers the initial connect and a
		// reconnect uniformly. On a reconnect, track the channels so onReconnect
		// can fire only after the server re-confirms each resubscribe.
		const channels = [...conn.subscriptions.keys()];
		if (isReconnect) {
			conn.resubscribePending = new Set(channels);
		}
		for (const channel of channels) {
			ws.send(JSON.stringify({ action: 'subscribe', channel, token: conn.channelTokens.get(channel) }));
		}
		// Flush subscribes queued while the socket was down (skip any already
		// resent above).
		for (const sub of conn.pendingSubs) {
			if (!conn.subscriptions.has(sub.channel)) {
				ws.send(JSON.stringify({ action: 'subscribe', channel: sub.channel, token: sub.token }));
			}
		}
		conn.pendingSubs.length = 0;
		// (Re-)establish keep-alive on the current socket.
		if (conn.keepAliveTimer) { clearInterval(conn.keepAliveTimer); }
		conn.keepAliveTimer = setInterval(() => {
			if (ws.readyState === WebSocket.OPEN) {
				ws.send(JSON.stringify({ action: 'ping' }));
			}
		}, KEEP_ALIVE_MS);
	};

	ws.onmessage = (event) => {
		try {
			const msg = JSON.parse(event.data as string);
			if (msg.type === 'subscribe_success' && msg.channel) {
				const pending = conn.pendingEstablished.get(msg.channel);
				if (pending) {
					pending.forEach(p => { p.resolve(); });
					conn.pendingEstablished.delete(msg.channel);
				}
				// After a reconnect, fire onReconnect once every resubscribed
				// channel has been re-confirmed by the server.
				if (conn.resubscribePending?.has(msg.channel)) {
					conn.resubscribePending.delete(msg.channel);
					if (conn.resubscribePending.size === 0) {
						conn.resubscribePending = null;
						conn.reconnectHandlers.forEach(h => { try { h(); } catch {} });
					}
				}
			} else if (msg.type === 'error' && msg.channel) {
				const pending = conn.pendingEstablished.get(msg.channel);
				if (pending) {
					const err = new Error(msg.message || 'Subscription rejected');
					err.name = 'ConnectionFailedException';
					pending.forEach(p => { p.reject(err); });
					conn.pendingEstablished.delete(msg.channel);
				}
				conn.subscriptions.delete(msg.channel);
			} else if (msg.type === 'message' && msg.channel) {
				const handlers = conn.subscriptions.get(msg.channel);
				if (handlers) {
					handlers.forEach(h => { try { h(msg.data); } catch {} });
				}
			}
		} catch {}
	};

	ws.onerror = () => {
		const err = new Error('WebSocket connection failed');
		err.name = 'ConnectionFailedException';
		for (const pending of conn.pendingEstablished.values()) {
			pending.forEach(p => { p.reject(err); });
		}
		conn.pendingEstablished.clear();
		conn.disconnectHandlers.forEach(h => { try { h('error'); } catch {} });
	};

	ws.onclose = (event) => {
		conn.connected = false;
		if (conn.keepAliveTimer) { clearInterval(conn.keepAliveTimer); conn.keepAliveTimer = null; }
		// 1001 = going away (server timeout), 1006 = abnormal closure
		const reason: DisconnectReason = event.code === 1001 ? 'timeout' : event.code === 1006 ? 'error' : 'unknown';
		conn.disconnectHandlers.forEach(h => { try { h(reason); } catch {} });
		conn.disconnectHandlers.clear();
		// A normal (1000) or no-status (1005) close is client-initiated/expected:
		// fail any pending establishment and drop the pool entry. Any other code
		// is an unexpected drop, so auto-reconnect and keep pendingEstablished
		// intact so the resubscribe on reconnect can still resolve it (mirrors
		// mock-middleware.ts, which never rejects on a transient drop).
		if (event.code === 1000 || event.code === 1005) {
			const err = new Error('WebSocket closed');
			err.name = 'ConnectionFailedException';
			for (const pending of conn.pendingEstablished.values()) {
				pending.forEach(p => { p.reject(err); });
			}
			conn.pendingEstablished.clear();
			connections.delete(wsUrl);
		} else {
			scheduleReconnect(conn);
		}
	};
}

/**
 * Schedule a reconnect after an unexpected drop, using exponential backoff
 * (min(1000·2^(n-1), MAX_DELAY_MS)) and giving up after MAX_RECONNECT attempts
 * so a persistently-failing endpoint does not spin forever.
 */
function scheduleReconnect(conn: Connection): void {
	if (conn.reconnectAttempts >= MAX_RECONNECT) return;
	conn.reconnectAttempts++;
	const delay = Math.min(1000 * 2 ** (conn.reconnectAttempts - 1), MAX_DELAY_MS);
	conn.reconnectTimer = setTimeout(() => openSocket(conn, true), delay);
}

/**
 * @internal Exposed for tests. Closes all client connections, clears pending
 * keep-alive and reconnect timers, and drops connection state so the module
 * does not leak sockets or timers across test files.
 */
export function __resetConnectionsForTest(): void {
	for (const conn of connections.values()) {
		if (conn.keepAliveTimer) { clearInterval(conn.keepAliveTimer); conn.keepAliveTimer = null; }
		if (conn.reconnectTimer) { clearTimeout(conn.reconnectTimer); conn.reconnectTimer = null; }
		conn.subscriptions.clear();
		conn.channelTokens.clear();
		conn.disconnectHandlers.clear();
		conn.reconnectHandlers.clear();
		conn.resubscribePending = null;
		if (conn.ws) {
			// Detach handlers first so the close does not schedule a reconnect.
			conn.ws.onmessage = null;
			conn.ws.onerror = null;
			conn.ws.onclose = null;
			try { conn.ws.close(); } catch {}
		}
	}
	connections.clear();
}

function subscribeTo(
	wsUrl: string,
	connectToken: string,
	channel: string,
	token: string,
	handler: MessageHandler,
	onDisconnect?: (reason: DisconnectReason) => void,
	onReconnect?: () => void,
): RealtimeSubscription {
	const conn = getOrCreateConnection(wsUrl, connectToken);

	if (!conn.subscriptions.has(channel)) {
		conn.subscriptions.set(channel, new Set());
	}
	conn.subscriptions.get(channel)!.add(handler);
	// Store the channel token so it can be replayed on resubscribe after a reconnect.
	conn.channelTokens.set(channel, token);
	if (onDisconnect) conn.disconnectHandlers.add(onDisconnect);
	if (onReconnect) conn.reconnectHandlers.add(onReconnect);

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
			if (onReconnect) conn.reconnectHandlers.delete(onReconnect);
			const handlers = conn.subscriptions.get(channel);
			if (handlers) {
				handlers.delete(handler);
				if (handlers.size === 0) {
					conn.subscriptions.delete(channel);
					conn.channelTokens.delete(channel);
					if (conn.connected && conn.ws?.readyState === WebSocket.OPEN) {
						conn.ws.send(JSON.stringify({ action: 'unsubscribe', channel }));
					}
				}
			}
			// Close shared connection if no subscriptions remain
			if (conn.subscriptions.size === 0 && conn.ws) {
				if (conn.keepAliveTimer) { clearInterval(conn.keepAliveTimer); conn.keepAliveTimer = null; }
				if (conn.reconnectTimer) { clearTimeout(conn.reconnectTimer); conn.reconnectTimer = null; }
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

/**
 * @internal Exposed for tests. Hydrates `{ __blocks: 'realtime/channel' }`
 * descriptors into live channel clients. Registered as response middleware
 * for production use via `registerMiddleware` below.
 */
export function hydrate(data: unknown): unknown {
	if (isRealtimeDescriptor(data)) {
		const { channel, wsUrl, connectToken, token } = data;
		return {
			subscribe(handlerOrOptions: MessageHandler | SubscribeOptions) {
				const handler = typeof handlerOrOptions === 'function' ? handlerOrOptions : handlerOrOptions.onMessage;
				const onDisconnect = typeof handlerOrOptions === 'function' ? undefined : handlerOrOptions.onDisconnect;
				const onReconnect = typeof handlerOrOptions === 'function' ? undefined : handlerOrOptions.onReconnect;
				return subscribeTo(wsUrl, connectToken, channel, token, handler, onDisconnect, onReconnect);
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
