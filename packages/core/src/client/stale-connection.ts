// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Stale keep-alive socket handling for the API client (internal; not a package export).
 *
 * Node's `fetch` (undici) pools keep-alive sockets. A server may close an idle pooled
 * socket at any moment (API Gateway and load balancers don't advertise a keep-alive
 * timeout). If that close crosses the next request in flight, the request is written to
 * a socket the server has already closed, and `fetch` rejects with
 * `TypeError: fetch failed` whose `cause` is `SocketError: other side closed`
 * (`UND_ERR_SOCKET`) or `ECONNRESET` / `EPIPE`. undici does not resend it, for any method.
 *
 * Browsers already resend a request whose reused connection closed before any response
 * byte arrived (that is why a deployed frontend never sees this); this module gives Node
 * callers of the API client (CLIs, SSR, scripts) the same single resend.
 */

/** Socket error codes a request written to an already-closed pooled socket fails with. */
const STALE_CONNECTION_CODES: ReadonlySet<string> = new Set(['UND_ERR_SOCKET', 'ECONNRESET', 'EPIPE']);

/**
 * `true` when `err` is Node `fetch`'s network failure caused by the connection closing
 * before the response headers arrived: `TypeError('fetch failed')` with a `cause` whose
 * `code` is `UND_ERR_SOCKET`, `ECONNRESET` or `EPIPE`, or whose message is
 * `other side closed`.
 *
 * Everything else is `false`: timeouts (`UND_ERR_HEADERS_TIMEOUT`, `UND_ERR_BODY_TIMEOUT`,
 * `UND_ERR_CONNECT_TIMEOUT`, `ETIMEDOUT`), aborts (`AbortError` / `TimeoutError`), a refused
 * or unresolvable connection, and a browser's `TypeError('Failed to fetch')`, which has no
 * `cause` (browsers do their own resend).
 */
export function isStaleConnectionError(err: unknown): boolean {
	if (!(err instanceof TypeError)) return false;
	const cause: unknown = err.cause;
	if (typeof cause !== 'object' || cause === null) return false;
	const { code, message } = cause as { code?: unknown; message?: unknown };
	if (typeof code === 'string' && STALE_CONNECTION_CODES.has(code)) return true;
	return message === 'other side closed';
}

/**
 * `fetch(url, init)`, resent **once** if it fails with {@link isStaleConnectionError}.
 *
 * Only the `fetch()` call itself is retried, and `fetch()` resolves as soon as the response
 * headers arrive, so a failure after the response started (while reading the body) is never
 * retried. Timeouts and aborts are never retried. A second failure is thrown as is.
 *
 * `init.body` must be replayable (a string): the resend carries the identical bytes,
 * including the JSON-RPC `id`.
 *
 * Why resending a JSON-RPC POST is safe here: the server can't tell a resend from a new
 * call (the `id` is a per-process counter, not a deduplication key), so safety rests on
 * the first copy never having been executed. A pooled socket that the server closed while
 * idle had no request in flight on the server side: the close happened before the request
 * was read, so no handler ran. That is the failure this matches; it is what browsers resend
 * on too. The one ambiguous case is a connection lost after the server read the request
 * but before it sent the first response byte (a crashed server); behind API Gateway a
 * failed backend gets a `5xx` response instead, which is never retried.
 */
export async function fetchWithStaleConnectionRetry(url: string, init: RequestInit): Promise<Response> {
	try {
		return await fetch(url, init);
	} catch (err) {
		if (!isStaleConnectionError(err)) throw err;
		return fetch(url, init);
	}
}
