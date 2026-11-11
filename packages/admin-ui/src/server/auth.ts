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

/**
 * Opt-in that allows unauthenticated READS when no session token is configured,
 * for developing the UI with a plain `next dev` and no CLI.
 *
 * Purpose-named and default-deny, deliberately. Authentication must not be
 * decided by an ambient variable: `NODE_ENV=development` is set by test
 * runners, editors and toolchains that have no opinion about this gate, so
 * keying on it disables authentication as a side effect of something else.
 * This variable does nothing but disable the read gate, so setting it is a
 * choice someone made on purpose.
 */
export const UNAUTHENTICATED_READS_ENV_VAR = 'BLOCKS_DASHBOARD_ALLOW_UNAUTHENTICATED_READS';

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
 * the UI is developed — reads are allowed only if
 * {@link UNAUTHENTICATED_READS_ENV_VAR} is explicitly set, so the pages work
 * without a token to present. That fallback is the one condition under which the
 * dashboard has no auth at all, so it is deliberately narrow in two ways: it is
 * opt-in rather than inferred from the environment, and it covers reads only.
 * Use {@link isAuthorizedToMutate} for anything that writes, which never takes
 * it.
 *
 * The opt-in does not make the dashboard safe to expose. The server this package
 * ships binds to 127.0.0.1 (see `start.ts`), and the `dev` script passes
 * `-H 127.0.0.1` for the same reason: with the gate open, every reader on the
 * interface would be querying AWS with the developer's own credentials.
 */
export function isAuthorized(authorizationHeader: string | null | undefined): boolean {
	const expected = process.env[TOKEN_ENV_VAR];
	if (!expected) return process.env[UNAUTHENTICATED_READS_ENV_VAR] === '1';
	return isValidToken(parseBearerToken(authorizationHeader), expected);
}

/**
 * As {@link isAuthorized}, but a real token is ALWAYS required.
 *
 * The read fallback exists so `next dev` can render pages with no token to
 * present. Extending it to writes would mean that with the opt-in set — and the
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
