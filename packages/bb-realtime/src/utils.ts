// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Internal utility functions for Realtime. Not customer-facing.
 */

import type { StandardSchemaV1 } from '@standard-schema/spec';
import { createHmac, randomBytes } from 'node:crypto';
import { constantTimeEquals } from '@aws-cdk-blocks/core/bb-utils';
import { RealtimeErrors } from './errors.js';

// Shared from core so every block uses one `blocksError` implementation (single
// source of the name-as-contract rule). Imported for the runtime callers below
// and re-exported for other modules; core's `errors.ts` is dependency-free, so
// it's safe in the aws-runtime bundle.
import { blocksError } from '@aws-cdk-blocks/core';
export { blocksError };

export async function validateSchema<T>(schema: StandardSchemaV1<T>, value: unknown): Promise<void> {
	const result = schema['~standard'].validate(value);
	const resolved = result instanceof Promise ? await result : result;
	if (resolved.issues) {
		throw blocksError(RealtimeErrors.ValidationFailed, resolved.issues[0].message);
	}
}

// ── Limit Validation ────────────────────────────────────────────────────────

/** DynamoDB sort key maximum size in bytes. */
const MAX_CHANNEL_BYTES = 1024;

/**
 * API Gateway WebSocket maximum *logical message* size in bytes (128 KiB).
 *
 * API Gateway has two distinct WebSocket quotas: a 32 KiB maximum *frame* size
 * and a 128 KiB maximum *message* size. The service reassembles fragmented
 * frames into a single logical message, so the cap that applies to a published
 * payload is 128 KiB — not 32 KiB. Do not "re-fix" this back to 32 KiB.
 *
 * https://docs.aws.amazon.com/apigateway/latest/developerguide/apigateway-execution-service-websocket-limits-table.html
 */
const MAX_MESSAGE_BYTES = 131_072;

/**
 * Validate that a fully-qualified channel path fits within the DynamoDB
 * sort key limit (1024 bytes UTF-8).
 */
export function validateChannelPath(fullChannel: string): void {
	const byteLength = Buffer.byteLength(fullChannel, 'utf8');
	if (byteLength > MAX_CHANNEL_BYTES) {
		throw blocksError(RealtimeErrors.ValidationFailed,
			`Channel path exceeds DynamoDB sort key limit (${byteLength}/${MAX_CHANNEL_BYTES} bytes)`);
	}
}

/**
 * Which channels a channel token authorizes: `'subtree'` covers the channel and
 * every `/`-separated sub-channel of it, `'exact'` covers only the channel.
 */
export type ChannelTokenScope = 'exact' | 'subtree';

/**
 * Validate the user-facing `channel` argument of `publish()`, `subscribe()` and
 * `getChannel()`. `/` is allowed and separates segments, but a name that is
 * empty, starts or ends with `/`, contains an empty segment (`a//b`), or has a
 * `.` or `..` segment is rejected: such a name either collides with another
 * channel's path or reads like a path traversal, and none of them is needed to
 * name a channel.
 *
 * @throws {RealtimeErrors.ValidationFailed} If the name breaks one of these rules.
 */
export function validateChannelName(channel: string): void {
	// Numbers (and bigints) are accepted and validated as their string form, so
	// JavaScript callers that pass a numeric id keep working. Anything else that
	// isn't a string (`undefined`, `null`, an object) would be stringified into a
	// name like `undefined` or `[object Object]`, so it's rejected.
	const raw: unknown = channel;
	if (typeof raw !== 'string' && typeof raw !== 'number' && typeof raw !== 'bigint') {
		throw blocksError(RealtimeErrors.ValidationFailed,
			`Channel name must be a string (got ${raw === null ? 'null' : typeof raw})`);
	}
	const name = String(raw);
	if (name === '') {
		throw blocksError(RealtimeErrors.ValidationFailed, 'Channel name must not be empty');
	}
	for (const segment of name.split('/')) {
		if (segment === '') {
			throw blocksError(RealtimeErrors.ValidationFailed,
				'Invalid channel name: it must not start or end with "/" or contain an empty segment ("//")');
		}
		if (segment === '.' || segment === '..') {
			throw blocksError(RealtimeErrors.ValidationFailed,
				'Invalid channel name: "." and ".." are not allowed as channel segments');
		}
	}
}

/**
 * Resolve the token scope from `getChannel()` options, defaulting to `'subtree'`.
 *
 * @throws {RealtimeErrors.ValidationFailed} If `scope` is set to anything other than `'exact'` or `'subtree'`.
 */
export function resolveChannelTokenScope(options?: { scope?: unknown }): ChannelTokenScope {
	const scope = options?.scope;
	if (scope === undefined || scope === 'subtree') return 'subtree';
	if (scope === 'exact') return 'exact';
	throw blocksError(RealtimeErrors.ValidationFailed, 'getChannel() option "scope" must be "exact" or "subtree"');
}

/**
 * Whether `channel` is a channel path a WebSocket client may subscribe to or
 * unsubscribe from. Clients send the path back verbatim from a channel handle,
 * so it must have the shape `getChannel()` mints — `<instance>/<namespace>/<channel>`
 * — and fit the DynamoDB sort key limit (1024 bytes UTF-8). Anything else
 * (a non-string, an empty or oversized path, a path without an instance and
 * namespace, a path with an empty, `.` or `..` segment, or the
 * connection-tracking record key) is rejected before it reaches the
 * connections table.
 */
export function isClientChannelPath(channel: unknown): channel is string {
	if (typeof channel !== 'string') return false;
	if (Buffer.byteLength(channel, 'utf8') > MAX_CHANNEL_BYTES) return false;
	const instanceEnd = channel.indexOf('/');
	if (instanceEnd <= 0) return false;
	if (channel.indexOf('/', instanceEnd + 1) === -1) return false;
	// `getChannel()` never mints an empty, `.` or `..` segment (see
	// `validateChannelName`), so a path with one did not come from a channel
	// handle. Reject it here too, so the socket accepts the same names as the API.
	return channel.split('/').every(segment => segment !== '' && segment !== '.' && segment !== '..');
}

/**
 * Validate that a publish message fits within the API Gateway WebSocket
 * logical message size limit (128 KiB). The message includes the envelope
 * (type + channel) so we check the full serialized payload.
 */
export function validatePublishSize(fullChannel: string, data: unknown): void {
	const message = JSON.stringify({ type: 'message', channel: fullChannel, data });
	const byteLength = Buffer.byteLength(message, 'utf8');
	if (byteLength > MAX_MESSAGE_BYTES) {
		throw blocksError(RealtimeErrors.ValidationFailed,
			`Published message exceeds WebSocket message limit of 128 KiB (${byteLength}/${MAX_MESSAGE_BYTES} bytes); send a smaller payload or split it across multiple publishes`);
	}
}

// ── Token Utilities ─────────────────────────────────────────────────────────

/** Longest principal (user id) a token may carry, in characters. */
const MAX_PRINCIPAL_LENGTH = 256;

/**
 * Validate the principal (signed-in user id) to bind a token to.
 *
 * @throws {RealtimeErrors.ValidationFailed} If it is set but not a non-empty string of at most 256 characters.
 */
export function validatePrincipal(principal: unknown): asserts principal is string | undefined {
	if (principal === undefined) return;
	if (typeof principal !== 'string' || principal === '' || principal.length > MAX_PRINCIPAL_LENGTH) {
		throw blocksError(RealtimeErrors.ValidationFailed,
			`getChannel() option "principal" must be a non-empty string of at most ${MAX_PRINCIPAL_LENGTH} characters`);
	}
}

/**
 * Validate the principal passed to `revokeAccess()`. Unlike `getChannel()`, where an absent
 * principal is valid, revocation always needs one.
 *
 * @throws {RealtimeErrors.ValidationFailed} If it is missing, or fails {@link validatePrincipal}.
 */
export function validateRevokePrincipal(principal: unknown): asserts principal is string {
	// validatePrincipal() intentionally allows undefined (valid for getChannel()), so reject it separately here.
	validatePrincipal(principal);
	if (principal === undefined) throw blocksError(RealtimeErrors.ValidationFailed, 'revokeAccess() requires a principal');
}

/** What a validated channel or connect token says. */
export interface ChannelTokenClaims {
	/** The path the token was minted for; `undefined` when the payload has no string path. */
	channel: string | undefined;
	/** Expiry, in unix seconds. */
	exp: number;
	/** Which channels the token authorizes (`'subtree'` for a `channel` payload, `'exact'` for an `exact` one). */
	scope: ChannelTokenScope;
	/** When the token was minted, in unix seconds. */
	iat: number;
	/** Unique id of this token. */
	jti: string;
	/** The principal the token is bound to, or `undefined` for a token minted without one. */
	sub: string | undefined;
}

/**
 * Mint a channel token. HMAC-SHA256 signed payload with channel path, expiry,
 * issue time, a unique id, and (when given) the principal it is bound to.
 * Used by both mock and AWS runtime to gate subscribe access.
 *
 * Format: `{base64url(payload)}.{base64url(hmac)}`
 * Payload: `{ "channel": "/namespace/template/sub", "exp": <unix_seconds>, "iat": <unix_seconds>, "jti": "<id>", "sub": "<principal>" }`
 * (`sub` is left out when no principal is given.)
 *
 * `scope` decides which channels the token authorizes (see `validateChannelToken`):
 * `'subtree'` (the default) authorizes the channel and every `/`-separated
 * sub-channel of it. `'exact'` mints
 * `{ "exact": "/namespace/template/sub", ... }` instead and
 * authorizes only the channel itself. The path sits under `exact`, not
 * `channel`, so a validator from before `scope` existed (one that only knows
 * `channel`) refuses the token rather than granting it subtree access, for
 * example on a warm container during an update or after a rollback.
 *
 * `principal` binds the token to a user: `validateChannelToken` accepts it only
 * for a connection opened with a connect token bound to the same principal.
 * Tokens minted before `iat` and `jti` existed are refused by the validator.
 */
/** Default lifetime of a connect token: the API Gateway maximum connection duration (2 hours). */
export const CONNECT_TOKEN_TTL_SECONDS = 7200;

export function mintChannelToken(
	channel: string,
	secret: string,
	ttlSeconds = 3600,
	scope: ChannelTokenScope = 'subtree',
	principal?: string,
): string {
	if (!secret) {
		throw blocksError(RealtimeErrors.ConnectionFailed, 'Refusing to mint token: signing secret is empty or missing');
	}
	validatePrincipal(principal);
	const iat = Math.floor(Date.now() / 1000);
	const exp = iat + ttlSeconds;
	const jti = randomBytes(12).toString('base64url');
	const path = scope === 'exact' ? { exact: channel } : { channel };
	const payload = JSON.stringify({ ...path, exp, iat, jti, ...(principal === undefined ? {} : { sub: principal }) });
	const sig = createHmac('sha256', secret).update(payload).digest('base64url');
	const payloadB64 = Buffer.from(payload).toString('base64url');
	return `${payloadB64}.${sig}`;
}

/**
 * Mint a connect token. Scoped to a Realtime instance prefix with a `$connect`
 * suffix (e.g., `myapp-rt$connect`). Connect tokens authorize WebSocket
 * connection establishment but not channel subscriptions — the `$connect`
 * suffix ensures the token's channel field does not prefix-match real channel
 * paths (which always contain a `/` separator after the instance prefix).
 * When `principal` is given the connection is bound to that user, and every
 * channel token used on it must carry the same principal.
 *
 * Default TTL is 2 hours (matching API Gateway max connection duration).
 */
export function mintConnectToken(scopePrefix: string, secret: string, ttlSeconds = CONNECT_TOKEN_TTL_SECONDS, principal?: string): string {
	if (!secret) {
		throw blocksError(RealtimeErrors.ConnectionFailed, 'Refusing to mint token: signing secret is empty or missing');
	}
	return mintChannelToken(scopePrefix + '$connect', secret, ttlSeconds, 'subtree', principal);
}

/**
 * Validate a channel token. Returns the decoded token if valid, null if not:
 * `channel` is the path it was minted for and `scope` says which channels it
 * authorizes (`'subtree'` for a `channel` payload, `'exact'` for an `exact` one).
 * A token is valid only if it is signed, unexpired, and carries a numeric
 * `exp` and `iat`, a string `jti`, and a `sub` that is either absent or a
 * non-empty string. Without `requestedChannel` (the `$connect` handshake), none
 * of the checks below run: `channel` is then `undefined` when the payload has no
 * string path, and `scope` only reflects which key the path sits under.
 *
 * With `requestedChannel` (a subscribe), the token's path must equal the
 * channel or be a `/`-separated prefix of it, and only a channel token is
 * accepted. A connect token's path is `<instance>$connect`, so the prefix check
 * already limits it to `<instance>$connect/...`, where nothing is published (the
 * server publishes to `<instance>/<namespace>/...`). The `/` check rejects it
 * outright: a channel token's path always has a `/` after the instance prefix,
 * and a connect token's has none as long as the instance's scope id doesn't.
 *
 * A token minted with `scope: 'exact'` carries its path under `exact` instead of
 * `channel` and must equal the requested channel; its sub-channels are rejected.
 * A token with a `channel` field (the default) keeps the prefix rule above. For a
 * subscribe, a payload with both fields, with neither, or with a `scope` field is
 * rejected.
 *
 * `expect` binds the token to a principal: when given, the token's `sub` must
 * equal `expect.principal` (both absent counts as equal), so a token minted for
 * one user cannot be used on another user's connection.
 */
export function validateChannelToken(
	token: string,
	secret: string,
	requestedChannel?: string,
	expect?: { principal: string | undefined },
): ChannelTokenClaims | null {
	try {
		const [payloadB64, sig] = token.split('.');
		if (!payloadB64 || !sig) return null;
		const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString());
		const expectedSig = createHmac('sha256', secret).update(JSON.stringify(payload)).digest('base64url');
		if (!constantTimeEquals(sig, expectedSig)) return null;
		if (typeof payload.exp !== 'number' || !Number.isFinite(payload.exp)) return null;
		if (payload.exp < Math.floor(Date.now() / 1000)) return null;
		if (typeof payload.iat !== 'number' || !Number.isFinite(payload.iat)) return null;
		if (typeof payload.jti !== 'string' || payload.jti === '') return null;
		const sub: unknown = payload.sub;
		if (sub !== undefined && (typeof sub !== 'string' || sub === '' || sub.length > MAX_PRINCIPAL_LENGTH)) return null;
		if (expect && sub !== expect.principal) return null;
		const hasExact = payload.exact !== undefined;
		const channel: unknown = hasExact ? payload.exact : payload.channel;
		const scope: ChannelTokenScope = hasExact ? 'exact' : 'subtree';
		if (requestedChannel) {
			// Only a well-formed channel token authorizes a subscription (see the doc comment).
			if ((payload.channel !== undefined) === hasExact) return null;
			// No minted token carries `scope`; refuse one that does rather than guess.
			if (payload.scope !== undefined) return null;
			if (typeof channel !== 'string' || !channel.includes('/')) return null;
			if (requestedChannel !== channel) {
				if (scope === 'exact') return null;
				if (!requestedChannel.startsWith(`${channel}/`)) return null;
			}
		}
		return {
			channel: typeof channel === 'string' ? channel : undefined,
			exp: payload.exp,
			scope,
			iat: payload.iat,
			jti: payload.jti,
			sub: typeof sub === 'string' ? sub : undefined,
		};
	} catch {
		return null;
	}
}
