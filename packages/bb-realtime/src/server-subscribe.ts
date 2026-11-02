// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Server-side WebSocket subscription for the AWS runtime (internal).
 *
 * A server-side subscriber gets each message from one of two paths: the
 * in-process EventEmitter (a publish from the same process) or its WebSocket
 * (a publish from any process, delivered by API Gateway). `publish()` uses both,
 * so a subscriber in the publishing process would see the message twice.
 *
 * The subscription is the single source of truth for which path delivers:
 * - Until API Gateway acknowledges the subscription (`subscribe_success`), the
 *   socket isn't live. The in-process emitter delivers, and any message frame on
 *   the socket is dropped.
 * - Once live, the socket delivers every message (the publishing process's own
 *   connection is among the fan-out targets), and the in-process emitter skips
 *   this handler.
 * - After the socket closes or errors, it isn't live again, and the in-process
 *   emitter takes over.
 *
 * So each published message reaches the handler exactly once.
 */

import { brandBlocksError } from '@aws-blocks/core';
import type { DisconnectReason, RealtimeSubscription } from './types.js';

/** A server-side subscription, plus whether its socket currently delivers messages. */
export interface ServerSubscription extends RealtimeSubscription {
	/** True while the socket is subscribed and delivering; the in-process emitter must skip this handler then. */
	isLive(): boolean;
}

/**
 * Wrap a handler for the in-process EventEmitter so it delivers only while the
 * subscription's socket is not live. `subscription` is read at call time, so it
 * may be assigned after the listener is registered.
 */
export function localListener(
	handler: (message: unknown) => void,
	subscription: () => ServerSubscription | null,
): (message: unknown) => void {
	return (message) => {
		if (subscription()?.isLive()) return;
		handler(message);
	};
}

export function serverSubscribe(
	wsUrl: string | undefined,
	connectToken: string,
	channel: string,
	channelToken: string,
	handler: (message: unknown) => void,
	onDisconnect?: (reason: DisconnectReason) => void,
): ServerSubscription {
	if (!wsUrl) {
		const err = new Error('BLOCKS_RT_WS_URL not set — server-side subscribe unavailable');
		err.name = 'ConnectionFailedException';
		return { unsubscribe() {}, established: Promise.reject(brandBlocksError(err)), isLive: () => false };
	}

	const url = `${wsUrl}?token=${encodeURIComponent(connectToken)}`;
	const ws = new WebSocket(url);
	// See the module comment: live from the subscribe acknowledgement until close.
	let live = false;

	let resolveEstablished: () => void;
	let rejectEstablished: (err: Error) => void;
	const established = new Promise<void>((resolve, reject) => {
		resolveEstablished = resolve;
		rejectEstablished = reject;
	});

	ws.onopen = () => {
		ws.send(JSON.stringify({ action: 'subscribe', channel, token: channelToken }));
	};

	ws.onmessage = (event) => {
		try {
			const msg = JSON.parse(event.data as string);
			if (msg.type === 'subscribe_success' && msg.channel === channel) {
				live = true;
				resolveEstablished();
			} else if (msg.type === 'error' && msg.channel === channel) {
				const err = new Error(msg.message || 'Subscription rejected');
				err.name = 'ConnectionFailedException';
				rejectEstablished(brandBlocksError(err));
			} else if (msg.type === 'message' && msg.channel === channel && live) {
				try { handler(msg.data); } catch {}
			}
		} catch {}
	};

	ws.onerror = () => {
		live = false;
		const err = new Error('WebSocket error');
		err.name = 'ConnectionFailedException';
		rejectEstablished(brandBlocksError(err));
		if (onDisconnect) try { onDisconnect('error'); } catch {}
	};

	ws.onclose = (event) => {
		live = false;
		const err = new Error('WebSocket closed');
		err.name = 'ConnectionFailedException';
		rejectEstablished(brandBlocksError(err));
		if (onDisconnect) {
			const reason: DisconnectReason = event.code === 1001 ? 'timeout' : event.code === 1006 ? 'error' : 'unknown';
			try { onDisconnect(reason); } catch {}
		}
	};

	return {
		unsubscribe() {
			live = false;
			if (onDisconnect) try { onDisconnect('client'); } catch {}
			ws.onmessage = null;
			ws.onerror = null;
			ws.onclose = null;
			ws.close();
		},
		established,
		connection: ws,
		isLive: () => live,
	};
}
