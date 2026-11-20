// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * WebSocket server for local development.
 * Bridges server-side Realtime publish to browser clients.
 * Validates channel tokens on subscribe (mirrors AWS Lambda authorizer).
 * Accepts the same client actions as the deployed handler — subscribe,
 * unsubscribe, ping — and refuses cross-site upgrades by Origin.
 */

import { WebSocketServer, WebSocket } from 'ws';
import type { Server } from 'node:http';
import { EventEmitter } from 'events';
import { setBroadcastBus, getRevokedAt, LOCAL_TOKEN_SECRET } from './local-dev.js';
import { isClientChannelPath, validateChannelToken } from './utils.js';
import { checkSubscriptionAuth, subscriptionEndedMessage } from './subscription-auth.js';
import type { SubscriptionAuth } from './subscription-auth.js';
import { isLoopbackHost, isWildcardHost, isIpLiteral } from '@aws-cdk-blocks/core/bb-utils';

export const localRealtimeBus = new EventEmitter();
localRealtimeBus.setMaxListeners(1000);

interface ClientSubscription {
	ws: WebSocket;
	/** Subscribed channels, each with what is kept of the token it was authorized with. */
	channels: Map<string, SubscriptionAuth>;
	/** The principal the connection's connect token is bound to; `undefined` when the connection carries none. */
	principal: string | undefined;
}

/**
 * Re-check every subscription on a connection against its token (see
 * `checkSubscriptionAuth`), ending and announcing the ones that fail. Runs on a
 * client ping and when access is revoked, as the deployed handler does on a ping.
 */
function revalidateSubscriptions(client: ClientSubscription): void {
	const now = Math.floor(Date.now() / 1000);
	const revokedAt = getRevokedAt(client.principal);
	for (const [channel, auth] of client.channels) {
		const failure = checkSubscriptionAuth(auth, client.principal, revokedAt, now);
		if (!failure) continue;
		client.channels.delete(channel);
		if (client.ws.readyState === WebSocket.OPEN) {
			client.ws.send(JSON.stringify({ type: 'error', channel, code: failure, message: subscriptionEndedMessage(failure) }));
		}
	}
}

/**
 * Read the principal from the connect token in the upgrade URL's `token` query
 * parameter, as `$connect` does on AWS. A connection without a token carries no
 * principal (local dev skips connect-time auth). Returns `null` when a token is
 * present but not valid, or was minted before the principal's access was revoked.
 */
function connectionPrincipal(url: string | undefined): { principal: string | undefined } | null {
	const token = new URL(url || '/', 'http://localhost').searchParams.get('token');
	if (token === null) return { principal: undefined };
	const valid = validateChannelToken(token, LOCAL_TOKEN_SECRET);
	if (!valid) return null;
	const revokedAt = getRevokedAt(valid.sub);
	if (revokedAt !== undefined && valid.iat <= revokedAt) return null;
	return { principal: valid.sub };
}

/**
 * Whether a WebSocket upgrade's `Origin` may connect. WebSocket handshakes are
 * exempt from CORS, so without this any page the developer visits could open
 * `ws://localhost:3000/realtime` (cross-site WebSocket hijacking). Allowed:
 *
 * - no `Origin` header — non-browser clients (Node `ws`, CLI tools); browsers
 *   always send one on a WebSocket handshake, so this admits no web page;
 * - a loopback origin — `localhost`, `127.x.x.x`, `[::1]` on any port (the dev
 *   server's front door and the frontend dev server);
 * - the concrete dev host the developer opted into via `BLOCKS_DEV_HOST`
 *   (e.g. `mybox.example.com`);
 * - with a WILDCARD opt-in (`BLOCKS_DEV_HOST=0.0.0.0` / `::`), a same-origin
 *   page reached by IP address: the Origin's hostname equals the `Host` the
 *   client connected to AND is an IP literal. A browser reaching a container or
 *   devbox by its address sends exactly that. DNS names are deliberately not
 *   accepted here — a same-origin check against a name is defeated by DNS
 *   rebinding (`evil.example` re-pointed at this machine sends a matching
 *   Origin and Host); to use a name, set `BLOCKS_DEV_HOST` to it.
 *
 * Loopback/wildcard/IP classification is shared with the dev server's bind
 * decision (`@aws-cdk-blocks/core/bb-utils`), so the two can't drift apart.
 */
export function isAllowedUpgradeOrigin(
	origin: string | undefined,
	devHost: string | undefined = process.env.BLOCKS_DEV_HOST,
	requestHost?: string,
): boolean {
	if (origin === undefined) return true;
	let hostname: string;
	try {
		hostname = new URL(origin).hostname;
	} catch {
		return false;
	}
	if (isLoopbackHost(hostname)) return true;
	const optIn = devHost?.trim();
	if (!optIn) return false;
	// URL hostnames keep IPv6 brackets (`[fd00::1]`); a BLOCKS_DEV_HOST may omit them.
	if (!isWildcardHost(optIn)) return unbracket(hostname) === unbracket(optIn);
	if (!requestHost || !isIpLiteral(hostname)) return false;
	let connectedHost: string;
	try {
		connectedHost = new URL(`http://${requestHost}`).hostname;
	} catch {
		return false;
	}
	return connectedHost === hostname;
}

/** Lowercase and strip IPv6 brackets (`[FD00::1]` → `fd00::1`). */
function unbracket(host: string): string {
	return host.replace(/^\[|\]$/g, '').toLowerCase();
}

let wss: WebSocketServer | null = null;
const clients = new Map<WebSocket, ClientSubscription>();

export function attach(httpServer: Server) {
	if (wss) return; // Already attached — multiple BBs may register the same dev attachment
	wss = new WebSocketServer({ noServer: true });

	// Server-level WS errors must be logged, never left to crash the dev process.
	wss.on('error', (err) => { console.error('[Realtime WS] Server error:', err); });

	// Only handle /realtime upgrades — ignore all others so HMR (Next.js, Vite)
	// WebSocket upgrades pass through to the frontend proxy unharmed.
	httpServer.on('upgrade', (req, socket, head) => {
		// A client resetting the connection during the upgrade window (ECONNRESET)
		// emits 'error' on the raw socket. Without this listener Node's default
		// unhandled-error behaviour tears down the whole dev server process.
		socket.on('error', () => socket.destroy());
		const pathname = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`).pathname;
		if (pathname !== '/realtime') return;
		if (!isAllowedUpgradeOrigin(req.headers.origin, process.env.BLOCKS_DEV_HOST, req.headers.host)) {
			socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
			return;
		}
		if (!connectionPrincipal(req.url)) {
			socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
			return;
		}
		wss!.handleUpgrade(req, socket, head, (ws) => wss!.emit('connection', ws, req));
	});

	wss.on('connection', (ws, req) => {
		const subscription: ClientSubscription = { ws, channels: new Map(), principal: connectionPrincipal(req.url)?.principal };
		clients.set(ws, subscription);

		ws.on('message', (data) => {
			try {
				const msg = JSON.parse(data.toString());
				// Same channel check as the deployed handler (index.aws.ts).
				if ((msg.action === 'subscribe' || msg.action === 'unsubscribe') && !isClientChannelPath(msg.channel)) {
					if (msg.action === 'subscribe') ws.send(JSON.stringify({ type: 'error', message: 'Invalid channel' }));
					return;
				}
				if (msg.action === 'subscribe') {
					// Local dev skips connect-time auth, so the channel token is the only gate — require it.
					if (typeof msg.token !== 'string' || !msg.token) {
						ws.send(JSON.stringify({ type: 'error', channel: msg.channel, message: 'Unauthorized: missing token' }));
						return;
					}
					const valid = validateChannelToken(msg.token, LOCAL_TOKEN_SECRET, msg.channel, { principal: subscription.principal });
					if (!valid) {
						ws.send(JSON.stringify({ type: 'error', channel: msg.channel, message: 'Unauthorized: invalid or expired token' }));
						return;
					}
					const revokedAt = getRevokedAt(valid.sub);
					if (revokedAt !== undefined && valid.iat <= revokedAt) {
						ws.send(JSON.stringify({ type: 'error', channel: msg.channel, code: 'access_revoked', message: subscriptionEndedMessage('access_revoked') }));
						return;
					}
					subscription.channels.set(msg.channel, { tokenExp: valid.exp, tokenIat: valid.iat, principal: valid.sub });
					ws.send(JSON.stringify({ type: 'subscribe_success', channel: msg.channel }));
				} else if (msg.action === 'unsubscribe') {
					subscription.channels.delete(msg.channel);
				} else if (msg.action === 'ping') {
					revalidateSubscriptions(subscription);
				} else if (msg.action === 'publish') {
					// Parity with the deployed handler (index.aws.ts), which has no client
					// publish: publishing is server-side only (`Realtime.publish`). This arm
					// used to broadcast with no authorization, letting any connected client
					// inject payloads into any channel.
					ws.send(JSON.stringify({ type: 'error', channel: msg.channel, message: 'Client publish is not supported; publish from the server with Realtime.publish()' }));
				}
			} catch (e) {
				console.error('[Realtime WS] Invalid message:', e);
			}
		});

		ws.on('close', () => { clients.delete(ws); });
		ws.on('error', () => { clients.delete(ws); });
	});

	localRealtimeBus.on('broadcast', ({ channel, data }) => {
		const message = JSON.stringify({ type: 'message', channel, data });
		for (const [ws, sub] of clients) {
			if (sub.channels.has(channel) && ws.readyState === WebSocket.OPEN) {
				ws.send(message);
			}
		}
	});

	// `revokeAccess()` in the dev server process: end affected subscriptions now rather than on the next ping.
	localRealtimeBus.on('revoke', () => { for (const client of clients.values()) revalidateSubscriptions(client); });

	setBroadcastBus(localRealtimeBus);
}

export function closeWebSocketServer() {
	if (wss) { wss.close(); wss = null; }
	clients.clear();
}
