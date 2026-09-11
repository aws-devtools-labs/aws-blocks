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
	/**
	 * Set TRUE only on a client-initiated teardown (unsubscribe of the last
	 * channel, `__resetConnectionsForTest`, or the MAX_RECONNECT give-up path).
	 * This is the intent signal for `ws.onclose`: the close CODE cannot tell an
	 * expected teardown from an unexpected drop (a legitimate mid-connection drop
	 * the client did not cause can arrive as 1000/1005 just as easily as
	 * 1001/1006), so only the client knows it meant to close. `onclose` treats a
	 * close as terminal iff this is true (or nothing is left to reconnect for),
	 * and otherwise reconnects on ANY code — mirroring mock-middleware.ts's
	 * tornDown/subscriptions.size guard.
	 */
	intentionalClose: boolean;
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
		intentionalClose: false,
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

	// Per-socket guard so a single drop notifies onDisconnect exactly once even
	// when the runtime fires onerror immediately followed by onclose (as it does
	// for a 1006 abnormal closure). A fresh socket gets a fresh flag, so the NEXT
	// drop still notifies — onDisconnect must fire on every drop, not just the first.
	let disconnectNotified = false;
	const notifyDisconnect = (reason: DisconnectReason): void => {
		if (disconnectNotified) { return; }
		disconnectNotified = true;
		conn.disconnectHandlers.forEach(h => { try { h(reason); } catch {} });
	};

	// Settle one channel of the post-reconnect resubscribe set. When the set
	// drains, the reconnect is confirmed: reset the retry counter (so the cap is
	// per-outage — a socket that reopens but never confirms a resubscribe still
	// exhausts MAX_RECONNECT) and fire onReconnect for the channels that came
	// back. Called on both a successful resubscribe and a stale-token error so a
	// single failed channel cannot wedge onReconnect for the ones that succeeded.
	const settleResubscribe = (channel: string): void => {
		if (!conn.resubscribePending?.has(channel)) { return; }
		conn.resubscribePending.delete(channel);
		if (conn.resubscribePending.size === 0) {
			conn.resubscribePending = null;
			// Resubscribe confirmed — only now is it safe to reset the retry cap.
			conn.reconnectAttempts = 0;
			conn.reconnectHandlers.forEach(h => { try { h(); } catch {} });
		}
	};

	ws.onopen = () => {
		conn.connected = true;
		// NOTE: reconnectAttempts is intentionally NOT reset here. A flapping
		// socket that opens then immediately drops again must still count toward
		// the cap; the counter is reset only once a resubscribe is confirmed
		// (see settleResubscribe), otherwise the cap could never hold.
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
				settleResubscribe(msg.channel);
			} else if (msg.type === 'error' && msg.channel) {
				const pending = conn.pendingEstablished.get(msg.channel);
				if (pending) {
					const err = new Error(msg.message || 'Subscription rejected');
					err.name = 'ConnectionFailedException';
					pending.forEach(p => { p.reject(err); });
					conn.pendingEstablished.delete(msg.channel);
				}
				// A resubscribe can be rejected when the channel's replayed token
				// has expired: channel tokens carry a ~2h TTL, so a socket that was
				// down long enough reconnects and replays a stale token the server
				// now refuses. Don't drop the channel silently — surface it through
				// the existing disconnect plumbing (reason 'error') so the caller
				// learns this channel is gone. Fire the handlers directly (not via
				// the per-socket notifyDisconnect) because this is a channel-level
				// failure, not a socket close, and must not suppress the disconnect
				// notification for a later real drop on this same socket.
				conn.subscriptions.delete(msg.channel);
				conn.channelTokens.delete(msg.channel);
				conn.disconnectHandlers.forEach(h => { try { h('error'); } catch {} });
				// Drain the failed channel from the resubscribe set so the channels
				// that DID succeed can still fire onReconnect instead of wedging.
				settleResubscribe(msg.channel);
			} else if (msg.type === 'message' && msg.channel) {
				const handlers = conn.subscriptions.get(msg.channel);
				if (handlers) {
					handlers.forEach(h => { try { h(msg.data); } catch {} });
				}
			}
		} catch {}
	};

	ws.onerror = () => {
		// Do NOT reject or clear pendingEstablished here. A transient drop
		// surfaces as onerror immediately followed by onclose; rejecting now would
		// kill an in-flight established promise that the resubscribe on reconnect
		// could still resolve. Let onclose decide based on the close code
		// (terminal → reject+clear; reconnecting → keep intact). Only surface the
		// disconnect, deduped per-socket so a 1006 (onerror + onclose) notifies
		// exactly once rather than double-firing onDisconnect.
		notifyDisconnect('error');
	};

	ws.onclose = (event) => {
		conn.connected = false;
		if (conn.keepAliveTimer) { clearInterval(conn.keepAliveTimer); conn.keepAliveTimer = null; }
		// Close-code → onDisconnect reason. This mapping is INDEPENDENT of the
		// reconnect decision below: it only describes WHY the socket dropped for
		// the onDisconnect callback. 1001 = going away (GW/server timeout),
		// 1006 = abnormal closure, else (incl. 1000/1005) = unknown.
		const reason: DisconnectReason = event.code === 1001 ? 'timeout' : event.code === 1006 ? 'error' : 'unknown';
		notifyDisconnect(reason);
		// Intent-based terminal classification (was: close-code-based, treating
		// {1000,1005} as terminal). Proven live on AWS: a legitimate
		// mid-connection drop the client did NOT initiate can arrive as 1000 or
		// 1005 just as easily as 1001/1006, so the close CODE cannot distinguish
		// an expected teardown from an unexpected drop. Only the client knows it
		// meant to close, tracked via `intentionalClose` (set on the last-channel
		// unsubscribe, __resetConnectionsForTest, and give-up paths).
		//
		// Terminal iff the close was intentional OR nothing is left to reconnect
		// for (subscriptions.size === 0): reject any pending establishment, drop
		// the onDisconnect handlers, and remove the pool entry.
		//
		// Otherwise it is an unexpected drop on ANY code — clean closes (1000/1005)
		// and GW timeouts (1001/1006) alike — so auto-reconnect and KEEP
		// disconnectHandlers intact (so subsequent drops still notify) and
		// pendingEstablished intact (so the resubscribe on reconnect can still
		// resolve it). This matches mock-middleware.ts, which reconnects on ANY
		// close guarded only by tornDown/subscriptions.size — the correct model.
		if (conn.intentionalClose || conn.subscriptions.size === 0) {
			conn.disconnectHandlers.clear();
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
	// Nothing to reconnect for: no channels remain (e.g. every channel's token
	// went stale and was dropped in the resubscribe-error path, or all were
	// unsubscribed). Since reconnectAttempts only resets once resubscribePending
	// drains, a channel-less connection could never reset the counter and would
	// march to the cap even though each reopen succeeds at the socket level. No
	// caller depends on this connection anymore, so tear it down instead.
	if (conn.subscriptions.size === 0) {
		if (conn.keepAliveTimer) { clearInterval(conn.keepAliveTimer); conn.keepAliveTimer = null; }
		if (conn.reconnectTimer) { clearTimeout(conn.reconnectTimer); conn.reconnectTimer = null; }
		conn.connected = false;
		conn.resubscribePending = null;
		// Deliberate teardown of a now-subscriber-less connection: mark intentional.
		conn.intentionalClose = true;
		connections.delete(conn.wsUrl);
		return;
	}
	if (conn.reconnectAttempts >= MAX_RECONNECT) {
		// Give up: MAX_RECONNECT consecutive attempts have failed. Rather than
		// leaving a zombie pool entry that a later subscribe() would keep reusing
		// (and never reconnecting), tear the connection down completely — reject
		// any still-pending establishments so awaiting callers fail fast, fire a
		// terminal disconnect so onDisconnect handlers learn the channel is dead,
		// clear the keep-alive and reconnect timers, and drop the pool entry so a
		// later subscribe() rebuilds a fresh connection from scratch.
		const err = new Error('WebSocket reconnect failed after maximum attempts');
		err.name = 'ConnectionFailedException';
		for (const pending of conn.pendingEstablished.values()) {
			pending.forEach(p => { p.reject(err); });
		}
		conn.pendingEstablished.clear();
		conn.disconnectHandlers.forEach(h => { try { h('error'); } catch {} });
		conn.disconnectHandlers.clear();
		if (conn.keepAliveTimer) { clearInterval(conn.keepAliveTimer); conn.keepAliveTimer = null; }
		if (conn.reconnectTimer) { clearTimeout(conn.reconnectTimer); conn.reconnectTimer = null; }
		conn.connected = false;
		conn.resubscribePending = null;
		// Give-up is a deliberate, client-side teardown: mark the close intentional
		// so any late onclose on the dead socket is classified terminal, not
		// reconnected.
		conn.intentionalClose = true;
		connections.delete(conn.wsUrl);
		return;
	}
	conn.reconnectAttempts++;
	const delay = Math.min(1000 * 2 ** (conn.reconnectAttempts - 1), MAX_DELAY_MS);
	// NIT: clear any timer still armed from a previous schedule before arming a
	// new one, so a stale setTimeout can never fire a duplicate reconnect.
	if (conn.reconnectTimer) { clearTimeout(conn.reconnectTimer); }
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
		// Belt (intentionalClose) and suspenders (detach onclose below): mark this
		// a deliberate teardown so even a late/racing onclose is classified
		// terminal and cannot schedule a reconnect that would keep node --test alive.
		conn.intentionalClose = true;
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
				// Client-initiated teardown: mark the close intentional so onclose
				// (were it still attached, or if it races) classifies it terminal
				// rather than reconnecting. Detaching onclose below is the primary
				// guard; intentionalClose makes the intent explicit and no longer
				// relies on the old {1000,1005} close-code check to avoid reconnect.
				conn.intentionalClose = true;
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
		// Live getter, not a snapshot: openSocket assigns a fresh conn.ws on every
		// reconnect, so reading conn.ws here means `.connection` always reflects the
		// current socket rather than the stale (closed) one captured at subscribe
		// time. Coalesce null → undefined to match the optional `connection?: WebSocket` type.
		get connection() { return conn.ws ?? undefined; },
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
