// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * @aws-cdk-blocks/bb-realtime — Canonical types.
 *
 * Single source of truth for all Realtime types. Re-exported by each
 * implementation file (mock, AWS, CDK) and consumed by middleware.
 */

import type { StandardSchemaV1 } from '@standard-schema/spec';
import type { ChildLogger } from '@aws-cdk-blocks/bb-logger';

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
	/** Called when the connection is closed for any reason, including user-initiated `unsubscribe()` (reason: `'client'`). Also fires with reason `'error'` when the server REJECTS a subscribe — whether the initial subscribe (e.g. a bad/expired channel token, alongside the rejected `established` promise) or a resubscribe after a reconnect (a stale replayed token) — because a rejected channel is effectively "gone" and is surfaced rather than dropped silently. When a `refresh()` fails during a reconnect it likewise fires with reason `'error'`: once per failed reconnect attempt, plus once more when retries are exhausted and the connection gives up (e.g. an original drop + 5 failed attempts + 1 give-up surfaces 7 `'error'` events). An app that COUNTS `'error'` events (rather than treating any as "connection unhealthy") should expect this fan-out; it is harmless for `useChat`/`createChat`, whose `armFailsafe` is idempotent and re-armed by any later chunk. Filter by reason to handle only unexpected drops. */
	onDisconnect?: (reason: DisconnectReason) => void;
	/** Called after the transport transparently reconnects and THIS channel's resubscribe has been re-confirmed by the server (with its stored token replayed). Fires once per successful reconnect for this channel, after the corresponding `onDisconnect` for the drop that triggered it. Not called on the initial subscribe. Routed per-channel: if this channel's resubscribe is rejected (e.g. its replayed token expired), `onReconnect` does NOT fire for it — it receives `onDisconnect('error')` instead; and a sibling channel's rejection never reaches this channel. Applies to client-side (hydrated) subscriptions only — a server-side `subscribe()` has no transport reconnect, so an `onReconnect` passed to a server-obtained handle is never fired. */
	onReconnect?: () => void;
	/** Called before each reconnect to obtain a freshly-minted channel descriptor (new connect + channel token) so the subscription can outlive the token TTLs (channel ~1h / connect ~2h). Without it, a reconnect replays the original tokens and will fail once they expire. Not called on the initial subscribe. Note: `refresh` is registered per-channel — a connection multiplexing several channels keeps each channel's own refresher and re-mints every live channel's token on reconnect (the instance-scoped connect token is taken from any one of them). A channel whose refresh fails falls back to its stored token. It is also called, outside a reconnect, when the server ends a live subscription because its channel token expired (the server re-checks on every keep-alive ping): the channel then subscribes again on the same socket with the fresh token, without `onDisconnect` or `onReconnect`. Messages published between the server ending the subscription and the renewal completing are not delivered to that channel. */
	refresh?: () => Promise<RealtimeChannelDescriptor>;
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
	/** The underlying WebSocket connection shared across subscriptions to the same endpoint. Only present on client-side subscriptions. Implemented as a live getter, so it always reflects the current socket: after a transparent reconnect it returns the fresh socket rather than the closed one captured at subscribe time. */
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
	 * @param channel - Dynamic channel name (e.g., `room-123`). `/` separates
	 *   segments (`tenants/acme/billing`). A name that is empty, starts or ends
	 *   with `/`, contains an empty segment (`a//b`), or has a `.` or `..` segment
	 *   is rejected. The same rule applies to `subscribe()` and `getChannel()`.
	 * @param data - The payload to broadcast. Validated against the namespace schema.
	 * @throws {RealtimeErrors.ValidationFailed} If the data fails schema validation.
	 * @throws {RealtimeErrors.ValidationFailed} If `channel` is not a valid channel name.
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
	 * @param options - Optional. `scope` decides which channels the handle's token
	 *   authorizes. The default, `'subtree'`, authorizes `channel` and every
	 *   `/`-separated sub-channel under it (a handle for `tenants/acme` also opens
	 *   `tenants/acme/billing`). Pass `{ scope: 'exact' }` to authorize `channel` only.
	 * @returns A `RealtimeChannel<T>` Transferable.
	 * @throws {RealtimeErrors.ValidationFailed} If `channel` is not a valid channel name (see {@link RealtimeServer.publish}).
	 *
	 * @example
	 * ```typescript
	 * // One tenant's handle must not open another channel under it:
	 * return rt.getChannel('events', `tenants/${tenantId}`, { scope: 'exact' });
	 * ```
	 */
	getChannel<K extends string & keyof T>(namespace: K, channel: string, options?: GetChannelOptions): Promise<RealtimeChannel<InferMessage<T[K]>>>;

	/**
	 * End a user's access to channels: every handle minted for `principal` (see
	 * {@link GetChannelOptions.principal}) before this call stops working.
	 * Subscriptions that are already open stop receiving messages published after
	 * this call, and the client is told through `onDisconnect('error')` on the
	 * connection's next keep-alive ping (within about 9 minutes). New subscribes
	 * and connections made with an older handle are refused straight away.
	 * Handles minted after this call work, so the app's `refresh` endpoint must
	 * also refuse the revoked user.
	 * A handle minted in the same second as the call counts as older.
	 *
	 * The record is kept for as long as the longest token lives (about 2 hours).
	 * Handles minted without a `principal` can't be revoked; they expire after
	 * about an hour.
	 *
	 * @param principal - The user id passed to `getChannel()`.
	 * @throws {RealtimeErrors.ValidationFailed} If `principal` is not a non-empty string of at most 256 characters.
	 */
	revokeAccess(principal: string): Promise<void>;
}

// ── Options ─────────────────────────────────────────────────────────────────

/** Options for `getChannel()`. */
export interface GetChannelOptions {
	/**
	 * Which channels the returned handle's token authorizes a client to subscribe to.
	 *
	 * - `'subtree'` (default): the channel and every `/`-separated sub-channel
	 *   under it. A handle for `tenants/acme` also opens `tenants/acme/billing`.
	 * - `'exact'`: the channel only.
	 *
	 * Use `'exact'` whenever a sub-channel of the name can belong to someone else,
	 * for example per-tenant or per-user channels nested under one another.
	 *
	 * @defaultValue 'subtree'
	 */
	scope?: 'exact' | 'subtree';

	/**
	 * The signed-in user (an id such as the session's `userSub`) this handle is
	 * for. The id is signed into the handle's connect and channel tokens, and the
	 * server accepts a channel token only on a connection opened with a connect
	 * token for the same user, so binding keeps a channel token from being used
	 * on a connection opened for another user or for no user. The handle as a
	 * whole is still a bearer credential until it expires or `revokeAccess()` is
	 * called, so treat it like a session token. Pass it
	 * whenever the channel belongs to a user, and use the same id with
	 * `revokeAccess()`. At most 256 characters.
	 *
	 * Leave it out only for channels any holder of the handle may read.
	 */
	principal?: string;
}

export interface RealtimeOptions<T extends NamespaceDefs> {
	/** Namespace definitions. */
	namespaces: T;
	/** Optional logger for internal operations. When omitted, a default Logger at error level is created. */
	logger?: ChildLogger;
}
