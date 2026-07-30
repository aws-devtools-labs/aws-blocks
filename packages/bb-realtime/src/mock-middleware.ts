// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * @aws-blocks/bb-realtime/mock-middleware
 *
 * Self-registering client middleware for local dev.
 * Hydrates { __blocks: 'realtime/channel' } descriptors into
 * live channel clients over the local dev server's WebSocket.
 */

import { registerMiddleware } from '@aws-blocks/core/client';
import type { RealtimeChannelDescriptor, RealtimeSubscription, SubscribeOptions, DisconnectReason } from './types.js';

/** Callback for receiving realtime messages. */
export type MessageHandler<T = unknown> = (message: T) => void;

/**
 * Client-side realtime channel handle.
 * Returned by middleware hydration of `{ __blocks: 'realtime/channel' }` descriptors.
 */
export interface RealtimeChannelClient<T = unknown> {
	subscribe(handler: MessageHandler<T>): RealtimeSubscription;
	subscribe(options: SubscribeOptions<T>): RealtimeSubscription;
}

// ── WebSocket client — keyed by wsUrl ───────────────────────────────────────

interface PendingSubscribe {
	resolve: () => void;
	reject: (err: Error) => void;
}

const connections = new Map<string, {
	ws: WebSocket | undefined;
	isConnected: boolean;
	reconnectAttempts: number;
	subscriptions: Map<string, Set<MessageHandler>>;
	/** Channel token per channel, replayed on (re)subscribe so the server can authorize. */
	channelTokens: Map<string, string | undefined>;
	pendingSubs: { channel: string; token?: string }[];
	pendingMessages: string[];
	pendingEstablished: Map<string, PendingSubscribe[]>;
	disconnectHandlers: Set<(reason: DisconnectReason) => void>;
	/** Pending reconnect timer, tracked so it can be cleared on teardown. */
	reconnectTimer?: ReturnType<typeof setTimeout>;
}>();

const MAX_RECONNECT = 5;
const MAX_DELAY_MS = 30_000;

function getOrCreateConnection(wsUrl: string) {
	let conn = connections.get(wsUrl);
	if (!conn) {
		conn = {
			ws: undefined,
			isConnected: false,
			reconnectAttempts: 0,
			subscriptions: new Map(),
			channelTokens: new Map(),
			pendingSubs: [],
			pendingMessages: [],
			pendingEstablished: new Map(),
			disconnectHandlers: new Set(),
		};
		connections.set(wsUrl, conn);
	}
	return conn;
}

function doConnect(wsUrl: string) {
	const conn = getOrCreateConnection(wsUrl);
	try {
		conn.ws = new WebSocket(wsUrl);
		conn.ws.onopen = () => {
			conn.isConnected = true;
			conn.reconnectAttempts = 0;
			for (const ch of conn.subscriptions.keys()) {
				conn.ws!.send(JSON.stringify({ action: 'subscribe', channel: ch, token: conn.channelTokens.get(ch) }));
			}
			for (const { channel, token } of conn.pendingSubs) {
				if (!conn.subscriptions.has(channel)) {
					conn.ws!.send(JSON.stringify({ action: 'subscribe', channel, token }));
				}
			}
			conn.pendingSubs.length = 0;
			for (const msg of conn.pendingMessages) { conn.ws!.send(msg); }
			conn.pendingMessages.length = 0;
		};
		conn.ws.onmessage = (event) => {
			try {
				const data = JSON.parse(event.data as string);
				if (data.type === 'subscribe_success' && data.channel) {
					const pending = conn.pendingEstablished.get(data.channel);
					if (pending) {
						pending.forEach(p => { p.resolve(); });
						conn.pendingEstablished.delete(data.channel);
					}
				} else if (data.type === 'error' && data.channel) {
					const pending = conn.pendingEstablished.get(data.channel);
					if (pending) {
						const err = new Error(data.message || 'Subscription rejected');
						err.name = 'ConnectionFailedException';
						pending.forEach(p => { p.reject(err); });
						conn.pendingEstablished.delete(data.channel);
					}
					// Remove the subscription entry since it was rejected
					conn.subscriptions.delete(data.channel);
					conn.channelTokens.delete(data.channel);
				} else if (data.type === 'message' && data.channel) {
					const handlers = conn.subscriptions.get(data.channel);
					if (handlers) {
						handlers.forEach(h => { try { h(data.data); } catch (e) { console.error('[Realtime] Handler error:', e); } });
					}
				}
			} catch (e) { console.error('[Realtime] Parse error:', e); }
		};
		conn.ws.onclose = () => {
			conn.isConnected = false;
			conn.disconnectHandlers.forEach(h => { try { h('unknown'); } catch {} });
			conn.disconnectHandlers.clear();
			scheduleReconnect(wsUrl);
		};
		conn.ws.onerror = (e) => {
			console.error('[Realtime] WS error:', e);
			conn.disconnectHandlers.forEach(h => { try { h('error'); } catch {} });
		};
	} catch (e) { console.error('[Realtime] Connection error:', e); scheduleReconnect(wsUrl); }
}

function scheduleReconnect(wsUrl: string) {
	const conn = getOrCreateConnection(wsUrl);
	if (conn.reconnectAttempts >= MAX_RECONNECT) return;
	conn.reconnectAttempts++;
	const delay = Math.min(1000 * 2 ** (conn.reconnectAttempts - 1), MAX_DELAY_MS);
	conn.reconnectTimer = setTimeout(() => doConnect(wsUrl), delay);
}

/**
 * @internal Exposed for tests. Closes all client connections, clears pending
 * reconnect timers, and drops connection state so the module does not leak
 * sockets or timers across test files.
 */
export function __resetConnectionsForTest(): void {
	for (const conn of connections.values()) {
		if (conn.reconnectTimer) clearTimeout(conn.reconnectTimer);
		conn.subscriptions.clear();
		conn.channelTokens.clear();
		conn.disconnectHandlers.clear();
		try { conn.ws?.close(); } catch {}
	}
	connections.clear();
}

function ensureConnected(wsUrl: string) {
	const conn = getOrCreateConnection(wsUrl);
	if (conn.ws && (conn.isConnected || conn.reconnectAttempts < MAX_RECONNECT)) return;
	if (conn.reconnectAttempts >= MAX_RECONNECT) {
		conn.reconnectAttempts = 0;
		conn.ws = undefined;
	}
	doConnect(wsUrl);
}

function subscribeTo(wsUrl: string, channel: string, handler: MessageHandler, token?: string, onDisconnect?: (reason: DisconnectReason) => void): RealtimeSubscription {
	const conn = getOrCreateConnection(wsUrl);
	ensureConnected(wsUrl);
	if (onDisconnect) conn.disconnectHandlers.add(onDisconnect);

	let establishedResolve: () => void;
	let establishedReject: (err: Error) => void;
	const established = new Promise<void>((resolve, reject) => {
		establishedResolve = resolve;
		establishedReject = reject;
	});

	if (!conn.subscriptions.has(channel)) {
		conn.subscriptions.set(channel, new Set());
		conn.channelTokens.set(channel, token);
		const subMsg = JSON.stringify({ action: 'subscribe', channel, token });
		if (conn.isConnected && conn.ws?.readyState === WebSocket.OPEN) {
			conn.ws.send(subMsg);
		} else {
			conn.pendingSubs.push({ channel, token });
		}
	}

	if (!conn.pendingEstablished.has(channel)) {
		conn.pendingEstablished.set(channel, []);
	}
	conn.pendingEstablished.get(channel)!.push({ resolve: establishedResolve!, reject: establishedReject! });

	conn.subscriptions.get(channel)!.add(handler);

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
					conn.channelTokens.delete(channel);
					if (conn.isConnected && conn.ws?.readyState === WebSocket.OPEN) {
						conn.ws!.send(JSON.stringify({ action: 'unsubscribe', channel }));
					}
				}
			}
		},
		established,
		connection: conn.ws!,
	};
}

function isRealtimeDescriptor(data: unknown): data is RealtimeChannelDescriptor & { wsUrl: string; token?: string } {
	return typeof data === 'object' && data !== null
		&& (data as any).__blocks === 'realtime/channel'
		&& typeof (data as any).wsUrl === 'string';
}

/**
 * @internal Exposed for tests. Hydrates `{ __blocks: 'realtime/channel' }`
 * descriptors into live channel clients. Registered as response middleware
 * for production use via `registerMiddleware` below.
 */
export function hydrate(data: unknown): unknown {
	if (isRealtimeDescriptor(data)) {
		const { channel, wsUrl, token } = data;
		return {
			subscribe(handlerOrOptions: MessageHandler | SubscribeOptions) {
				const handler = typeof handlerOrOptions === 'function' ? handlerOrOptions : handlerOrOptions.onMessage;
				const onDisconnect = typeof handlerOrOptions === 'function' ? undefined : handlerOrOptions.onDisconnect;
				return subscribeTo(wsUrl, channel, handler, token as string | undefined, onDisconnect);
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
