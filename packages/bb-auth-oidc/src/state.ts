// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Versioned, HMAC-signed state envelope for the OIDC `state` parameter.
 * Wire format: `base64url(JSON(payload)) + '.' + base64url(hmac-sha256(body))`.
 *
 * Native SDKs (Dart, Kotlin, Swift) must decode byte-identically to TS.
 */

import { createHmac } from 'node:crypto';
import { constantTimeEquals } from '@aws-blocks/core/bb-utils';

/** V1 payload shape. Future versions add new arms keyed on `v`. */
export interface StatePayloadV1 {
	/** Wire-format version. Always `1` for this arm. */
	readonly v: 1;
	/** CSRF binding value (≥32 chars). SDK generates, stores locally, and compares on return. */
	readonly csrf: string;
	/** Relay URI the callback should 302 to. Present only for native/loopback flows. */
	readonly relay?: string;
	/** Round-tripped customer-supplied app state. Opaque to the BB. */
	readonly app?: string;
}

/** Discriminated union over wire-format versions. */
export type StatePayload = StatePayloadV1;

/**
 * Result of decoding a state envelope. Failure reasons:
 * - `signature` — HMAC mismatch (tampered or wrong secret).
 * - `version` — unknown `v` field (SDK version mismatch).
 * - `malformed` — structurally broken envelope.
 */
export type DecodeResult<T> =
	| { ok: true; payload: T }
	| { ok: false; reason: 'signature' | 'version' | 'malformed' };

/** Encode a `StatePayload` into the on-wire envelope. Strips `undefined` fields for canonical output. */
export function encodeState(payload: StatePayload, secret: string): string {
	const canonical = stripUndefined(payload);
	const json = JSON.stringify(canonical);
	const body = base64UrlEncode(Buffer.from(json, 'utf8'));
	const sig = base64UrlEncode(createHmac('sha256', secret).update(body).digest());
	return `${body}.${sig}`;
}

/** Decode and verify a state envelope. Returns a typed payload or a failure reason. */
export function decodeState(envelope: string, secret: string): DecodeResult<StatePayload> {
	const dotIdx = envelope.indexOf('.');
	if (dotIdx <= 0 || dotIdx === envelope.length - 1) {
		return { ok: false, reason: 'malformed' };
	}
	const body = envelope.slice(0, dotIdx);
	const sig = envelope.slice(dotIdx + 1);
	if (sig.includes('.')) return { ok: false, reason: 'malformed' };

	const expected = base64UrlEncode(createHmac('sha256', secret).update(body).digest());
	if (!constantTimeEquals(sig, expected)) {
		return { ok: false, reason: 'signature' };
	}

	let parsed: unknown;
	try {
		const json = base64UrlDecode(body).toString('utf8');
		parsed = JSON.parse(json);
	} catch {
		return { ok: false, reason: 'malformed' };
	}

	if (!parsed || typeof parsed !== 'object') {
		return { ok: false, reason: 'malformed' };
	}
	const obj = parsed as { v?: unknown };

	if (obj.v === 1) {
		const validated = validateV1(obj as Record<string, unknown>);
		if (!validated) return { ok: false, reason: 'malformed' };
		return { ok: true, payload: validated };
	}

	// Known to be an envelope (signature verified) but the `v` arm is one
	// this build doesn't recognize. Caller should surface "update your SDK".
	if (typeof obj.v === 'number' || typeof obj.v === 'string') {
		return { ok: false, reason: 'version' };
	}

	return { ok: false, reason: 'malformed' };
}

/** Validate a parsed object matches `StatePayloadV1`. Returns `null` on shape mismatch. */
function validateV1(raw: Record<string, unknown>): StatePayloadV1 | null {
	if (raw.v !== 1) return null;
	if (typeof raw.csrf !== 'string' || raw.csrf.length === 0) return null;

	const out: { -readonly [K in keyof StatePayloadV1]: StatePayloadV1[K] } = {
		v: 1,
		csrf: raw.csrf,
	};
	if (typeof raw.relay === 'string') out.relay = raw.relay;
	if (typeof raw.app === 'string') out.app = raw.app;
	return out;
}

/** Drop keys whose value is `undefined` for canonical serialization. */
function stripUndefined<T extends object>(value: T): T {
	const out: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(value)) {
		if (v !== undefined) out[k] = v;
	}
	return out as T;
}

function base64UrlEncode(buf: Buffer): string {
	return buf.toString('base64url');
}

function base64UrlDecode(value: string): Buffer {
	return Buffer.from(value, 'base64url');
}
