// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Internal utility functions for Realtime. Not customer-facing.
 */

import type { StandardSchemaV1 } from '@standard-schema/spec';
import { createHmac } from 'node:crypto';
import { constantTimeEquals } from '@aws-blocks/core/bb-utils';
import { RealtimeErrors } from './errors.js';

export function blocksError(name: string, message: string): Error {
	const err = new Error(`${name}: ${message}`);
	err.name = name;
	return err;
}

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

/** API Gateway WebSocket frame maximum size in bytes. */
const MAX_FRAME_BYTES = 32_768;

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
 * Validate that a publish message fits within the API Gateway WebSocket
 * frame size limit (32 KB). The message includes the envelope
 * (type + channel) so we check the full serialized payload.
 */
export function validatePublishSize(fullChannel: string, data: unknown): void {
	const message = JSON.stringify({ type: 'message', channel: fullChannel, data });
	const byteLength = Buffer.byteLength(message, 'utf8');
	if (byteLength > MAX_FRAME_BYTES) {
		throw blocksError(RealtimeErrors.ValidationFailed,
			`Published message exceeds WebSocket frame limit (${byteLength}/${MAX_FRAME_BYTES} bytes)`);
	}
}

// ── Token Utilities ─────────────────────────────────────────────────────────

/**
 * Mint a channel token. HMAC-SHA256 signed payload with channel path and expiry.
 * Used by both mock and AWS runtime to gate subscribe access.
 *
 * Format: `{base64url(payload)}.{base64url(hmac)}`
 * Payload: `{ "channel": "/namespace/template/sub", "exp": <unix_seconds> }`
 */
export function mintChannelToken(channel: string, secret: string, ttlSeconds = 3600): string {
	if (!secret) {
		throw blocksError(RealtimeErrors.ConnectionFailed, 'Refusing to mint token: signing secret is empty or missing');
	}
	const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
	const payload = JSON.stringify({ channel, exp });
	const sig = createHmac('sha256', secret).update(payload).digest('base64url');
	const payloadB64 = Buffer.from(payload).toString('base64url');
	return `${payloadB64}.${sig}`;
}

/**
 * Mint a connect token. Scoped to a Realtime instance prefix with a `$connect`
 * suffix (e.g., `myapp-rt/$connect`). This prevents connect tokens from being
 * used as channel subscription tokens, since `myapp-rt/$connect` does not
 * prefix-match real channels like `myapp-rt/chat/room-1`.
 *
 * Default TTL is 2 hours (matching API Gateway max connection duration).
 */
export function mintConnectToken(scopePrefix: string, secret: string, ttlSeconds = 7200): string {
	if (!secret) {
		throw blocksError(RealtimeErrors.ConnectionFailed, 'Refusing to mint token: signing secret is empty or missing');
	}
	return mintChannelToken(scopePrefix + '/$connect', secret, ttlSeconds);
}

/**
 * Validate a channel token. Returns the decoded payload if valid, null if not.
 * Works for both channel-scoped and connect (instance-scoped) tokens — the
 * `requestedChannel` startsWith check handles both cases.
 */
export function validateChannelToken(
	token: string,
	secret: string,
	requestedChannel?: string,
): { channel: string; exp: number } | null {
	try {
		const [payloadB64, sig] = token.split('.');
		if (!payloadB64 || !sig) return null;
		const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString());
		const expectedSig = createHmac('sha256', secret).update(JSON.stringify(payload)).digest('base64url');
		if (!constantTimeEquals(sig, expectedSig)) return null;
		if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) return null;
		if (requestedChannel && payload.channel && requestedChannel !== payload.channel && !requestedChannel.startsWith(payload.channel + '/')) return null;
		return payload;
	} catch {
		return null;
	}
}
