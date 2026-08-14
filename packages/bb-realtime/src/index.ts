// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * @aws-blocks/bb-realtime — Local dev (mock) entry point.
 *
 * Provides the `Realtime` class for typed real-time pub/sub channels.
 * In local dev, uses EventEmitter for in-process pub/sub and a WebSocket
 * bridge for browser clients.
 *
 * Resolved via the `default` condition in package.json.
 */

import { Scope, registerSdkIdentifiers } from '@aws-blocks/core';
import type { ScopeParent } from '@aws-blocks/core';
import type { StandardSchemaV1 } from '@standard-schema/spec';
import { EventEmitter } from 'events';
import type {
	NamespaceConfig,
	NamespaceDefs,
	RealtimeChannel,
	RealtimeSubscription,
	RealtimeServer,
	RealtimeOptions,
	SubscribeOptions,
} from './types.js';
import { RealtimeErrors } from './errors.js';
import { blocksError, validateSchema, mintChannelToken, mintConnectToken, validateChannelPath, validatePublishSize } from './utils.js';
import { getBroadcastBus, LOCAL_TOKEN_SECRET } from './local-dev.js';
import { Logger } from '@aws-blocks/bb-logger';
import type { ChildLogger } from '@aws-blocks/bb-logger';
import { BB_NAME, BB_VERSION } from './version.js';

export { RealtimeErrors } from './errors.js';
export type {
	NamespaceConfig,
	NamespaceDefs,
	RealtimeChannel,
	RealtimeSubscription,
	RealtimeServer,
	RealtimeOptions,
	SubscribeOptions,
	DisconnectReason,
} from './types.js';

// ── Broadcast bus for WebSocket bridge ──────────────────────────────────────

const globalEmitter = new EventEmitter();
globalEmitter.setMaxListeners(1000);

// ── Realtime ────────────────────────────────────────────────────────────────

/**
 * Real-time pub/sub messaging backed by AWS AppSync Events.
 *
 * **When to use:** You need to push data from the server to connected clients
 * in real time — chat messages, live notifications, dashboard updates,
 * collaborative state sync (cursors, selections, presence).
 *
 * **When NOT to use:** If you need request-response APIs, use `ApiNamespace`.
 * If you need to send one-off notifications via email, use `Email`.
 * If you need durable message queuing with guaranteed delivery, use `AsyncJob`.
 *
 * **Best practices:**
 * - Use descriptive namespace names (`cursors`, `chat`, `notifications`)
 * - Use channels for dynamic scoping (`room-123`, `user-456`)
 * - Keep message payloads small — large payloads increase latency and cost
 * - Return channel handles from API methods for seamless client hydration
 *
 * **Scaling:** WebSocket connections managed by AppSync Events. Automatic scaling.
 * $1.00 per million operations. 200 subscriptions per connection (adjustable).
 * Message fan-out cost is proportional to subscriber count.
 *
 * @example
 * ```typescript
 * import { Realtime } from '@aws-blocks/bb-realtime';
 * import { z } from 'zod';
 *
 * const cursorSchema = z.object({ userId: z.string(), x: z.number(), y: z.number() });
 * const chatSchema = z.object({ sender: z.string(), text: z.string() });
 *
 * const rt = new Realtime(scope, 'collab', {
 *   namespaces: {
 *     cursors: Realtime.namespace(cursorSchema),
 *     chat: Realtime.namespace(chatSchema),
 *   },
 * });
 *
 * // Server-side publish
 * await rt.publish('chat', 'room-1', { sender: 'alice', text: 'hello' });
 *
 * // Return a channel handle from an API method (Transferable)
 * return rt.getChannel('chat', 'room-1');
 * ```
 */
export const Realtime: {
	new <T extends NamespaceDefs>(scope: ScopeParent, id: string, options: RealtimeOptions<T>): Scope & RealtimeServer<T>;
	namespace<M>(schema: StandardSchemaV1<M>): NamespaceConfig<M>;
} = class Realtime extends Scope {
	private _namespaces: Map<string, { schema: StandardSchemaV1<any>; prefix: string }>;

	/** @internal Logger for internal operations. Defaults to error-level when not provided. */
	protected log: ChildLogger;

	constructor(scope: ScopeParent, id: string, options: RealtimeOptions<NamespaceDefs>) {
		super(id, { parent: scope, bbName: BB_NAME, bbVersion: BB_VERSION });
		this.log = options?.logger ?? new Logger(this, 'logger', { level: 'error' });

		this.registerClientMiddleware('@aws-blocks/bb-realtime/mock-middleware');
		this.registerDevAttachment('@aws-blocks/bb-realtime/ws-server');

		this._namespaces = new Map();
		for (const [name, config] of Object.entries(options.namespaces)) {
			this._namespaces.set(name, { schema: config.schema, prefix: `${this.fullId}/${name}` });
		}
		registerSdkIdentifiers(this.fullId, { wsUrl: `mock-ws://${this.fullId}`, callbackUrl: `mock-callback://${this.fullId}` });
	}

	private _ns(namespace: string) {
		const ns = this._namespaces.get(namespace);
		if (!ns) throw blocksError('InvalidNamespace', `Unknown namespace: ${namespace}`);
		return ns;
	}

	async publish(namespace: string, channel: string, data: unknown): Promise<void> {
		const ns = this._ns(namespace);
		await validateSchema(ns.schema, data);
		const fullChannel = `${ns.prefix}/${channel}`;
		validateChannelPath(fullChannel);
		validatePublishSize(fullChannel, data);
		globalEmitter.emit(fullChannel, data);
		if (getBroadcastBus()) {
			getBroadcastBus()!.emit('broadcast', { channel: fullChannel, payload: data });
		}
	}

	subscribe(namespace: string, channel: string, handler: (message: unknown) => void): () => void {
		const ns = this._ns(namespace);
		const fullChannel = `${ns.prefix}/${channel}`;
		validateChannelPath(fullChannel);
		globalEmitter.on(fullChannel, handler);
		return () => { globalEmitter.off(fullChannel, handler); };
	}

	async getChannel(namespace: string, channel: string): Promise<RealtimeChannel<unknown>> {
		const ns = this._ns(namespace);
		const fullChannel = `${ns.prefix}/${channel}`;
		validateChannelPath(fullChannel);
		const token = mintChannelToken(fullChannel, LOCAL_TOKEN_SECRET);
		const connectToken = mintConnectToken(this.fullId, LOCAL_TOKEN_SECRET);
		return {
			subscribe(handlerOrOptions: ((message: unknown) => void) | SubscribeOptions, _options?: never): RealtimeSubscription {
				const handler = typeof handlerOrOptions === 'function' ? handlerOrOptions : handlerOrOptions.onMessage;
				globalEmitter.on(fullChannel, handler);
				return {
					unsubscribe() { globalEmitter.off(fullChannel, handler); },
					established: Promise.resolve(),
				};
			},
			toJSON() {
				return {
					__blocks: 'realtime/channel' as const,
					channel: fullChannel,
					wsUrl: (globalThis as any).__BLOCKS_REALTIME_WS_URL__,
					connectToken,
					token,
				};
			},
		};
	}

	static namespace<M>(schema: StandardSchemaV1<M>): NamespaceConfig<M> {
		return { schema };
	}
} as any;
