// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Shared session-cookie security policy for all Blocks auth Building Blocks.
 *
 * Historically each of the three auth BBs that `Auth` (`bb-auth`) has since
 * replaced — the removed `bb-auth-basic`, `bb-auth-cognito` and
 * `bb-auth-oidc` — hand-rolled its own `SameSite` / `Secure` / `Partitioned`
 * selection. They drifted: basic and cognito defaulted to `SameSite=None`
 * (chosen to survive the legacy cross-port dev setup, frontend :3000 +
 * API :3001), while oidc defaulted to `SameSite=Lax`.
 *
 * With the single-origin dev proxy the API and frontend share one origin in
 * local dev, so the cross-port reason for `None` is gone. All three BBs then
 * defaulted to `SameSite=Lax` and routed every cookie set/clear through the
 * helpers in this module so they converged **structurally** rather than by
 * coincidence of matching strings. `Auth` (`bb-auth`), which replaced all
 * three, does the same.
 *
 * @module
 */

import type { BlocksContext } from '@aws-blocks/core';

/**
 * Inputs that determine the security attributes of a session cookie.
 */
export interface CookieSecurityInput {
	/**
	 * Whether the frontend and API are served from different registrable
	 * domains in production (e.g. frontend on Vercel, API on AWS). When
	 * `true`, the cookie must be `SameSite=None; Secure` (plus `Partitioned`
	 * off localhost) to survive the cross-site request. Defaults to `false`
	 * for same-origin apps and the local dev proxy.
	 */
	crossDomain: boolean;
	/**
	 * Whether the request is being served over plain-HTTP localhost. On
	 * localhost we drop `Secure` for the `Lax` default (honest about
	 * plain-HTTP dev — `Lax` does not require `Secure`) and drop
	 * `Partitioned` for the cross-domain recipe (Chrome's CHIPS cookies
	 * require `Secure` over HTTPS, so the attribute is dropped on
	 * plain-HTTP localhost).
	 */
	isLocalhost: boolean;
}

/**
 * Canonical session-cookie security attributes. These are the three
 * attributes that diverged across the auth BBs; `HttpOnly`, `Path`, and
 * `Max-Age` are added by each BB at the cookie-construction site.
 */
export interface CookieSecurityAttributes {
	sameSite: 'Lax' | 'None';
	secure: boolean;
	partitioned: boolean;
}

/**
 * Resolve the canonical cookie security attributes for the given inputs.
 *
 * | crossDomain | isLocalhost | result                                 |
 * |-------------|-------------|----------------------------------------|
 * | `false`     | `false`     | `SameSite=Lax; Secure`                 |
 * | `false`     | `true`      | `SameSite=Lax`                         |
 * | `true`      | `false`     | `SameSite=None; Secure; Partitioned`   |
 * | `true`      | `true`      | `SameSite=None; Secure`                |
 *
 * @param input - Whether the deploy is cross-domain and whether the request
 *   is plain-HTTP localhost.
 * @returns The `sameSite` / `secure` / `partitioned` values to apply.
 */
export function resolveCookieSecurity(input: CookieSecurityInput): CookieSecurityAttributes {
	if (input.crossDomain) {
		// `SameSite=None` is only honored with `Secure` (all browsers).
		// `Partitioned` (CHIPS) additionally requires `Secure` over HTTPS, so
		// it is dropped on plain-HTTP localhost.
		return {
			sameSite: 'None',
			secure: true,
			partitioned: !input.isLocalhost,
		};
	}
	// Same-origin default (incl. the local dev proxy). `Lax` does not require
	// `Secure`, so we omit it on plain-HTTP localhost and keep it in prod for
	// defense-in-depth. `Partitioned` is unnecessary for a same-site cookie.
	return {
		sameSite: 'Lax',
		secure: !input.isLocalhost,
		partitioned: false,
	};
}

/**
 * Build the canonical security-attribute substring of a `Set-Cookie`
 * header (`SameSite=…[; Secure][; Partitioned]`) for the given inputs.
 *
 * `bb-auth` assembles its cookie strings by hand: it concatenates this with
 * the cookie name/value, `HttpOnly`, `Path`, and `Max-Age` (as the removed
 * `bb-auth-basic` / `bb-auth-cognito` did before it). Routing through one builder is what
 * keeps the family from drifting again.
 *
 * @param input - Whether the deploy is cross-domain and whether the request
 *   is plain-HTTP localhost.
 * @returns e.g. `"SameSite=Lax"`, `"SameSite=Lax; Secure"`, or
 *   `"SameSite=None; Secure; Partitioned"`.
 */
export function buildCookieSecurityAttrs(input: CookieSecurityInput): string {
	const { sameSite, secure, partitioned } = resolveCookieSecurity(input);
	const parts: string[] = [`SameSite=${sameSite}`];
	if (secure) parts.push('Secure');
	if (partitioned) parts.push('Partitioned');
	return parts.join('; ');
}

/**
 * Detect whether a request originates from a loopback host
 * (`localhost`, `127.0.0.1`, `[::1]`) by inspecting the `Origin` header
 * (falling back to `Host`).
 *
 * `bb-auth` selects cookie attributes per request and uses this to feed
 * `isLocalhost` (as the removed `bb-auth-basic` / `bb-auth-cognito` did
 * before it). The removed OIDC BB instead decided localhost-ness at construction time via its
 * runtime entry point (mock vs aws), so it did not call this.
 *
 * We can't sniff `https://` reliably because the Blocks dev server always
 * serves plain HTTP even when fronted by HTTPS in production.
 *
 * @param ctx - The request context.
 * @returns `true` for loopback origins, `false` otherwise.
 */
export function isLoopbackRequest(ctx: BlocksContext): boolean {
	const origin = ctx.request.headers.get('origin') ?? ctx.request.headers.get('host') ?? '';
	return /^(https?:\/\/)?(localhost|127\.0\.0\.1|\[::1\])(:\d+)?\/?$/.test(origin);
}
