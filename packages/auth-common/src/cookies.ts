// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Shared session-cookie security policy for all CDK Blocks auth Building Blocks.
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

import { type BlocksContext, blocksError, getCachedConfigValue, getDeploymentType } from '@aws-cdk-blocks/core';
import { AuthErrors } from './errors.js';

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
	 * over HTTP, which would break the session). It doesn't change a
	 * `SameSite=None` (cross-domain) cookie: that one is set by the API's own
	 * response, on the API's (HTTPS) origin — e.g. behind `frontDoor: 'none'`,
	 * where the page is an HTTP S3 website and the API is cross-site — so it
	 * keeps `Secure` and `Partitioned`. Derived from the front door's own scheme
	 * (`BLOCKS_PUBLIC_ORIGIN`), never from a forgeable request header. Defaults to
	 * `false` (assume HTTPS) when unset.
	 *
	 * Dropping `Secure` is allowed only in a sandbox deploy (and local
	 * processes). Outside a sandbox ({@link getDeploymentType} is
	 * `'production'`, which includes deployed compute whose config does not say
	 * otherwise), {@link resolveCookieSecurity} refuses to issue the same-origin
	 * cookie and throws `AuthErrors.InsecureTransport` instead (unless
	 * {@link CookieSecurityInput.clearing}).
	 *
	 * The one exception outside a sandbox is the front door's explicit
	 * `allowPlainHttp: true` opt-out, which `Hosting` delivers to the runtime as
	 * the config entry `BLOCKS_ALLOW_PLAIN_HTTP` with the exact value `'true'`:
	 * the cookie is then issued without `Secure`, as in a sandbox. A missing or
	 * any other value refuses, as above. On deployed compute only the loaded
	 * config entry counts (an environment variable of the same name is ignored).
	 */
	plainHttpOrigin?: boolean;
	/**
	 * Whether the cookie being built clears an existing one (`Max-Age=0`, an
	 * empty value). A clearing cookie carries nothing worth protecting, so it is
	 * never refused over a plain-HTTP front door: sign-out and account deletion
	 * still drop the cookie outside a sandbox. Its attributes are resolved as for
	 * any other cookie. Defaults to `false`.
	 */
	clearing?: boolean;
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
 * | crossDomain | isLocalhost | plainHttpOrigin | result                                 |
 * |-------------|-------------|-----------------|----------------------------------------|
 * | `false`     | `false`     | `false`         | `SameSite=Lax; Secure`                 |
 * | `false`     | `false`     | `true`          | `SameSite=Lax` (sandbox, a clearing cookie, or the door's `allowPlainHttp` opt-out); throws (production) |
 * | `false`     | `true`      | any             | `SameSite=Lax`                         |
 * | `true`      | `false`     | any             | `SameSite=None; Secure; Partitioned`   |
 * | `true`      | `true`      | any             | `SameSite=None; Secure`                |
 *
 * @param input - Whether the deploy is cross-domain and whether the request
 *   is plain-HTTP localhost.
 * @returns The `sameSite` / `secure` / `partitioned` values to apply.
 * @throws `AuthErrors.InsecureTransport` (`InsecureTransportException`, a
 *   branded CDK Blocks error) for a same-origin cookie over a plain-HTTP front door
 *   (`plainHttpOrigin`, not localhost) outside a sandbox deploy: a session is
 *   never issued without `Secure` in production. A clearing cookie
 *   (`clearing`) is never refused, and neither is a cookie behind a door that
 *   set `allowPlainHttp: true` (config `BLOCKS_ALLOW_PLAIN_HTTP` is `'true'`).
 */
export function resolveCookieSecurity(input: CookieSecurityInput): CookieSecurityAttributes {
	// Plain-HTTP transport — localhost OR a deployed HTTP-only front door — cannot
	// carry a `Secure` cookie.
	const plainHttp = input.isLocalhost || input.plainHttpOrigin === true;
	if (input.crossDomain) {
		// `SameSite=None` is only honored with `Secure` (all browsers), so it stays
		// `Secure`. The cookie is set by the API's own response on the API's origin
		// (HTTPS when deployed), whatever the page's scheme — so a plain-HTTP front
		// door doesn't change it. `Partitioned` (CHIPS) requires `Secure` over
		// HTTPS, so it is dropped on plain-HTTP localhost only.
		return {
			sameSite: 'None',
			secure: true,
			partitioned: !input.isLocalhost,
		};
	}
	// Same-origin default (incl. the local dev proxy and a same-origin HTTP door
	// like an ALB with no TLS listener). `Lax` does not require `Secure`, so we
	// omit it over plain HTTP and keep it on HTTPS for defense-in-depth.
	// `Partitioned` is unnecessary for a same-site cookie.
	// Outside a sandbox a plain-HTTP front door gets no session at all (synth
	// already fails for that door; this is the runtime backstop). Deployed
	// compute with no deployment type in its config reports `'production'`, so
	// this fails closed.
	// A clearing cookie (`clearing`) carries no value, so it is let through.
	if (
		!input.isLocalhost &&
		input.plainHttpOrigin === true &&
		input.clearing !== true &&
		getDeploymentType() === 'production' &&
		!isPlainHttpAllowed()
	) {
		throw blocksError(
			AuthErrors.InsecureTransport,
			'The auth block refuses to issue a session cookie over a plain-HTTP front door outside a sandbox deploy: ' +
				'the cookie could not carry `Secure`. Give the front door a certificate and a domain (an HTTPS listener), ' +
				'or use the CloudFront door. Only if the network path is trusted (a private network, or TLS ended upstream), ' +
				'set `allowPlainHttp: true` on the front door and redeploy.',
		);
	}
	return {
		sameSite: 'Lax',
		secure: !plainHttp,
		partitioned: false,
	};
}

/**
 * Whether the deploy's front door opted out of the plain-HTTP refusal
 * (`allowPlainHttp: true`): the config entry `BLOCKS_ALLOW_PLAIN_HTTP`, which
 * `Hosting` registers at synth, is exactly `'true'`. Fails closed: a missing,
 * empty or any other value is `false`.
 *
 * Read like `getDeploymentType()` reads `BLOCKS_DEPLOYMENT_TYPE`: on deployed
 * compute (`BLOCKS_CONFIG_BUCKET` and `BLOCKS_CONFIG_KEY` set) only the loaded
 * config counts, so an environment variable set on the compute cannot opt
 * out; elsewhere (synth, local processes, tests) `process.env` is read.
 */
function isPlainHttpAllowed(): boolean {
	const deployed = Boolean(process.env.BLOCKS_CONFIG_BUCKET) && Boolean(process.env.BLOCKS_CONFIG_KEY);
	const value = deployed ? getCachedConfigValue('BLOCKS_ALLOW_PLAIN_HTTP') : process.env.BLOCKS_ALLOW_PLAIN_HTTP;
	return value === 'true';
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
 * @throws `AuthErrors.InsecureTransport` where {@link resolveCookieSecurity} does.
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
 * `bb-auth` selects cookie attributes per request and feeds `isLocalhost`
 * from {@link isLocalDevRequest}, which applies this check only in a local
 * process (the removed `bb-auth-basic` / `bb-auth-cognito` did the same).
 * The removed OIDC BB instead decided localhost-ness at construction time via
 * its runtime entry point (mock vs aws), so it did not call this.
 *
 * We can't sniff `https://` reliably because the CDK Blocks dev server always
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
 * Whether a request should get the plain-HTTP local-dev cookie attributes
 * ({@link CookieSecurityInput.isLocalhost}): the process is running locally
 * AND the request comes from a loopback origin.
 *
 * The local-vs-deployed half comes from deploy configuration
 * (`getDeploymentType()`, which reads the config synth stamps on every
 * CDK Blocks-configured compute), never from a request header. So on deployed
 * compute a request that sends `Origin: http://localhost` cannot drop `Secure`
 * or `Partitioned`; the header only picks between loopback and non-loopback
 * callers of the local dev server and tests.
 *
 * On compute CDK Blocks does not configure (no deploy config present) this falls
 * back to the header check alone, the same boundary `getDeploymentType()`
 * documents.
 *
 * @param ctx - The request context.
 * @returns `true` only for a loopback request in a local process.
 */
export function isLocalDevRequest(ctx: BlocksContext): boolean {
	return getDeploymentType() === 'local' && isLoopbackRequest(ctx);
}

/**
 * Whether the DEPLOYED public front door serves over plain HTTP, decided from
 * its OWN scheme rather than a request header. CDK Blocks Hosting registers the
 * public origin as `BLOCKS_PUBLIC_ORIGIN` (the front door's URL: `https://…` for
 * CloudFront / a TLS ALB / a custom domain, `http://…` for an S3-website
 * endpoint or a TLS-less ALB). A `Secure` cookie set over such an HTTP door is
 * silently dropped by the browser, so BBs feed this into
 * {@link CookieSecurityInput.plainHttpOrigin} to omit `Secure` on the
 * same-origin `Lax` cookie. Config-derived and trustworthy — unlike sniffing
 * `X-Forwarded-Proto`, which a client can forge. Returns `false` (assume HTTPS)
 * when the origin is unset or not parseable, so HTTPS deploys keep `Secure`.
 * Outside a sandbox deploy a `true` here makes {@link resolveCookieSecurity}
 * refuse the same-origin cookie (`AuthErrors.InsecureTransport`), unless the
 * door set `allowPlainHttp: true` (config `BLOCKS_ALLOW_PLAIN_HTTP`).
 */
export function isInsecurePublicOrigin(): boolean {
	const origin = process.env.BLOCKS_PUBLIC_ORIGIN;
	return typeof origin === 'string' && origin.startsWith('http://');
}
