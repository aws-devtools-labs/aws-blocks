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
import { setBroadcastBus, LOCAL_TOKEN_SECRET } from './local-dev.js';
import { validateChannelToken } from './utils.js';

export const localRealtimeBus = new EventEmitter();
localRealtimeBus.setMaxListeners(1000);

interface ClientSubscription {
	ws: WebSocket;
	channels: Set<string>;
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
 * - the dev host the developer explicitly opted into via `BLOCKS_DEV_HOST`
 *   (container / remote-devbox setups).
 *
 * The hostname is compared exactly, so `http://localhost.evil.example` is
 * rejected.
 */
export function isAllowedUpgradeOrigin(origin: string | undefined, devHost = process.env.BLOCKS_DEV_HOST): boolean {
	if (origin === undefined) return true;
	let hostname: string;
	try {
		hostname = new URL(origin).hostname;
	} catch {
		return false;
	}
	if (hostname === 'localhost' || hostname === '[::1]' || /^127(\.\d{1,3}){3}$/.test(hostname)) return true;
	const optIn = devHost?.trim();
	return !!optIn && hostname === optIn;
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
		if (!isAllowedUpgradeOrigin(req.headers.origin)) {
			socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
			return;
		}
		wss!.handleUpgrade(req, socket, head, (ws) => wss!.emit('connection', ws, req));
	});

	wss.on('connection', (ws) => {
		const subscription: ClientSubscription = { ws, channels: new Set() };
		clients.set(ws, subscription);

		ws.on('message', (data) => {
			try {
				const msg = JSON.parse(data.toString());
				if (msg.action === 'subscribe' && msg.channel) {
					// Local dev skips connect-time auth, so the channel token is the only gate — require it.
					if (!msg.token) {
						ws.send(JSON.stringify({ type: 'error', channel: msg.channel, message: 'Unauthorized: missing token' }));
						return;
					}
					const valid = validateChannelToken(msg.token, LOCAL_TOKEN_SECRET, msg.channel);
					if (!valid) {
						ws.send(JSON.stringify({ type: 'error', channel: msg.channel, message: 'Unauthorized: invalid or expired token' }));
						return;
					}
					subscription.channels.add(msg.channel);
					ws.send(JSON.stringify({ type: 'subscribe_success', channel: msg.channel }));
				} else if (msg.action === 'unsubscribe' && msg.channel) {
					subscription.channels.delete(msg.channel);
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

	setBroadcastBus(localRealtimeBus);
}

export function closeWebSocketServer() {
	if (wss) { wss.close(); wss = null; }
	clients.clear();
}
