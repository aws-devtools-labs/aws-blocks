// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { timingSafeEqual } from 'node:crypto';

/**
 * Session-token auth for the local dashboard server.
 *
 * The token is crypto-random, generated per process by core's dashboard.ts,
 * handed to the browser via the URL fragment (never sent to the server in
 * the URL), and presented back as an Authorization header on every /api
 * call. Header, not cookie: no CSRF surface, nothing persisted.
 */

export const TOKEN_ENV_VAR = 'BLOCKS_DASHBOARD_TOKEN';

/** Extracts the bearer token from an Authorization header value, if any. */
export function parseBearerToken(authorizationHeader: string | null | undefined): string | undefined {
	if (!authorizationHeader) return undefined;
	const match = /^Bearer\s+(\S+)$/i.exec(authorizationHeader);
	return match ? match[1] : undefined;
}

/** Constant-time comparison of a presented token against the expected one. */
export function isValidToken(presented: string | undefined, expected: string | undefined): boolean {
	if (!presented || !expected) return false;
	const a = Buffer.from(presented);
	const b = Buffer.from(expected);
	if (a.length !== b.length) return false;
	return timingSafeEqual(a, b);
}

/**
 * Checks an Authorization header against the process-level session token.
 *
 * When no token is configured — plain `next dev` without the CLI, which is how
 * the UI is developed — reads are allowed in development mode so the pages work
 * without a token to present. This fallback is the one condition under which the
 * dashboard has no auth at all, so it is deliberately narrow: use
 * {@link isAuthorizedToMutate} for anything that writes, which never takes it.
 */
export function isAuthorized(authorizationHeader: string | null | undefined): boolean {
	const expected = process.env[TOKEN_ENV_VAR];
	if (!expected) return process.env.NODE_ENV === 'development';
	return isValidToken(parseBearerToken(authorizationHeader), expected);
}

/**
 * As {@link isAuthorized}, but a real token is ALWAYS required.
 *
 * The development fallback exists so `next dev` can render pages with no token
 * to present. Extending it to writes would mean that in dev mode — with the
 * developer's real AWS credentials in the environment — `POST /writes/unlock`
 * and a cloud record delete are reachable by any local process, and by any
 * same-origin script, with no credential at all. Reading local state without a
 * token is a convenience with a small blast radius; unlocking and then writing to
 * a deployed stack is not the same thing, and the whole argument for the session
 * token is that a write must be attributable to someone who was given it.
 *
 * `guardMutation` still applies on top of this and is what stops a cross-site
 * request; this is what stops an unauthenticated same-origin or local one.
 */
export function isAuthorizedToMutate(authorizationHeader: string | null | undefined): boolean {
	const expected = process.env[TOKEN_ENV_VAR];
	if (!expected) return false;
	return isValidToken(parseBearerToken(authorizationHeader), expected);
}
