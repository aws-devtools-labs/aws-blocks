// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * @aws-blocks/bb-realtime — AWS runtime.
 *
 * Used inside Lambda (resolved via `aws-runtime` condition in package.json).
 * Server-side publish() queries the connections DistributedTable for channel
 * subscribers and fans out via API Gateway Management API postToConnection.
 * Server-side subscribe() opens a real WebSocket connection to the API Gateway
 * endpoint for cross-invocation message delivery. getChannel() returns a
 * Transferable with connect token + channel token for client subscription.
 *
 * Registers a WebSocket event handler on the Blocks handler Lambda to process
 * $connect, $disconnect, and $default (subscribe/unsubscribe/ping) events
 * inline — no separate Lambdas needed.
 */

import { Scope, registerSdkIdentifiers, getSdkIdentifiers } from '@aws-blocks/core';
import type { ScopeParent } from '@aws-blocks/core';
import type { StandardSchemaV1 } from '@standard-schema/spec';
import { EventEmitter } from 'events';
import {
	ApiGatewayManagementApiClient,
	PostToConnectionCommand,
	GoneException,
} from '@aws-sdk/client-apigatewaymanagementapi';
import { AppSetting } from '@aws-blocks/bb-app-setting';
import { DistributedTable } from '@aws-blocks/bb-distributed-table';
import { BB_NAME, BB_VERSION } from './version.js';
import type {
	NamespaceConfig,
	NamespaceDefs,
	RealtimeChannel,
	RealtimeSubscription,
	RealtimeServer,
	RealtimeOptions,
	RealtimePublisherGrants,
	SubscribeOptions,
} from './types.js';
import { RealtimeErrors } from './errors.js';
import { blocksError, validateSchema, mintChannelToken, mintConnectToken, validateChannelToken, validateChannelPath, validatePublishSize } from './utils.js';

export { RealtimeErrors } from './errors.js';
export type {
	NamespaceConfig,
	NamespaceDefs,
	RealtimeChannel,
	RealtimeSubscription,
	RealtimeServer,
	RealtimeOptions,
	RealtimePublishGrant,
	RealtimePublisherGrants,
	SubscribeOptions,
	DisconnectReason,
} from './types.js';

// ── Connection record type ──────────────────────────────────────────────────

interface ConnectionRecord {
	connectionId: string;
	channel: string;
	expiresAt: number;
	connectedAt?: number;
	lastTtlSweep?: number;
}

// ── Connections table schema (runtime validation — accepts anything) ────────

const connectionsSchema: StandardSchemaV1<ConnectionRecord> = {
	'~standard': {
		version: 1,
		vendor: 'blocks',
		validate: (value: unknown) => ({ value: value as ConnectionRecord }),
	},
};

// ── Constants (all values in seconds) ───────────────────────────────────────

const SENTINEL_SK = '__connection__';
const SENTINEL_TTL = 9000;   // 2.5 hours
const CHANNEL_TTL = 3600;    // 1 hour
const SWEEP_INTERVAL = 1800; // 30 minutes

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

/** Parsed message body from a WebSocket $default route. */
interface WebSocketMessage {
	action: 'subscribe' | 'unsubscribe' | 'ping';
	channel?: string;
	token?: string;
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
		apigwClients.set(ep, client);
	}
	return client;
}

// ── DistributedTable instance ───────────────────────────────────────────────

let _connectionsTable: DistributedTable<
	ConnectionRecord,
	{ partitionKey: 'connectionId'; sortKey: 'channel' },
	{ 'channel-index': { partitionKey: 'channel'; sortKey: 'connectionId' } }
> | null = null;

function connectionsTable() {
	if (!_connectionsTable) throw blocksError(RealtimeErrors.PublishFailed, 'Connections table not initialized');
	return _connectionsTable;
}

// ── Token secret via AppSetting ──────────────────────────────────────────────

let _tokenSecret: AppSetting | null = null;
let cachedSecret: string | null = null;
let secretPromise: Promise<string> | null = null;

async function getTokenSecret(): Promise<string> {
	if (cachedSecret) return cachedSecret;
	if (secretPromise) return secretPromise;
	if (!_tokenSecret) throw blocksError(RealtimeErrors.ConnectionFailed, 'Token secret AppSetting not initialized');
	secretPromise = _tokenSecret.get().then(value => { cachedSecret = value; return value; });
	return secretPromise;
}

// ── DistributedTable helpers ────────────────────────────────────────────────

async function queryConnectionsByChannel(channel: string): Promise<string[]> {
	const table = connectionsTable();
	const records = await Array.fromAsync(table.query({
		index: 'channel-index',
		where: { channel: { equals: channel } },
	}));
	return records.map(r => r.connectionId);
}

async function deleteConnectionRecords(connectionId: string): Promise<void> {
	const table = connectionsTable();
	const records = await Array.fromAsync(table.query({
		where: { connectionId: { equals: connectionId } },
	}));
	const keys = records.map(r => ({ connectionId: r.connectionId, channel: r.channel }));
	if (keys.length > 0) {
		await table.deleteBatch(keys);
	}
}

// ── WebSocket event handler (runs inside Blocks handler Lambda) ────────────────

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
		await table.put({ connectionId, channel: SENTINEL_SK, connectedAt: now, expiresAt: now + SENTINEL_TTL, lastTtlSweep: now });
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

	if (msg.action === 'subscribe' && msg.channel && msg.token) {
		const secret = await getTokenSecret();
		const valid = validateChannelToken(msg.token, secret, msg.channel);
		if (!valid) {
			await getApigw(callbackUrl).send(new PostToConnectionCommand({
				ConnectionId: connectionId,
				Data: JSON.stringify({ type: 'error', channel: msg.channel, message: 'Unauthorized: invalid or expired token' }),
			}));
			return { statusCode: 200 };
		}
		await table.put({ connectionId, channel: msg.channel, expiresAt: now + CHANNEL_TTL });
		await getApigw(callbackUrl).send(new PostToConnectionCommand({
			ConnectionId: connectionId,
			Data: JSON.stringify({ type: 'subscribe_success', channel: msg.channel }),
		}));
	} else if (msg.action === 'unsubscribe' && msg.channel) {
		await table.delete({ connectionId, channel: msg.channel });
	} else if (msg.action === 'ping') {
		// Get sentinel to read lastTtlSweep, then update TTL
		const sentinel = await table.get({ connectionId, channel: SENTINEL_SK });
		if (sentinel) {
			await table.put({ ...sentinel, expiresAt: now + SENTINEL_TTL });
			const lastSweep = sentinel.lastTtlSweep ?? 0;
			if (now - lastSweep > SWEEP_INTERVAL) {
				// Sweep: refresh TTLs on all channel subscriptions
				const allRecords = await Array.fromAsync(table.query({
					where: { connectionId: { equals: connectionId } },
				}));
				const items = allRecords
					.filter(r => r.channel !== SENTINEL_SK)
					.map(r => ({ ...r, expiresAt: now + CHANNEL_TTL }));
				if (items.length > 0) {
					await table.putBatch(items);
				}
				await table.put({ ...sentinel, expiresAt: now + SENTINEL_TTL, lastTtlSweep: now });
			}
		}
	}

	return { statusCode: 200 };
}

// ── Server-side WebSocket subscribe ─────────────────────────────────────────

function serverSubscribe(
	wsUrl: string | undefined,
	connectToken: string,
	channel: string,
	channelToken: string,
	handler: (message: unknown) => void,
	onDisconnect?: (reason: import('./types.js').DisconnectReason) => void,
): RealtimeSubscription {
	if (!wsUrl) {
		const err = new Error('BLOCKS_RT_WS_URL not set — server-side subscribe unavailable');
		err.name = 'ConnectionFailedException';
		return { unsubscribe() {}, established: Promise.reject(err) };
	}

	const url = `${wsUrl}?token=${encodeURIComponent(connectToken)}`;
	const ws = new WebSocket(url);

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
				resolveEstablished();
			} else if (msg.type === 'error' && msg.channel === channel) {
				const err = new Error(msg.message || 'Subscription rejected');
				err.name = 'ConnectionFailedException';
				rejectEstablished(err);
			} else if (msg.type === 'message' && msg.channel === channel) {
				try { handler(msg.data); } catch {}
			}
		} catch {}
	};

	ws.onerror = () => {
		const err = new Error('WebSocket error');
		err.name = 'ConnectionFailedException';
		rejectEstablished(err);
		if (onDisconnect) try { onDisconnect('error'); } catch {}
	};

	ws.onclose = (event) => {
		const err = new Error('WebSocket closed');
		err.name = 'ConnectionFailedException';
		rejectEstablished(err);
		if (onDisconnect) {
			const reason: import('./types.js').DisconnectReason = event.code === 1001 ? 'timeout' : event.code === 1006 ? 'error' : 'unknown';
			try { onDisconnect(reason); } catch {}
		}
	};

	return {
		unsubscribe() {
			if (onDisconnect) try { onDisconnect('client'); } catch {}
			ws.onmessage = null;
			ws.onerror = null;
			ws.onclose = null;
			ws.close();
		},
		established,
		connection: ws,
	};
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
 * - Keep message payloads small — large payloads increase latency and cost
 * - Return channel handles from API methods for seamless client hydration
 *
 * **Scaling:** WebSocket connections managed by API Gateway. Automatic scaling.
 * $1.00 per million messages. Fan-out cost is proportional to subscriber count.
 * DynamoDB connections table uses on-demand billing (~$0 for typical workloads).
 */
export const Realtime: {
	new <T extends NamespaceDefs>(scope: ScopeParent, id: string, options: RealtimeOptions<T>): Scope & RealtimeServer<T> & RealtimePublisherGrants;
	namespace<M>(schema: StandardSchemaV1<M>): NamespaceConfig<M>;
} = class Realtime extends Scope {
	private _namespaces: Map<string, { schema: StandardSchemaV1<any>; prefix: string }>;
	private _localEmitter = new EventEmitter();
	private _cachedSecretPromise: Promise<string | null>;
	private _customUserAgent: [string, string][];

	constructor(scope: ScopeParent, id: string, options: RealtimeOptions<NamespaceDefs>) {
		super(id, { parent: scope, bbName: BB_NAME, bbVersion: BB_VERSION });

		this._customUserAgent = this.buildUserAgentChain();
		this.registerClientMiddleware('@aws-blocks/bb-realtime/aws-middleware');
		this.registerLambdaEventHandler('blocks.websocket', this.fullId, handleWebSocketEvent);

		const wsUrl = process.env.BLOCKS_RT_WS_URL ?? '';
		const callbackUrl = process.env.BLOCKS_RT_CALLBACK_URL ?? '';
		registerSdkIdentifiers(this.fullId, { wsUrl, callbackUrl });

		// Initialize the DistributedTable for connection tracking (shared across instances)
		if (!_connectionsTable) {
			_connectionsTable = new DistributedTable(this, 'connections', {
				schema: connectionsSchema,
				key: { partitionKey: 'connectionId', sortKey: 'channel' } as const,
				indexes: { 'channel-index': { partitionKey: 'channel', sortKey: 'connectionId' } } as const,
				ttl: 'expiresAt',
			});
		}

		// Initialize the token secret via AppSetting (shared across instances)
		if (!_tokenSecret) {
			_tokenSecret = new AppSetting(this, 'token-secret', { secret: true });
		}

		if (!wsUrl) {
			console.warn(`[Realtime] BLOCKS_RT_WS_URL not set — getChannel() will return incomplete descriptors`);
		}

		// Pre-warm secret fetch. Resolves to null when SSM is unreachable (e.g., codegen).
		// Callers must treat null as "secret unavailable" and fail explicitly.
		this._cachedSecretPromise = getTokenSecret().catch(() => null);

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
		await validateSchema(ns.schema, data);
		const fullChannel = `${ns.prefix}/${channel}`;
		validateChannelPath(fullChannel);
		validatePublishSize(fullChannel, data);
		const message = JSON.stringify({ type: 'message', channel: fullChannel, data });

		const connectionIds = await queryConnectionsByChannel(fullChannel);
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
		const fullChannel = `${ns.prefix}/${channel}`;
		validateChannelPath(fullChannel);
		// Local EventEmitter for same-invocation publish
		this._localEmitter.on(fullChannel, handler);
		// Real WebSocket for cross-invocation publish (established once secret resolves)
		let wsSub: ReturnType<typeof serverSubscribe> | null = null;
		const { wsUrl } = getSdkIdentifiers(this);
		if (wsUrl) {
			const fullId = this.fullId;
			this._cachedSecretPromise.then(secret => {
				if (!secret) return; // SSM unavailable (e.g., codegen)
				const channelToken = mintChannelToken(fullChannel, secret);
				const connectToken = mintConnectToken(fullId, secret);
				wsSub = serverSubscribe(wsUrl, connectToken, fullChannel, channelToken, handler);
			}).catch(() => {});
		}
		return () => {
			this._localEmitter.off(fullChannel, handler);
			if (wsSub) wsSub.unsubscribe();
		};
	}

	async getChannel(namespace: string, channel: string): Promise<RealtimeChannel<unknown>> {
		const ns = this._ns(namespace);
		const fullChannel = `${ns.prefix}/${channel}`;
		validateChannelPath(fullChannel);
		const secret = await this._cachedSecretPromise;
		if (!secret) {
			throw blocksError(RealtimeErrors.ConnectionFailed, 'Token secret unavailable — cannot issue channel credentials');
		}
		const channelToken = mintChannelToken(fullChannel, secret);
		const connectToken = mintConnectToken(this.fullId, secret);
		const wsUrl = getSdkIdentifiers(this).wsUrl;
		const localEmitter = this._localEmitter;

		return {
			subscribe(handlerOrOptions: ((message: unknown) => void) | SubscribeOptions, _options?: never): RealtimeSubscription {
				const handler = typeof handlerOrOptions === 'function' ? handlerOrOptions : handlerOrOptions.onMessage;
				const onDisconnect = typeof handlerOrOptions === 'function' ? undefined : handlerOrOptions.onDisconnect;
				// Local EventEmitter for same-invocation publish
				localEmitter.on(fullChannel, handler);
				// Real WebSocket for cross-invocation publish
				const sub = serverSubscribe(wsUrl, connectToken, fullChannel, channelToken, handler, onDisconnect);
				return {
					unsubscribe() {
						localEmitter.off(fullChannel, handler);
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

	static namespace<M>(schema: StandardSchemaV1<M>): NamespaceConfig<M> {
		return { schema };
	}

	// CDK-synth-only capability (see RealtimePublisherGrants). Present for type parity with
	// the CDK build; publishing grants are provisioned at synth, not in the AWS runtime.
	grantPublish(_grantee: unknown): never {
		throw new Error('Realtime.grantPublish() is a CDK-synth-only operation and is not available in the AWS runtime build.');
	}
} as any;
