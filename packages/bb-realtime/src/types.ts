// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * @aws-blocks/bb-realtime — Canonical types.
 *
 * Single source of truth for all Realtime types. Re-exported by each
 * implementation file (mock, AWS, CDK) and consumed by middleware.
 */

import type { StandardSchemaV1 } from '@standard-schema/spec';
import type { ChildLogger } from '@aws-blocks/bb-logger';

// ── Namespace Types ─────────────────────────────────────────────────────────

/**
 * Configuration for a namespace. Created via `Realtime.namespace(schema)`.
 * The schema provides both the TypeScript type (via inference) and runtime
 * validation on publish.
 */
export interface NamespaceConfig<T = unknown> {
	schema: StandardSchemaV1<T>;
}

/**
 * A record of namespace names to their configurations.
 * Passed inside the options object to the `Realtime` constructor.
 */
export type NamespaceDefs = Record<string, NamespaceConfig<any>>;

/**
 * Infer the message type from a NamespaceConfig.
 */
export type InferMessage<C> = C extends NamespaceConfig<infer T> ? T : unknown;

// ── Subscription Result ─────────────────────────────────────────────────────

/** Reason the WebSocket connection was lost or closed. */
export type DisconnectReason = 'client' | 'timeout' | 'error' | 'unknown';

/** Options form for `channel.subscribe()` — use when you need disconnect handling. */
export interface SubscribeOptions<T = unknown> {
	/** Called for each incoming message. */
	onMessage: (message: T) => void;
	/** Called when the connection is closed for any reason, including user-initiated `unsubscribe()` (reason: `'client'`). Filter by reason to handle only unexpected drops. */
	onDisconnect?: (reason: DisconnectReason) => void;
}

/**
 * Returned by `subscribe()` on a client-side channel. Contains an unsubscribe
 * function and a promise that resolves when the subscription is established
 * (or rejects if the server refuses it, e.g. invalid token).
 */
export interface RealtimeSubscription {
	/** Stop receiving messages. */
	unsubscribe(): void;
	/** Resolves when the server confirms the subscription. Rejects on auth failure. */
	established: Promise<void>;
	/** The underlying WebSocket connection shared across subscriptions to the same endpoint. Only present on client-side subscriptions. */
	connection?: WebSocket;
}

// ── Channel Handle (Transferable) ───────────────────────────────────────────

/**
 * A subscribe-only channel handle. Fully functional on the server — subscribe
 * works directly. Implements the Transferable protocol via `toJSON()` so it
 * can be returned from `ApiNamespace` methods and hydrated by the client
 * middleware.
 *
 * Return this from API methods to give the client a live subscription.
 */
export interface RealtimeChannel<T = unknown> {
	/** Listen for messages on this channel. Returns a subscription handle. */
	subscribe(handler: (message: T) => void): RealtimeSubscription;
	subscribe(options: SubscribeOptions<T>): RealtimeSubscription;
	/** @internal Transferable serialization — called automatically by JSON.stringify(). */
	toJSON(): RealtimeChannelDescriptor;
}

/**
 * Wire format for a serialized channel handle. Client middleware hydrates
 * this back into a live client-side channel.
 */
export interface RealtimeChannelDescriptor {
	__blocks: 'realtime/channel';
	channel: string;
	[key: string]: unknown;
}

// ── Realtime Server Interface ───────────────────────────────────────────────

/**
 * The typed server-side Realtime interface. Methods are keyed by namespace
 * name for full type safety and autocomplete.
 */
export interface RealtimeServer<T extends NamespaceDefs> {
	/**
	 * Broadcast data to all subscribers on a channel within a namespace.
	 *
	 * Delivery is best-effort: messages are sent to all connected subscribers
	 * in parallel. If delivery to an individual connection fails (network error,
	 * throttling), the failure is logged and the remaining deliveries continue.
	 * Stale connections (410 Gone) are automatically cleaned up.
	 *
	 * @param namespace - Namespace name (type-checked from constructor).
	 * @param channel - Dynamic channel name (e.g., `room-123`).
	 * @param data - The payload to broadcast. Validated against the namespace schema.
	 * @throws {RealtimeErrors.ValidationFailed} If the data fails schema validation.
	 */
	publish<K extends string & keyof T>(namespace: K, channel: string, data: InferMessage<T[K]>): Promise<void>;

	/**
	 * Subscribe to messages on a channel within a namespace (server-side).
	 *
	 * @param namespace - Namespace name (type-checked from constructor).
	 * @param channel - Dynamic channel name.
	 * @param handler - Called for each incoming message.
	 * @returns An unsubscribe function.
	 */
	subscribe<K extends string & keyof T>(namespace: K, channel: string, handler: (message: InferMessage<T[K]>) => void): () => void;

	/**
	 * Get a channel handle (Transferable). Return this from an `ApiNamespace`
	 * method — the client middleware hydrates it into a live subscription.
	 *
	 * @param namespace - Namespace name (type-checked from constructor).
	 * @param channel - Dynamic channel name (e.g., `room-123`).
	 * @returns A `RealtimeChannel<T>` Transferable.
	 */
	getChannel<K extends string & keyof T>(namespace: K, channel: string): Promise<RealtimeChannel<InferMessage<T[K]>>>;
}

// ── Co-located publisher config (CDK) ───────────────────────────────────────

/**
 * CDK-only capability: expose this Realtime's API Gateway WebSocket callback URL so a co-located
 * Building Block whose compute runs outside the Blocks handler (e.g. the Agent BB's AgentCore
 * Runtime) can inject it as `BLOCKS_RT_CALLBACK_URL` and publish.
 *
 * Such a compute publishes AS the shared Blocks execution role, which already holds the publish
 * grants (API Gateway `postToConnection` + the connections table, both granted to the handler that
 * runs on the same role) — so no extra IAM grant is needed. The one thing it lacks is the callback
 * URL: outside the Blocks handler it can't reach the Lambda's S3 config bundle, so the endpoint must
 * be injected into its process env (`publish()` posts to it).
 *
 * Present on the type surface for all layers (the inverse of the `publish`/`subscribe`/`getChannel`
 * synth-guards) but only implemented in the CDK build; the runtime/mock builds throw.
 */
export interface RealtimePublishInfo {
	/**
	 * The API Gateway WebSocket callback URL for this Realtime's shared infrastructure. Inject as
	 * `BLOCKS_RT_CALLBACK_URL` on a co-located compute so its `publish()` can post to subscribers.
	 *
	 * CDK-synth only — throws in the runtime/mock build.
	 */
	publishCallbackUrl(): string;
}

// ── Options ─────────────────────────────────────────────────────────────────

export interface RealtimeOptions<T extends NamespaceDefs> {
	/** Namespace definitions. */
	namespaces: T;
	/** Optional logger for internal operations. When omitted, a default Logger at error level is created. */
	logger?: ChildLogger;
}
