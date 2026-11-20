// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * @aws-cdk-blocks/bb-realtime — AWS runtime.
 *
 * Used inside Lambda (resolved via `aws-runtime` condition in package.json).
 * Server-side publish() queries the connections KVStore for channel
 * subscribers and fans out via API Gateway Management API postToConnection.
 * Server-side subscribe() opens a real WebSocket connection to the API Gateway
 * endpoint for cross-invocation message delivery. getChannel() returns a
 * Transferable with connect token + channel token for client subscription.
 *
 * Registers a WebSocket event handler on the CDK Blocks handler Lambda to process
 * $connect, $disconnect, and $default (subscribe/unsubscribe/ping) events
 * inline — no separate Lambdas needed.
 */

import { Scope, registerSdkIdentifiers, getSdkIdentifiers, installClientUserAgent, isBlocksError } from '@aws-cdk-blocks/core';
import type { ScopeParent } from '@aws-cdk-blocks/core';
import type { StandardSchemaV1 } from '@standard-schema/spec';
import { EventEmitter } from 'events';
import {
	ApiGatewayManagementApiClient,
	PostToConnectionCommand,
	GoneException,
} from '@aws-sdk/client-apigatewaymanagementapi';
import { type FrameworkKey, frameworkKey } from '@aws-cdk-blocks/bb-secret/internal';
import { KVStore, KVStoreErrors } from '@aws-cdk-blocks/bb-kv-store';
import { type ConnectionRecord, connectionsTableOptions } from './connections.js';
import { BB_NAME, BB_VERSION } from './version.js';
import type {
	GetChannelOptions,
	NamespaceConfig,
	NamespaceDefs,
	RealtimeChannel,
	RealtimeSubscription,
	RealtimeServer,
	RealtimeOptions,
	SubscribeOptions,
} from './types.js';
import { RealtimeErrors } from './errors.js';
import { localListener, serverSubscribe, type ServerSubscription } from './server-subscribe.js';
import { blocksError, validateSchema, mintChannelToken, mintConnectToken, validateChannelToken, validateChannelPath, validateChannelName, resolveChannelTokenScope, validatePublishSize, validatePrincipal, validateRevokePrincipal, isClientChannelPath } from './utils.js';
import { checkSubscriptionAuth, subscriptionEndedMessage, REVOCATION_RETENTION_SECONDS } from './subscription-auth.js';
import type { SubscriptionAuthFailure } from './subscription-auth.js';

export { RealtimeErrors } from './errors.js';
export type {
	GetChannelOptions,
	NamespaceConfig,
	NamespaceDefs,
	RealtimeChannel,
	RealtimeSubscription,
	RealtimeServer,
	RealtimeOptions,
	SubscribeOptions,
	DisconnectReason,
	InferMessage,
	RealtimeChannelDescriptor,
} from './types.js';

// ── Constants (all values in seconds) ───────────────────────────────────────

const SENTINEL_SK = '__connection__';
const SENTINEL_TTL = 9000;   // 2.5 hours
const CHANNEL_TTL = 3600;    // 1 hour
const SWEEP_INTERVAL = 1800; // 30 minutes

/**
 * When a subscription record leaves the table (unix seconds). KVStore hides a record from every read once
 * its `expiresAt` has passed, so the record outlives its channel token by `CHANNEL_TTL`: the ping after the
 * token expires must still find the record, to delete it and tell the client why the subscription ended.
 */
const subscriptionExpiresAt = (now: number, tokenExp: number) => Math.max(now, tokenExp) + CHANNEL_TTL;

// Revocation records live in the same table as connections. Their partition key
// is `revoked#<principal>`, which no API Gateway connection id can equal, and
// their sort key is not a channel path a client may name (see isClientChannelPath),
// so they never mix with connection or subscription records.
const REVOKED_SK = '__revoked__';
const revocationKey = (principal: string) => ({ connectionId: `revoked#${principal}`, channel: REVOKED_SK });

// ── WebSocket event types ───────────────────────────────────────────────────

/** Minimal shape of an API Gateway WebSocket event (fields we actually use). */
interface WebSocketEvent {
	requestContext: {
		eventType: 'CONNECT' | 'DISCONNECT' | 'MESSAGE';
		connectionId: string;
		domainName: string;
		stage: string;
	};
	queryStringParameters?: { token?: string };
	body?: string;
}

/**
 * Parsed message body from a WebSocket $default route. `channel` is checked with
 * {@link isClientChannelPath} before use.
 */
interface WebSocketMessage {
	action: 'subscribe' | 'unsubscribe' | 'ping';
	channel?: unknown;
	token?: unknown;
}

/** Lambda response shape for WebSocket events. */
interface WebSocketResponse {
	statusCode: number;
}

function isWebSocketMessage(value: unknown): value is WebSocketMessage {
	if (typeof value !== 'object' || value === null) return false;
	const v = value as Record<string, unknown>;
	return v.action === 'subscribe' || v.action === 'unsubscribe' || v.action === 'ping';
}

// ── Lazy clients ────────────────────────────────────────────────────────────

const apigwClients = new Map<string, ApiGatewayManagementApiClient>();

function getApigw(endpoint?: string, customUserAgent?: [string, string][]): ApiGatewayManagementApiClient {
	const ep = endpoint || process.env.BLOCKS_RT_CALLBACK_URL;
	if (!ep) throw blocksError(RealtimeErrors.PublishFailed, 'BLOCKS_RT_CALLBACK_URL not set');
	let client = apigwClients.get(ep);
	if (!client) {
		client = new ApiGatewayManagementApiClient({
			endpoint: ep,
			...(customUserAgent ? { customUserAgent } : {}),
		});
		installClientUserAgent(client);
		apigwClients.set(ep, client);
	}
	return client;
}

// ── Connections KVStore instance ────────────────────────────────────────────

let _connectionsTable: KVStore<
	ConnectionRecord,
	ConnectionRecord,
	(typeof connectionsTableOptions)['key'],
	(typeof connectionsTableOptions)['indexes']
> | null = null;

function connectionsTable() {
	if (!_connectionsTable) throw blocksError(RealtimeErrors.PublishFailed, 'Connections table not initialized');
	return _connectionsTable;
}

// ── Token secret via frameworkKey ────────────────────────────────────────────

let _tokenSecret: FrameworkKey | null = null;
let cachedSecret: string | null = null;
let secretPromise: Promise<string> | null = null;

/**
 * The token secret, read once per container and then cached. Concurrent callers
 * share one in-flight read. A failed read is NOT cached: the in-flight promise
 * is cleared on rejection, so a transient failure at cold start (throttling, a
 * network blip, IAM still propagating) is retried by the next caller instead of
 * breaking the container for its lifetime.
 */
async function getTokenSecret(): Promise<string> {
	if (cachedSecret) return cachedSecret;
	if (secretPromise) return secretPromise;
	if (!_tokenSecret) throw blocksError(RealtimeErrors.ConnectionFailed, 'Token secret not initialized');
	const pending = _tokenSecret.get().then(
		(value) => {
			cachedSecret = value;
			return value;
		},
		(err: unknown) => {
			if (secretPromise === pending) secretPromise = null;
			throw err;
		},
	);
	secretPromise = pending;
	return pending;
}

/** {@link getTokenSecret}, resolving to `null` instead of rejecting (e.g. during codegen). */
function getTokenSecretOrNull(): Promise<string | null> {
	return getTokenSecret().catch(() => null);
}

// ── Connections table helpers ───────────────────────────────────────────────

/** The subscription records for `channel` (the `channel-index` projection carries whole records). */
async function queryConnectionsByChannel(channel: string): Promise<ConnectionRecord[]> {
	const table = connectionsTable();
	return Array.fromAsync(
		table.query({ index: 'channel-index', where: { channel: { equals: channel } } }),
		(entry) => entry.value,
	);
}

/**
 * Delete a subscription record that has ended. The delete is conditional on the record still carrying the
 * `tokenId` it was read with, so a subscription renewed in the meantime (same channel, new token) is kept.
 * A failed condition is ignored.
 */
async function deleteEndedSubscription(record: ConnectionRecord): Promise<void> {
	const key = { connectionId: record.connectionId, channel: record.channel };
	try {
		await connectionsTable().delete(key, record.tokenId === undefined ? undefined : { ifFieldEquals: { tokenId: record.tokenId } });
	} catch (err: unknown) {
		if (!isBlocksError(err, KVStoreErrors.ConditionalCheckFailed)) throw err;
	}
}

/**
 * The subscription records that may still receive a message: those whose channel token has not expired and
 * whose principal's access has not been revoked since the token was issued. Ended records are skipped but
 * not deleted: the connection's next ping deletes them and tells the client why each one ended
 * (`token_expired` / `access_revoked`), which a deletion here would pre-empt.
 * This enforces expiry and revocation at fan-out, so a client that never pings is cut off as well
 * (DynamoDB TTL deletion is lazy and queries still return expired items).
 */
async function liveSubscriptions(records: ConnectionRecord[], now: number): Promise<ConnectionRecord[]> {
	// A record without token details predates them; it can't be checked, so it ends.
	const checkable = records.filter(r => r.tokenExp !== undefined && r.tokenIat !== undefined);
	const principals = [...new Set(checkable.flatMap(r => (r.principal === undefined ? [] : [r.principal])))];
	const revokedAtByPrincipal = new Map<string, number>();
	if (principals.length > 0) {
		const found = await connectionsTable().getBatch(principals.map(revocationKey));
		found.forEach((record, i) => { if (record?.revokedAt !== undefined) revokedAtByPrincipal.set(principals[i], record.revokedAt); });
	}
	return records.filter(record => record.tokenExp !== undefined && record.tokenIat !== undefined
		&& record.tokenExp >= now
		&& !(record.principal !== undefined && revokedAtByPrincipal.has(record.principal) && record.tokenIat <= revokedAtByPrincipal.get(record.principal)!));
}

async function deleteConnectionRecords(connectionId: string): Promise<void> {
	const table = connectionsTable();
	const records = await Array.fromAsync(table.query({
		where: { connectionId: { equals: connectionId } },
	}));
	const keys = records.map(r => r.key);
	if (keys.length > 0) {
		await table.deleteBatch(keys);
	}
}

/** When access for `principal` was last revoked (unix seconds), or `undefined` if it never was (or the record has aged out). */
async function getRevokedAt(principal: string | undefined, options?: { consistentRead?: boolean }): Promise<number | undefined> {
	if (principal === undefined) return undefined;
	const record = await connectionsTable().get(revocationKey(principal), options);
	return record?.revokedAt;
}

/** Tell a client its subscription ended and why. A connection that is already gone is ignored. */
async function notifySubscriptionEnded(callbackUrl: string, connectionId: string, channel: string, failure: SubscriptionAuthFailure): Promise<void> {
	try {
		await getApigw(callbackUrl).send(new PostToConnectionCommand({
			ConnectionId: connectionId,
			Data: JSON.stringify({ type: 'error', channel, code: failure, message: subscriptionEndedMessage(failure) }),
		}));
	} catch (err: any) {
		if (!(err instanceof GoneException || err?.statusCode === 410)) {
			console.warn(`[Realtime] could not notify connection ${connectionId}: ${err?.message ?? err}`);
		}
	}
}

// ── WebSocket event handler (runs inside CDK Blocks handler Lambda) ────────────────

async function handleWebSocketEvent(event: any): Promise<any> {
	const { requestContext, queryStringParameters, body } = event as WebSocketEvent;
	const { eventType, connectionId, domainName, stage } = requestContext;
	const now = Math.floor(Date.now() / 1000);
	const table = connectionsTable();


	if (eventType === 'CONNECT') {
		const token = queryStringParameters?.token;
		if (!token) return { statusCode: 403 };
		const secret = await getTokenSecret();
		const valid = validateChannelToken(token, secret);
		if (!valid) return { statusCode: 403 };
		// A connect token minted before the principal's access was revoked is refused.
		// Consistent read: a handle used right after `revokeAccess()` must see the revocation.
		const revokedAt = await getRevokedAt(valid.sub, { consistentRead: true });
		if (revokedAt !== undefined && valid.iat <= revokedAt) return { statusCode: 403 };
		await table.put({ connectionId, channel: SENTINEL_SK }, {
			connectedAt: now, expiresAt: now + SENTINEL_TTL, lastTtlSweep: now,
			...(valid.sub === undefined ? {} : { principal: valid.sub }),
		});
		return { statusCode: 200 };
	}

	if (eventType === 'DISCONNECT') {
		await deleteConnectionRecords(connectionId);
		return { statusCode: 200 };
	}

	// MESSAGE ($default route)
	let parsed: unknown;
	try { parsed = JSON.parse(body ?? ''); } catch { return { statusCode: 200 }; }
	if (!isWebSocketMessage(parsed)) return { statusCode: 200 };
	const msg = parsed;

	const callbackUrl = `https://${domainName}/${stage}`;

	if ((msg.action === 'subscribe' || msg.action === 'unsubscribe') && !isClientChannelPath(msg.channel)) {
		if (msg.action === 'subscribe') {
			await getApigw(callbackUrl).send(new PostToConnectionCommand({
				ConnectionId: connectionId,
				Data: JSON.stringify({ type: 'error', message: 'Invalid channel' }),
			}));
		}
		return { statusCode: 200 };
	}

	if (msg.action === 'subscribe' && isClientChannelPath(msg.channel)) {
		if (typeof msg.token !== 'string' || !msg.token) {
			// Same reply as the local WebSocket server (ws-server.ts).
			await getApigw(callbackUrl).send(new PostToConnectionCommand({
				ConnectionId: connectionId,
				Data: JSON.stringify({ type: 'error', channel: msg.channel, message: 'Unauthorized: missing token' }),
			}));
			return { statusCode: 200 };
		}
		const secret = await getTokenSecret();
		// The connection's principal comes from its connect token (stored at $connect).
		// A connection with no record (never connected, or aged out) authorizes nothing.
		// Consistent read: the client subscribes as soon as the socket opens, right after `$connect` wrote the sentinel.
		const sentinel = await table.get({ connectionId, channel: SENTINEL_SK }, { consistentRead: true });
		const valid = sentinel ? validateChannelToken(msg.token, secret, msg.channel, { principal: sentinel.principal }) : null;
		if (!valid) {
			await getApigw(callbackUrl).send(new PostToConnectionCommand({
				ConnectionId: connectionId,
				Data: JSON.stringify({ type: 'error', channel: msg.channel, message: 'Unauthorized: invalid or expired token' }),
			}));
			return { statusCode: 200 };
		}
		const revokedAt = await getRevokedAt(valid.sub, { consistentRead: true });
		if (revokedAt !== undefined && valid.iat <= revokedAt) {
			await notifySubscriptionEnded(callbackUrl, connectionId, msg.channel, 'access_revoked');
			return { statusCode: 200 };
		}
		// Keep what a ping needs to re-check this subscription later (see `checkSubscriptionAuth`).
		await table.put({ connectionId, channel: msg.channel }, {
			expiresAt: subscriptionExpiresAt(now, valid.exp),
			tokenExp: valid.exp, tokenIat: valid.iat, tokenId: valid.jti,
			...(valid.sub === undefined ? {} : { principal: valid.sub }),
		});
		await getApigw(callbackUrl).send(new PostToConnectionCommand({
			ConnectionId: connectionId,
			Data: JSON.stringify({ type: 'subscribe_success', channel: msg.channel }),
		}));
	} else if (msg.action === 'unsubscribe' && isClientChannelPath(msg.channel)) {
		await table.delete({ connectionId, channel: msg.channel });
	} else if (msg.action === 'ping') {
		// Get sentinel to read lastTtlSweep, then update TTL
		const sentinelKey = { connectionId, channel: SENTINEL_SK };
		const sentinel = await table.get(sentinelKey);
		if (sentinel) {
			await table.put(sentinelKey, { ...sentinel, expiresAt: now + SENTINEL_TTL });
			// Re-check every subscription against its token: a subscription ends when
			// the token expired, the principal no longer matches the connection's, or
			// access for the principal was revoked.
			const revokedAt = await getRevokedAt(sentinel.principal);
			const records = (await Array.fromAsync(
				table.query({ where: { connectionId: { equals: connectionId } } }),
				(entry) => entry.value,
			)).filter(r => r.channel !== SENTINEL_SK);
			const ended: { record: ConnectionRecord; failure: SubscriptionAuthFailure }[] = [];
			const live: ConnectionRecord[] = [];
			for (const record of records) {
				// A record without token details predates them; it can't be re-checked, so it ends.
				const failure = record.tokenExp === undefined || record.tokenIat === undefined
					? 'token_expired'
					: checkSubscriptionAuth({ tokenExp: record.tokenExp, tokenIat: record.tokenIat, principal: record.principal }, sentinel.principal, revokedAt, now);
				if (failure) ended.push({ record, failure });
				else live.push(record);
			}
			if (ended.length > 0) {
				await Promise.all(ended.map(({ record }) => deleteEndedSubscription(record)));
				await Promise.all(ended.map(({ record, failure }) => notifySubscriptionEnded(callbackUrl, connectionId, record.channel, failure)));
			}
			const lastSweep = sentinel.lastTtlSweep ?? 0;
			if (now - lastSweep > SWEEP_INTERVAL) {
				// Sweep: refresh TTLs on all channel subscriptions that remain
				if (live.length > 0) {
					await table.putBatch(live.map(r => ({
						key: { connectionId: r.connectionId, channel: r.channel },
						value: { ...r, expiresAt: subscriptionExpiresAt(now, r.tokenExp ?? now) },
					})));
				}
				await table.put(sentinelKey, { ...sentinel, expiresAt: now + SENTINEL_TTL, lastTtlSweep: now });
			}
		}
	}

	return { statusCode: 200 };
}


// ── Realtime ────────────────────────────────────────────────────────────────

/**
 * Real-time pub/sub messaging backed by API Gateway WebSocket + DynamoDB.
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
 * - A channel handle also opens the channel's `/`-separated sub-channels by default;
 *   pass `{ scope: 'exact' }` to `getChannel()` when a sub-channel can belong to someone else
 * - Keep message payloads small — large payloads increase latency and cost
 * - Return channel handles from API methods for seamless client hydration
 *
 * **Scaling:** WebSocket connections managed by API Gateway. Automatic scaling.
 * $1.00 per million messages. Fan-out cost is proportional to subscriber count.
 * DynamoDB connections table uses on-demand billing (~$0 for typical workloads).
 */
export const Realtime: {
	new <T extends NamespaceDefs>(scope: ScopeParent, id: string, options: RealtimeOptions<T>): Scope & RealtimeServer<T>;
	namespace<M>(schema: StandardSchemaV1<M>): NamespaceConfig<M>;
} = class Realtime extends Scope {
	private _namespaces: Map<string, { schema: StandardSchemaV1<any>; prefix: string }>;
	private _localEmitter = new EventEmitter();
	private _customUserAgent: [string, string][];

	constructor(scope: ScopeParent, id: string, options: RealtimeOptions<NamespaceDefs>) {
		super(id, { parent: scope, bbName: BB_NAME, bbVersion: BB_VERSION });

		this._customUserAgent = this.buildUserAgentChain();
		this.registerClientMiddleware('@aws-cdk-blocks/bb-realtime/aws-middleware');
		this.registerLambdaEventHandler('blocks.websocket', this.fullId, handleWebSocketEvent);

		const wsUrl = process.env.BLOCKS_RT_WS_URL ?? '';
		const callbackUrl = process.env.BLOCKS_RT_CALLBACK_URL ?? '';
		registerSdkIdentifiers(this.fullId, { wsUrl, callbackUrl });

		// Initialize the connections KVStore for connection tracking (shared across instances)
		if (!_connectionsTable) {
			_connectionsTable = new KVStore(this, 'connections', connectionsTableOptions);
		}

		// Initialize the token secret via frameworkKey (shared across instances).
		// Same scope path as the CDK layer, so both derive the same names.
		if (!_tokenSecret) {
			_tokenSecret = frameworkKey(this, 'token-secret');
		}

		if (!wsUrl) {
			console.warn(`[Realtime] BLOCKS_RT_WS_URL not set — getChannel() will return incomplete descriptors`);
		}

		// Pre-warm secret fetch. A failure is ignored here (e.g. codegen, where the
		// store is unreachable) and retried by the next read, which treats null as
		// "secret unavailable" and fails explicitly.
		void getTokenSecretOrNull();

		this._namespaces = new Map();
		for (const [name, config] of Object.entries(options.namespaces)) {
			this._namespaces.set(name, { schema: config.schema, prefix: `${this.fullId}/${name}` });
		}
	}

	private _ns(namespace: string) {
		const ns = this._namespaces.get(namespace);
		if (!ns) throw blocksError('InvalidNamespace', `Unknown namespace: ${namespace}`);
		return ns;
	}

	async publish(namespace: string, channel: string, data: unknown): Promise<void> {
		const ns = this._ns(namespace);
		validateChannelName(channel);
		await validateSchema(ns.schema, data);
		const fullChannel = `${ns.prefix}/${channel}`;
		validateChannelPath(fullChannel);
		validatePublishSize(fullChannel, data);
		const message = JSON.stringify({ type: 'message', channel: fullChannel, data });

		const connectionIds = (await liveSubscriptions(await queryConnectionsByChannel(fullChannel), Math.floor(Date.now() / 1000)))
			.map(r => r.connectionId);
		const client = getApigw(undefined, this._customUserAgent);

		await Promise.all(connectionIds.map(async (connectionId) => {
			try {
				await client.send(new PostToConnectionCommand({
					ConnectionId: connectionId,
					Data: message,
				}));
			} catch (err: any) {
				if (err instanceof GoneException || err.statusCode === 410) {
					await deleteConnectionRecords(connectionId).catch(() => {});
				} else {
					console.warn(`[Realtime] publish delivery failed for connection ${connectionId}: ${err.message ?? err}`);
				}
			}
		}));

		this._localEmitter.emit(fullChannel, data);
	}

	subscribe(namespace: string, channel: string, handler: (message: unknown) => void): () => void {
		const ns = this._ns(namespace);
		validateChannelName(channel);
		const fullChannel = `${ns.prefix}/${channel}`;
		validateChannelPath(fullChannel);
		// Real WebSocket for cross-invocation publish (established once secret resolves)
		let wsSub: ServerSubscription | null = null;
		// Local EventEmitter for same-invocation publish, until the socket is live
		// (see server-subscribe.ts), so each message reaches the handler once.
		const local = localListener(handler, () => wsSub);
		this._localEmitter.on(fullChannel, local);
		const { wsUrl } = getSdkIdentifiers(this);
		if (wsUrl) {
			const fullId = this.fullId;
			getTokenSecretOrNull().then(secret => {
				if (!secret) return; // secret store unavailable (e.g., codegen)
				// Never leaves the server and only subscribes to fullChannel, so scope it exactly.
				const channelToken = mintChannelToken(fullChannel, secret, undefined, 'exact');
				const connectToken = mintConnectToken(fullId, secret);
				wsSub = serverSubscribe(wsUrl, connectToken, fullChannel, channelToken, handler);
			}).catch(() => {});
		}
		return () => {
			this._localEmitter.off(fullChannel, local);
			if (wsSub) wsSub.unsubscribe();
		};
	}

	async getChannel(namespace: string, channel: string, options?: GetChannelOptions): Promise<RealtimeChannel<unknown>> {
		const ns = this._ns(namespace);
		const tokenScope = resolveChannelTokenScope(options);
		const principal = options?.principal;
		validatePrincipal(principal);
		validateChannelName(channel);
		const fullChannel = `${ns.prefix}/${channel}`;
		validateChannelPath(fullChannel);
		const secret = await getTokenSecretOrNull();
		if (!secret) {
			throw blocksError(RealtimeErrors.ConnectionFailed, 'Token secret unavailable — cannot issue channel credentials');
		}
		const channelToken = mintChannelToken(fullChannel, secret, undefined, tokenScope, principal);
		const connectToken = mintConnectToken(this.fullId, secret, undefined, principal);
		const wsUrl = getSdkIdentifiers(this).wsUrl;
		const localEmitter = this._localEmitter;

		return {
			subscribe(handlerOrOptions: ((message: unknown) => void) | SubscribeOptions, _options?: never): RealtimeSubscription {
				const handler = typeof handlerOrOptions === 'function' ? handlerOrOptions : handlerOrOptions.onMessage;
				const onDisconnect = typeof handlerOrOptions === 'function' ? undefined : handlerOrOptions.onDisconnect;
				// Real WebSocket for cross-invocation publish
				const sub = serverSubscribe(wsUrl, connectToken, fullChannel, channelToken, handler, onDisconnect);
				// Local EventEmitter for same-invocation publish, until the socket is
				// live (see server-subscribe.ts), so each message reaches the handler once.
				const local = localListener(handler, () => sub);
				localEmitter.on(fullChannel, local);
				return {
					unsubscribe() {
						localEmitter.off(fullChannel, local);
						sub.unsubscribe();
					},
					established: sub.established,
					connection: sub.connection,
				};
			},
			toJSON() {
				return {
					__blocks: 'realtime/channel' as const,
					channel: fullChannel,
					wsUrl,
					connectToken,
					token: channelToken,
				};
			},
		};
	}

	async revokeAccess(principal: string): Promise<void> {
		// validatePrincipal() allows undefined (valid for getChannel()), so the shared helper rejects it separately.
		validateRevokePrincipal(principal);
		const now = Math.floor(Date.now() / 1000);
		await connectionsTable().put(revocationKey(principal), { revokedAt: now, expiresAt: now + REVOCATION_RETENTION_SECONDS });
	}

	static namespace<M>(schema: StandardSchemaV1<M>): NamespaceConfig<M> {
		return { schema };
	}
} as any;
