// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Relay-target validation for the native / CLI relay sign-in, ported from
 * `bb-auth-oidc/src/relay.ts` (same rules, so the native SDKs see the same
 * accept/reject decisions and the same `reason` strings).
 *
 * `POST /aws-blocks/auth/authorize-params/<id>` is unauthenticated, so a
 * `relayTo` URI is checked against an allowlist to prevent open redirects:
 *
 * 1. Loopback (`127.0.0.1`, `[::1]`): http only, any port (RFC 8252 §7.3).
 * 2. Same origin as the backend request: always allowed.
 * 3. Custom schemes / off-origin HTTPS: must match an allowlist entry.
 *
 * Pure (only `URL`, plus core's dependency-free `brandBlocksError`) — safe in
 * every entry point.
 */

import { brandBlocksError } from '@aws-blocks/core';
import type { RelayOrigin } from './types.js';

/** Result of {@link validateRelay}. Failure arms carry a `reason` (on the wire). */
export type RelayValidation =
	| { allowed: true }
	| { allowed: false; reason: 'malformed' | 'unknown-origin' | 'plaintext-non-loopback' };

/** The failure reasons a relay validation can produce. */
export type InvalidRelayReason = Extract<RelayValidation, { allowed: false }>['reason'];

/** Parsed relay URI structure used for comparison. */
interface ParsedOrigin {
	scheme: string;
	host: string;
	port: number | null;
	hasPort: boolean;
}

/** Why `uri` is not a valid allowlist entry, or `null` when it is. */
function relayOriginProblem(uri: string): string | null {
	if (typeof uri !== 'string' || uri.length === 0) return 'relayOrigin requires a non-empty string';
	let parsed: URL;
	try {
		parsed = new URL(uri);
	} catch {
		return `relayOrigin: not a valid URI: ${uri}`;
	}
	// `myapp://auth` parses with pathname `''`; `myapp://auth/` with `/`. Any
	// other path is a config mistake: the path comes from the SDK's `relayTo`.
	if (parsed.pathname && parsed.pathname !== '/') {
		return (
			`relayOrigin: path components are not allowed (got ${JSON.stringify(parsed.pathname)} in ${uri}). ` +
			"Allowlist entries are scheme + authority only; paths come from the SDK's relayTo at sign-in."
		);
	}
	if (parsed.search) return `relayOrigin: query components are not allowed (got ${parsed.search} in ${uri})`;
	if (parsed.hash) return `relayOrigin: fragments are not allowed (got ${parsed.hash} in ${uri})`;
	if (parsed.username || parsed.password) return `relayOrigin: userinfo (user:pass@) is not allowed in ${uri}`;
	if (parsed.protocol.length <= 1) return `relayOrigin: missing scheme in ${uri}`;
	if (!parsed.hostname) return `relayOrigin: missing host in ${uri}`;
	// `localhost` resolves through /etc/hosts; loopback IPs are implicit anyway.
	if (parsed.hostname === 'localhost') {
		return "relayOrigin: 'localhost' is not allowed; loopback (127.0.0.1, [::1]) is implicitly allowed without an entry";
	}
	return null;
}

function isRelayOrigin(uri: string): uri is RelayOrigin {
	return relayOriginProblem(uri) === null;
}

/**
 * Build a validated {@link RelayOrigin} for `redirects.allowedRelayOrigins`:
 * `<scheme>://<host>[:<port>]`, with no path, query or fragment. Throws on a
 * bad entry, so a misconfiguration fails at construction.
 *
 * @example
 * ```ts
 * new Auth(scope, 'auth', {
 *   oidcProviders: { okta: { issuer: 'https://dev-1.okta.com', clientId: '0oa1' } },
 *   redirects: { allowedRelayOrigins: [relayOrigin('myapp://auth')] },
 * });
 * ```
 */
export function relayOrigin(uri: string): RelayOrigin {
	if (isRelayOrigin(uri)) return uri;
	const err = new Error(relayOriginProblem(uri) ?? `relayOrigin: invalid entry ${uri}`);
	err.name = 'RelayConfigError';
	// Branded like `bb-auth-oidc`'s `relayConfigError` (main #231): if it ever reaches the
	// RPC serializer, its name and its message (which names only the app's own entry) cross.
	throw brandBlocksError(err);
}

function parseOrigin(uri: string): ParsedOrigin | null {
	if (typeof uri !== 'string' || uri.length === 0) return null;
	let parsed: URL;
	try {
		parsed = new URL(uri);
	} catch {
		return null;
	}
	if (!parsed.hostname) return null;
	const scheme = parsed.protocol.slice(0, -1);
	if (scheme.length === 0) return null;
	const hasPort = parsed.port !== '';
	const port = hasPort ? Number(parsed.port) : null;
	if (port !== null && (Number.isNaN(port) || port < 0 || port > 65535)) return null;
	return { scheme: scheme.toLowerCase(), host: parsed.hostname.toLowerCase(), port, hasPort };
}

/** Loopback hosts that get the any-port allowance (RFC 8252 §7.3). */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '[::1]']);

/** Scheme + host must match; the port only when the entry pins one. */
function originsEqual(entry: ParsedOrigin, candidate: ParsedOrigin): boolean {
	if (entry.scheme !== candidate.scheme || entry.host !== candidate.host) return false;
	if (!entry.hasPort) return true;
	return candidate.hasPort && entry.port === candidate.port;
}

/**
 * Validate a candidate relay URI against the allowlist. Returns
 * `{ allowed: true }` or a tagged failure with a `reason`.
 */
export function validateRelay(
	uri: string,
	opts: { allowList: readonly RelayOrigin[]; sameOrigin: URL | null },
): RelayValidation {
	const candidate = parseOrigin(uri);
	if (!candidate) return { allowed: false, reason: 'malformed' };
	if (LOOPBACK_HOSTS.has(candidate.host)) {
		return candidate.scheme === 'http' ? { allowed: true } : { allowed: false, reason: 'plaintext-non-loopback' };
	}
	if (opts.sameOrigin) {
		const so = parseOrigin(opts.sameOrigin.toString());
		if (so && originsEqual(so, candidate)) return { allowed: true };
	}
	// Plain HTTP off loopback: report the security reason, not "not allowlisted".
	if (candidate.scheme === 'http') return { allowed: false, reason: 'plaintext-non-loopback' };
	for (const raw of opts.allowList) {
		const entry = parseOrigin(raw);
		if (entry && originsEqual(entry, candidate)) return { allowed: true };
	}
	return { allowed: false, reason: 'unknown-origin' };
}
