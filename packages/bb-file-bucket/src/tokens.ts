// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHmac, randomBytes } from 'node:crypto';
import { constantTimeEquals } from '@aws-blocks/core/bb-utils';
import { validatePresignedUrlExpiry } from './presigned-url.js';

// ── Token helpers ───────────────────────────────────────────────────────────

/**
 * Per-process HMAC secret for signing local presigned-URL tokens.
 *
 * The mock bucket (which mints tokens) and the dev file server (which validates
 * them) both import this module and run in the *same* dev-server process, so a
 * value generated once at module load is shared between them via the ESM module
 * cache — no configuration needed.
 *
 * This deliberately replaces a previously hardcoded literal. A fixed, source-
 * visible secret let anyone forge a valid token for any `fullId`/path/method and
 * hit the dev file server without ever calling `getUrl()`/`putUrl()`, defeating
 * the point of signing. A random per-process secret makes tokens unforgeable
 * while keeping the local round-trip working, since both ends share this value.
 * Tokens do not need to survive a dev-server restart (presigned URLs are short-
 * lived and re-minted on demand), so per-process randomness is sufficient.
 */
export const LOCAL_FILE_SECRET = randomBytes(32).toString('base64url');

interface FileTokenPayload {
	fullId: string;
	path: string;
	method: 'GET' | 'PUT';
	/** PUT: the Content-Type the upload must send (S3 signs it as a required header). */
	contentType?: string;
	/** PUT: the exact body size the upload must send (S3 signs it as a required header). */
	contentLength?: number;
	/** GET: the Content-Disposition the download is served with (S3's `response-content-disposition`). */
	contentDisposition?: string;
	exp: number;
}

/**
 * Values signed into a local token alongside its method/path/expiry, mirroring
 * the headers and response overrides an S3 presigned URL signs.
 */
export interface SignedFileTokenFields {
	/** PUT: exact body size the upload must send. */
	contentLength?: number;
	/** GET: Content-Disposition to serve the download with. */
	contentDisposition?: string;
}

export function mintFileToken(
	fullId: string,
	path: string,
	method: 'GET' | 'PUT',
	expiresIn: number,
	secret: string,
	contentType?: string,
	signed?: SignedFileTokenFields,
): string {
	validatePresignedUrlExpiry(expiresIn);
	const payload: FileTokenPayload = {
		fullId,
		path,
		method,
		exp: Math.floor(Date.now() / 1000) + expiresIn,
		...(contentType ? { contentType } : {}),
		...(signed?.contentLength !== undefined ? { contentLength: signed.contentLength } : {}),
		...(signed?.contentDisposition ? { contentDisposition: signed.contentDisposition } : {}),
	};
	const json = JSON.stringify(payload);
	const sig = createHmac('sha256', secret).update(json).digest('base64url');
	return `${Buffer.from(json).toString('base64url')}.${sig}`;
}

export function validateFileToken(
	token: string,
	secret: string,
	expectedFullId: string,
	expectedPath: string,
	expectedMethod: 'GET' | 'PUT',
): FileTokenPayload | null {
	try {
		const [payloadB64, sig] = token.split('.');
		if (!payloadB64 || !sig) return null;
		const json = Buffer.from(payloadB64, 'base64url').toString();
		const expectedSig = createHmac('sha256', secret).update(json).digest('base64url');
		if (!constantTimeEquals(sig, expectedSig)) return null;
		const payload: FileTokenPayload = JSON.parse(json);
		if (payload.exp < Math.floor(Date.now() / 1000)) return null;
		if (payload.fullId !== expectedFullId) return null;
		if (payload.path !== expectedPath) return null;
		if (payload.method !== expectedMethod) return null;
		return payload;
	} catch {
		return null;
	}
}
