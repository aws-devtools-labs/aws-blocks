// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Request hardening for the mutating routes.
 *
 * The session token is the primary defence and it is already sufficient: an
 * attacker's page cannot read it, so it cannot forge an authorised request.
 * This module is the belt to that braces, and it exists because of exactly how
 * the reference implementation fails.
 *
 * That console binds loopback and carries no auth at all, checking neither
 * `Origin` nor `Content-Type`. Any page the developer visits in the same
 * browser can therefore `POST /console-api/unlock` and then
 * `POST /console-api/write/cloud-delete` against their live stack — and because
 * the body's content type is never checked, the attacker can send it as a CORS
 * *simple* request, which needs no preflight. The same-origin policy stops them
 * reading the response; it does not stop the write. Loopback binding is not a
 * mitigation against an attacker who is inside the browser.
 *
 * So: a mutating request must look like it came from our own page rather than
 * from a form or an `<img>` on someone else's.
 */

/** Outcome of the guard. `ok: false` carries the exact response to send. */
export type MutationGuard = { ok: true } | { ok: false; status: number; message: string };

const JSON_CONTENT_TYPE = 'application/json';

/**
 * Extra origins the developer has declared trustworthy, comma-separated.
 *
 * Set by the CLI's `--allow-origin`, and readable directly for a caller that
 * does not go through it. Exists because the Host comparison below assumes the
 * browser reaches the dashboard on the port it bound, which is false behind any
 * reverse proxy: a tunnel serves the page from `https://<name>/` (origin port
 * 443) and forwards to loopback, so `Origin` and `Host` cannot agree and every
 * mutating request is refused — including the unlock, which left cloud writes
 * permanently locked with no way to open them.
 *
 * Opt-in by exact origin rather than inferred from `X-Forwarded-*`. The
 * forwarded headers would fix every proxy with no configuration, but trusting
 * them means trusting whoever can set them, which is only sound while the
 * listener stays loopback-only — a property this module must not silently
 * depend on. Naming the origin keeps the guard's actual job intact: a page the
 * developer merely visits is still refused, because it is not that origin.
 */
export const ALLOWED_ORIGIN_ENV_VAR = 'BLOCKS_DASHBOARD_ALLOWED_ORIGIN';

/**
 * The declared origins, canonicalised to `scheme://host[:port]`.
 *
 * Read per call rather than cached: the guard runs per request and the env var
 * is set before Next boots, so there is nothing to gain and a cache would make
 * the value untestable. Unparseable entries are dropped instead of throwing —
 * a typo in this setting must not take the dashboard down — and because every
 * comparison is against a parsed origin, a wildcard or a bare hostname cannot
 * become an accidental match-all.
 */
export function allowedOrigins(): string[] {
	const raw = process.env[ALLOWED_ORIGIN_ENV_VAR];
	if (!raw) return [];
	const origins: string[] = [];
	for (const entry of raw.split(',')) {
		const canonical = canonicalOrigin(entry.trim());
		if (canonical !== undefined && !origins.includes(canonical)) origins.push(canonical);
	}
	return origins;
}

/** `origin` as `scheme://host[:port]`, or undefined when it is not a URL. */
function canonicalOrigin(origin: string): string | undefined {
	if (origin === '') return undefined;
	try {
		const parsed = new URL(origin);
		// A URL with no host ('file:', 'data:') has origin 'null', which must never
		// match the literal 'null' Origin header a sandboxed frame sends.
		return parsed.origin === 'null' ? undefined : parsed.origin;
	} catch {
		return undefined;
	}
}

/** True when the developer declared this exact origin trustworthy. */
function isAllowedOrigin(origin: string): boolean {
	const canonical = canonicalOrigin(origin);
	return canonical !== undefined && allowedOrigins().includes(canonical);
}

/**
 * Hosts that mean "this machine". The dashboard binds 127.0.0.1, but a browser
 * may have been pointed at any of these aliases, and they are all the same
 * origin for our purposes.
 */
const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

function isLoopbackHost(hostname: string): boolean {
	return LOOPBACK_HOSTNAMES.has(hostname.toLowerCase());
}

/**
 * Checks a mutating request before its body is trusted.
 *
 * Three checks, each closing a different path:
 *
 * 1. `Content-Type` must be JSON. This is the one that matters most: it is what
 *    makes the request non-simple, so a cross-site attempt needs a preflight
 *    the browser will refuse. A form post arrives as
 *    `application/x-www-form-urlencoded` or `text/plain` and is rejected here.
 * 2. `Origin`, when the browser sent one, must be this server's own origin or
 *    one the developer declared via {@link ALLOWED_ORIGIN_ENV_VAR}. An absent
 *    `Origin` is allowed, because a non-browser client (curl, a script,
 *    the CLI) legitimately omits it — and such a client had to hold the session
 *    token to get this far anyway.
 * 3. `Sec-Fetch-Site`, when present, must be `same-origin` or `none`. Browsers
 *    set this and pages cannot forge it, so it is a cheap, strong signal. A
 *    declared origin does NOT relax this: it is checked first and on its own,
 *    so an attacker's page making a genuinely cross-site request is refused
 *    even if it manages to spell a declared origin in its `Origin` header.
 */
export function guardMutation(request: Request): MutationGuard {
	const contentType = request.headers.get('content-type') ?? '';
	if (!contentType.toLowerCase().split(';')[0]?.trim().startsWith(JSON_CONTENT_TYPE)) {
		return {
			ok: false,
			status: 415,
			message: `Mutating requests must be sent with Content-Type: ${JSON_CONTENT_TYPE}.`,
		};
	}

	const fetchSite = request.headers.get('sec-fetch-site');
	if (fetchSite !== null && fetchSite !== 'same-origin' && fetchSite !== 'none') {
		return {
			ok: false,
			status: 403,
			message: `Cross-site mutating requests are refused (Sec-Fetch-Site: ${fetchSite}).`,
		};
	}

	const origin = request.headers.get('origin');
	// A browser omits Origin on some same-origin requests, and non-browser
	// clients omit it entirely. Absent is therefore not suspicious; present and
	// foreign is — unless the developer declared it, which is how the dashboard
	// stays usable behind a tunnel.
	if (origin !== null && origin !== 'null' && !isSameOrigin(origin, request) && !isAllowedOrigin(origin)) {
		return { ok: false, status: 403, message: `Mutating requests from origin ${origin} are refused.` };
	}

	return { ok: true };
}

/**
 * True when `origin` names this same server.
 *
 * Compared against the request's own `Host`, since the dashboard's port is
 * chosen at runtime (first free from 4400) and the route cannot know it. Any
 * loopback alias matches any other on the same port, because they are the same
 * server as far as the developer's browser is concerned.
 */
function isSameOrigin(origin: string, request: Request): boolean {
	let originUrl: URL;
	try {
		originUrl = new URL(origin);
	} catch {
		return false;
	}

	const host = request.headers.get('host');
	if (host !== null) {
		const [hostName, hostPort] = splitHost(host);
		const originPort = originUrl.port !== '' ? originUrl.port : defaultPortFor(originUrl.protocol);
		if (
			originPort === hostPort &&
			(originUrl.hostname === hostName || (isLoopbackHost(originUrl.hostname) && isLoopbackHost(hostName)))
		) {
			return true;
		}
		return false;
	}

	// No Host header to compare against (should not happen over HTTP/1.1). Fall
	// back to accepting only loopback origins rather than accepting anything.
	return isLoopbackHost(originUrl.hostname);
}

function splitHost(host: string): [string, string] {
	// IPv6 literals are bracketed: [::1]:4400
	if (host.startsWith('[')) {
		const close = host.indexOf(']');
		if (close !== -1) {
			const name = host.slice(0, close + 1);
			const port = host.slice(close + 2);
			return [name.toLowerCase(), port];
		}
	}
	const colon = host.lastIndexOf(':');
	if (colon === -1) return [host.toLowerCase(), ''];
	return [host.slice(0, colon).toLowerCase(), host.slice(colon + 1)];
}

function defaultPortFor(protocol: string): string {
	if (protocol === 'https:') return '443';
	if (protocol === 'http:') return '80';
	return '';
}
