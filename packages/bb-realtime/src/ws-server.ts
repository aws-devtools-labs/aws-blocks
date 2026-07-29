// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * WebSocket server for local development.
 * Bridges server-side Realtime publish to browser clients.
 * Validates channel tokens on subscribe (mirrors AWS Lambda authorizer).
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

let wss: WebSocketServer | null = null;
const clients = new Map<WebSocket, ClientSubscription>();

export function attach(httpServer: Server) {
	if (wss) return; // Already attached — multiple BBs may register the same dev attachment
	wss = new WebSocketServer({ noServer: true });

	// Only handle /realtime upgrades — ignore all others so HMR (Next.js, Vite)
	// WebSocket upgrades pass through to the frontend proxy unharmed.
	httpServer.on('upgrade', (req, socket, head) => {
		const pathname = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`).pathname;
		if (pathname !== '/realtime') return;
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
				} else if (msg.action === 'publish' && msg.channel && msg.payload !== undefined) {
					const outMsg = JSON.stringify({ type: 'message', channel: msg.channel, data: msg.payload });
					for (const [otherWs, otherSub] of clients) {
						if (otherWs !== ws && otherSub.channels.has(msg.channel) && otherWs.readyState === WebSocket.OPEN) {
							otherWs.send(outMsg);
						}
					}
				}
			} catch (e) {
				console.error('[Realtime WS] Invalid message:', e);
			}
		});

		ws.on('close', () => { clients.delete(ws); });
		ws.on('error', () => { clients.delete(ws); });
	});

	localRealtimeBus.on('broadcast', ({ channel, payload }) => {
		const message = JSON.stringify({ type: 'message', channel, data: payload });
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
