// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * RFC 6238 TOTP (HMAC-SHA-1, 6 digits, 30-second steps) for the local user
 * pool: the codes authenticator apps compute and Cognito verifies. The mock
 * engine checks codes with it when `Auth` is created with
 * `totpVerification: 'rfc6238'`; `totpCodeFor` (`@aws-blocks/bb-auth/testing`,
 * re-exported from `@aws-blocks/blocks/utils`) computes the codes for tests
 * with {@link totpCode} (pinned to the RFC's vectors).
 *
 * Mock- and test-helper-only, never imported by the AWS or browser entries.
 *
 * @internal
 */

import crypto from 'node:crypto';

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** The step length, in milliseconds. */
const STEP_MS = 30_000;

/**
 * How many steps either side of now a code may be for: one, as authenticator
 * apps and their clocks drift, and as Cognito tolerates.
 */
const SKEW_STEPS = 1;

/** RFC 4648 base32 → bytes (case, spaces and `=` padding ignored); `null` when it is not base32. */
function decodeBase32(secret: string): Buffer | null {
	const clean = secret.replace(/[\s=]/g, '').toUpperCase();
	if (clean.length === 0 || /[^A-Z2-7]/.test(clean)) return null;
	let bits = 0;
	let value = 0;
	const out: number[] = [];
	for (const char of clean) {
		value = (value << 5) | BASE32_ALPHABET.indexOf(char);
		bits += 5;
		if (bits >= 8) {
			bits -= 8;
			out.push((value >>> bits) & 0xff);
		}
	}
	return Buffer.from(out);
}

/** The HOTP value (RFC 4226) of `key` at `counter`, as six digits. */
function hotp(key: Buffer, counter: number): string {
	const message = Buffer.alloc(8);
	message.writeBigUInt64BE(BigInt(counter));
	const hmac = crypto.createHmac('sha1', key).update(message).digest();
	const offset = hmac[hmac.length - 1] & 0x0f;
	const binary =
		((hmac[offset] & 0x7f) << 24) | (hmac[offset + 1] << 16) | (hmac[offset + 2] << 8) | hmac[offset + 3];
	return String(binary % 1_000_000).padStart(6, '0');
}

/** The code for base32 `sharedSecret` at `timeMs`; `null` when the secret is not base32. */
export function totpCode(sharedSecret: string, timeMs: number): string | null {
	const key = decodeBase32(sharedSecret);
	return key ? hotp(key, Math.max(0, Math.floor(timeMs / STEP_MS))) : null;
}

/**
 * Whether `code` is `sharedSecret`'s code for the step containing `nowMs`, or
 * for one step either side. Compared in constant time.
 */
export function verifyTotpCode(sharedSecret: string, code: string, nowMs: number = Date.now()): boolean {
	if (!/^\d{6}$/.test(code)) return false;
	const key = decodeBase32(sharedSecret);
	if (!key) return false;
	const step = Math.floor(nowMs / STEP_MS);
	let match = false;
	for (let d = -SKEW_STEPS; d <= SKEW_STEPS; d++) {
		// No step before the epoch (an HOTP counter is unsigned): within the
		// first 30 s only steps 0 and 1 are candidates.
		if (step + d < 0) continue;
		const expected = Buffer.from(hotp(key, step + d));
		if (crypto.timingSafeEqual(expected, Buffer.from(code))) match = true;
	}
	return match;
}
