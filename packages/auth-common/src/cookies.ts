// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Shared session-cookie security policy for all Blocks auth Building Blocks.
 *
 * Historically each auth BB (`bb-auth-basic`, `bb-auth-cognito`,
 * `bb-auth-oidc`) hand-rolled its own `SameSite` / `Secure` / `Partitioned`
 * selection. They drifted: basic and cognito defaulted to `SameSite=None`
 * (chosen to survive the legacy cross-port dev setup, frontend :3000 +
 * API :3001), while oidc defaulted to `SameSite=Lax`.
 *
 * With the single-origin dev proxy the API and frontend share one origin in
 * local dev, so the cross-port reason for `None` is gone. All three BBs now
 * default to `SameSite=Lax` and route every cookie set/clear through the
 * helpers in this module so they converge **structurally** rather than by
 * coincidence of matching strings.
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
	/**
	 * Whether the DEPLOYED public front door serves over plain HTTP (not HTTPS) —
	 * e.g. an S3-website endpoint or an ALB with no TLS listener. Like localhost,
	 * such an origin cannot carry a `Secure` cookie, so on the same-origin `Lax`
	 * default we drop `Secure` (a browser silently discards a `Secure` cookie set
	 * over HTTP, which would break the session). A `SameSite=None` (cross-domain)
	 * cookie still requires `Secure` and therefore genuinely cannot work over such
	 * a door — an honest limitation of a TLS-less front door, not something this
	 * flag can paper over. Derived from the front door's own scheme
	 * (`BLOCKS_PUBLIC_ORIGIN`), never from a forgeable request header. Defaults to
	 * `false` (assume HTTPS) when unset.
	 */
	plainHttpOrigin?: boolean;
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
	// Plain-HTTP transport — localhost OR a deployed HTTP-only front door — cannot
	// carry a `Secure` cookie.
	const plainHttp = input.isLocalhost || input.plainHttpOrigin === true;
	if (input.crossDomain) {
		// `SameSite=None` is only honored with `Secure` (all browsers), so it stays
		// `Secure` even over plain HTTP — meaning a cross-domain cookie genuinely
		// cannot work behind a TLS-less door (an honest limitation, not a bug).
		// `Partitioned` (CHIPS) additionally requires `Secure` over HTTPS, so it is
		// dropped on any plain-HTTP transport.
		return {
			sameSite: 'None',
			secure: true,
			partitioned: !plainHttp,
		};
	}
	// Same-origin default (incl. the local dev proxy and a same-origin HTTP door
	// like an ALB with no TLS listener). `Lax` does not require `Secure`, so we
	// omit it over plain HTTP and keep it on HTTPS for defense-in-depth.
	// `Partitioned` is unnecessary for a same-site cookie.
	return {
		sameSite: 'Lax',
		secure: !plainHttp,
		partitioned: false,
	};
}

/**
 * Build the canonical security-attribute substring of a `Set-Cookie`
 * header (`SameSite=…[; Secure][; Partitioned]`) for the given inputs.
 *
 * BBs that assemble cookie strings by hand (`bb-auth-basic`,
 * `bb-auth-cognito`) concatenate this with the cookie name/value,
 * `HttpOnly`, `Path`, and `Max-Age`. Routing through one builder is what
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
 * BBs that select cookie attributes per-request (`bb-auth-basic`,
 * `bb-auth-cognito`) use this to feed `isLocalhost`. The OIDC BB instead
 * decides localhost-ness at construction time via its runtime entry point
 * (mock vs aws), so it does not call this.
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

/**
 * Whether the DEPLOYED public front door serves over plain HTTP, decided from
 * its OWN scheme rather than a request header. Blocks Hosting registers the
 * public origin as `BLOCKS_PUBLIC_ORIGIN` (the front door's URL: `https://…` for
 * CloudFront / a TLS ALB / a custom domain, `http://…` for an S3-website
 * endpoint or a TLS-less ALB). A `Secure` cookie set over such an HTTP door is
 * silently dropped by the browser, so BBs feed this into
 * {@link CookieSecurityInput.plainHttpOrigin} to omit `Secure` on the
 * same-origin `Lax` cookie. Config-derived and trustworthy — unlike sniffing
 * `X-Forwarded-Proto`, which a client can forge. Returns `false` (assume HTTPS)
 * when the origin is unset or not parseable, so HTTPS deploys keep `Secure`.
 */
export function isInsecurePublicOrigin(): boolean {
	const origin = process.env.BLOCKS_PUBLIC_ORIGIN;
	return typeof origin === 'string' && origin.startsWith('http://');
}
