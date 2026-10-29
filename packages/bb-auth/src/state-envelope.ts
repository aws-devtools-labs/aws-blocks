// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The versioned, HMAC-signed `state` envelope of the relay sign-in, ported
 * byte-for-byte from `bb-auth-oidc/src/state.ts`.
 *
 * Wire format: `base64url(JSON(payload)) + '.' + base64url(HMAC-SHA256(body))`,
 * where `body` is the first segment. The payload is `{ v: 1, csrf, relay?, app? }`
 * with `undefined` fields dropped.
 *
 * ⚠️ **Wire contract.** The native SDKs (Swift, Kotlin, Dart) split the
 * envelope at the first `.`, base64url-decode the body and compare `csrf`
 * with the value they generated. Changing the field names, the field order of
 * the encoder, the separator or the base64url alphabet breaks every shipped
 * native app. `federation-routes.test.ts` pins the format.
 *
 * Server-only (`node:crypto`).
 *
 * @internal
 */

import { createHmac } from 'node:crypto';
import { constantTimeEquals } from '@aws-blocks/core/bb-utils';

/** V1 payload. Future versions add arms keyed on `v`. */
export interface StatePayloadV1 {
	/** Wire-format version. Always `1` for this arm. */
	readonly v: 1;
	/** CSRF binding value (≥ 32 chars). The SDK generates it and compares it on return. */
	readonly csrf: string;
	/** Relay URI the callback should 302 to. Present only for native / loopback flows. */
	readonly relay?: string;
	/** Round-tripped customer-supplied app state. Opaque to the block. */
	readonly app?: string;
}

/** Discriminated union over wire-format versions. */
export type StatePayload = StatePayloadV1;

/**
 * Result of decoding an envelope:
 * - `signature` — HMAC mismatch (tampered, or another secret);
 * - `version` — a signed envelope with an unknown `v` (the SDK is newer or older);
 * - `malformed` — not an envelope at all.
 */
export type DecodeResult =
	| { ok: true; payload: StatePayload }
	| { ok: false; reason: 'signature' | 'version' | 'malformed' };

/** Encode a payload into the on-wire envelope (drops `undefined` fields). */
export function encodeState(payload: StatePayload, secret: string): string {
	const canonical: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(payload)) {
		if (v !== undefined) canonical[k] = v;
	}
	const body = Buffer.from(JSON.stringify(canonical), 'utf8').toString('base64url');
	const sig = createHmac('sha256', secret).update(body).digest('base64url');
	return `${body}.${sig}`;
}

/** Decode and verify an envelope. */
export function decodeState(envelope: string, secret: string): DecodeResult {
	const dot = envelope.indexOf('.');
	if (dot <= 0 || dot === envelope.length - 1) return { ok: false, reason: 'malformed' };
	const body = envelope.slice(0, dot);
	const sig = envelope.slice(dot + 1);
	if (sig.includes('.')) return { ok: false, reason: 'malformed' };

	const expected = createHmac('sha256', secret).update(body).digest('base64url');
	if (!constantTimeEquals(sig, expected)) return { ok: false, reason: 'signature' };

	let parsed: unknown;
	try {
		parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
	} catch {
		return { ok: false, reason: 'malformed' };
	}
	if (typeof parsed !== 'object' || parsed === null) return { ok: false, reason: 'malformed' };
	const v: unknown = Reflect.get(parsed, 'v');
	if (v === 1) {
		const csrf: unknown = Reflect.get(parsed, 'csrf');
		const relay: unknown = Reflect.get(parsed, 'relay');
		const app: unknown = Reflect.get(parsed, 'app');
		if (typeof csrf !== 'string' || csrf.length === 0) return { ok: false, reason: 'malformed' };
		return {
			ok: true,
			payload: {
				v: 1,
				csrf,
				...(typeof relay === 'string' ? { relay } : {}),
				...(typeof app === 'string' ? { app } : {}),
			},
		};
	}
	// Signed by us but an arm this build does not know: "update your SDK".
	if (typeof v === 'number' || typeof v === 'string') return { ok: false, reason: 'version' };
	return { ok: false, reason: 'malformed' };
}

/**
 * The envelope's HMAC key, derived from the session secret so an envelope
 * signature can never double as a session-cookie signature (the session
 * cookie signs with the raw secret). Server-only; the native SDKs never
 * verify the signature, they only decode the body.
 */
export function relayStateKey(sessionSecret: string): string {
	return createHmac('sha256', sessionSecret).update('aws-blocks/bb-auth relay-state v1').digest('base64url');
}
