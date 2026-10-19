// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Relay-target validation for the OIDC relay flow.
 *
 * Validates `relayTo` URIs against an allowlist to prevent open-redirect
 * attacks on the unauthenticated `/aws-blocks/auth/authorize-params` endpoint.
 *
 * Allowance rules:
 * 1. Loopback (`127.0.0.1`, `[::1]`): http only, any port (RFC 8252 §7.3).
 * 2. Same-origin as the backend request URL: always allowed.
 * 3. Custom schemes / off-origin HTTPS: must match an allowlist entry.
 */

import { brandBlocksError } from '@aws-blocks/core';

/**
 * Brand symbol for the `RelayOrigin` opaque type. Prevents arbitrary
 * strings from being passed where a validated origin is required.
 */
declare const __relayOriginBrand: unique symbol;

/** Validated relay-origin allowlist entry. Constructed via {@link relayOrigin}. */
export type RelayOrigin = string & { readonly [__relayOriginBrand]: true };

/** Discriminated result of {@link validateRelay}. Failure arms carry a `reason` for actionable error messages. */
export type RelayValidation =
	| { allowed: true }
	| { allowed: false;
	    reason: 'malformed' | 'unknown-origin' | 'plaintext-non-loopback' };

/** The failure reasons a relay validation can produce. */
export type InvalidRelayReason = Extract<RelayValidation, { allowed: false }>['reason'];

/**
 * Parsed relay URI structure used for comparison.
 * `hasPort` distinguishes "no port" from "explicit port" for matching.
 */
export interface ParsedOrigin {
	scheme: string;
	host: string;
	port: number | null;
	hasPort: boolean;
}

/**
 * Construct a validated `RelayOrigin` for the `allowedRelayOrigins` option.
 *
 * Accepts `<scheme>://<host>[:<port>]` with no path/query/fragment.
 * Throws on bad inputs so misconfig fails at construction time.
 *
 * @example
 * ```typescript
 * import { AuthOIDC, google, relayOrigin } from '@aws-blocks/bb-auth-oidc';
 *
 * const auth = new AuthOIDC(scope, 'auth', {
 *   providers: [google({ clientId, clientSecret })],
 *   allowedRelayOrigins: [
 *     relayOrigin('myapp://auth'),
 *     relayOrigin('https://oauth-helper.myapp.com'),
 *   ],
 * });
 * ```
 */
export function relayOrigin(uri: string): RelayOrigin {
	if (typeof uri !== 'string' || uri.length === 0) {
		throw relayConfigError('relayOrigin requires a non-empty string');
	}

	let parsed: URL;
	try {
		parsed = new URL(uri);
	} catch {
		throw relayConfigError(`relayOrigin: not a valid URI: ${uri}`);
	}

	// Reject anything with a path component. URL parses `myapp://auth` as
	// pathname `''` but `myapp://auth/` or `myapp://auth/callback` as `/`
	// or `/callback`. Either path form is a config mistake — the relay
	// flow appends `?code=...&state=...` to whatever the SDK sent, so
	// path lives on the `relayTo` value, not the allowlist entry.
	if (parsed.pathname && parsed.pathname !== '' && parsed.pathname !== '/') {
		throw relayConfigError(
			`relayOrigin: path components are not allowed (got ${JSON.stringify(parsed.pathname)} in ${uri}). ` +
			`Allowlist entries are scheme + authority only; paths come from the SDK's relayTo at sign-in.`,
		);
	}
	// `URL` strips a single trailing slash silently — we treat both `''`
	// and `/` as no-path. Anything else is a real path.

	if (parsed.search) {
		throw relayConfigError(`relayOrigin: query components are not allowed (got ${parsed.search} in ${uri})`);
	}
	if (parsed.hash) {
		throw relayConfigError(`relayOrigin: fragments are not allowed (got ${parsed.hash} in ${uri})`);
	}
	if (parsed.username || parsed.password) {
		throw relayConfigError(`relayOrigin: userinfo (user:pass@) is not allowed in ${uri}`);
	}

	const scheme = parsed.protocol.slice(0, -1); // strip trailing ':'
	if (scheme.length === 0) {
		throw relayConfigError(`relayOrigin: missing scheme in ${uri}`);
	}

	if (!parsed.hostname) {
		throw relayConfigError(`relayOrigin: missing host in ${uri}`);
	}

	// Reject bare hostnames like `localhost`. `localhost` gets routed by
	// the OS to loopback, but allowing it here would let an attacker who
	// can poison /etc/hosts redirect through. Customers wanting loopback
	// don't need an entry at all (it's implicit).
	if (parsed.hostname === 'localhost') {
		throw relayConfigError(
			`relayOrigin: 'localhost' is not allowed; loopback (127.0.0.1, [::1]) is implicitly allowed without an entry`,
		);
	}

	return uri as RelayOrigin;
}

/**
 * Parse a candidate relay URI into the structural form for comparison.
 * Returns `null` for inputs that aren't URI-shaped.
 * @internal
 */
export function parseOrigin(uri: string): ParsedOrigin | null {
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
	if (hasPort && (Number.isNaN(port) || port! < 0 || port! > 65535)) return null;

	// `URL.hostname` keeps the brackets on IPv6 (`'[::1]'`). Lowercase
	// the result so case-insensitive comparison is stable across
	// scheme casings; bracket form is canonical and stable as-is.
	const host = parsed.hostname.toLowerCase();

	return { scheme: scheme.toLowerCase(), host, port, hasPort };
}

/** Loopback hosts that get the wildcard-port allowance (RFC 8252 §7.3). */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '[::1]']);

/**
 * Validate a candidate relay URI against the configured allowlist.
 * Returns `{ allowed: true }` or a tagged failure with a `reason`.
 */
export function validateRelay(
	uri: string,
	opts: { allowList: readonly RelayOrigin[]; sameOrigin: URL | null },
): RelayValidation {
	const candidate = parseOrigin(uri);
	if (!candidate) return { allowed: false, reason: 'malformed' };

	// Loopback short-circuit. RFC 8252 §7.3 — port is OS-assigned, can't
	// be pinned; scheme must be `http` (loopback never has TLS).
	if (LOOPBACK_HOSTS.has(candidate.host)) {
		if (candidate.scheme !== 'http') {
			return { allowed: false, reason: 'plaintext-non-loopback' };
		}
		return { allowed: true };
	}

	// Same-origin allowance: backend's host = candidate's host, schemes
	// match, ports match (URL.port returns '' for default-port URLs;
	// candidate.hasPort is `false` in that case).
	if (opts.sameOrigin) {
		const so = parseOrigin(opts.sameOrigin.toString());
		if (so && originsEqual(so, candidate)) return { allowed: true };
	}

	// Plain HTTP non-loopback: reject before allowlist lookup so the
	// failure reason is the security one ("plaintext-non-loopback"), not
	// a generic "not in allowlist". Customers misconfigure HTTP often
	// enough that the precise message saves a debugging round-trip.
	if (candidate.scheme === 'http') {
		return { allowed: false, reason: 'plaintext-non-loopback' };
	}

	// Allowlist match: scheme + host + (port if entry has one).
	for (const entryRaw of opts.allowList) {
		const entry = parseOrigin(entryRaw);
		if (!entry) continue; // shouldn't happen — entries went through `relayOrigin`
		if (originsEqual(entry, candidate)) return { allowed: true };
	}
	return { allowed: false, reason: 'unknown-origin' };
}

/** Structural origin equality: scheme + host required, port only when the entry pins one. */
function originsEqual(a: ParsedOrigin, b: ParsedOrigin): boolean {
	if (a.scheme !== b.scheme) return false;
	if (a.host !== b.host) return false;
	if (!a.hasPort) return true;
	return a.hasPort === b.hasPort && a.port === b.port;
}

function relayConfigError(message: string): Error {
	const err = new Error(message);
	err.name = 'RelayConfigError';
	return brandBlocksError(err);
}
