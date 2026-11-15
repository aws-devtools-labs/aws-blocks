// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The one check every same-origin redirect target goes through: the
 * `redirectPath` of a sign-in (`getSignInUrl()` and
 * `GET /aws-blocks/auth/signin/<id>?redirectPath=`), `redirects.postSignInPath`
 * and `redirects.postSignOutPath`. Anything that becomes a `Location` header
 * (or the path part of an absolute URL handed to an IdP) is passed through
 * {@link safeRedirectPath}, and its **normalised** result is what is emitted —
 * never the caller's raw string.
 *
 * A string check alone is not enough. A browser parses `Location` with the
 * WHATWG URL parser, which strips TAB, CR and LF anywhere in the input and
 * treats `\` as `/`, so `/\t/evil.example` arrives as `//evil.example` — a
 * protocol-relative URL on another origin. Dot segments collapse the same
 * way (`/.//evil.example` → `//evil.example`). So the path is resolved with
 * the same parser against a placeholder origin, and is safe only if it stays
 * on that origin; the re-serialised `pathname + search + hash` is then checked
 * once more, because it is what the browser will parse.
 *
 * Pure (only `URL`, plus `ApiError` for {@link signInRedirectPath}) — safe in
 * every entry point.
 *
 * @internal
 */

import { ApiError } from '@aws-blocks/core';
import { AuthErrors } from './errors.js';

/** A placeholder origin no real request can have (`.invalid` is reserved, RFC 6761). */
const PLACEHOLDER_ORIGIN = 'http://redirect-check.invalid';

/** C0 controls, DEL and backslash: a browser drops or rewrites each of them while parsing a URL. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters is the point
const UNSAFE_CHARACTERS = /[\u0000-\u001f\u007f\\]/;

/** Resolve `path` against the placeholder origin; `null` unless it is a single-`/` path that stays there. */
function resolveSameOrigin(path: string): string | null {
	if (!path.startsWith('/') || path.startsWith('//') || UNSAFE_CHARACTERS.test(path)) return null;
	let url: URL;
	try {
		url = new URL(path, PLACEHOLDER_ORIGIN);
	} catch {
		return null;
	}
	if (url.origin !== PLACEHOLDER_ORIGIN) return null;
	return `${url.pathname}${url.search}${url.hash}`;
}

/**
 * The normalised same-origin form of `path` — the string to emit as a
 * redirect target — or `null` when `path` is not a safe same-origin path.
 *
 * Safe means: a string starting with a single `/`, containing no control
 * character (U+0000–U+001F, U+007F) and no `\`, that the WHATWG URL parser
 * resolves to the same origin; and whose normalised form (after dot segments
 * collapse) still does. Query and fragment are kept. Absolute URLs,
 * protocol-relative `//host`, `javascript:` and relative paths are refused.
 *
 * @example
 * ```ts
 * safeRedirectPath('/dashboard?tab=2#top'); // '/dashboard?tab=2#top'
 * safeRedirectPath('/a b');                 // '/a%20b'
 * safeRedirectPath('/\t/evil.example');     // null — a browser would land on evil.example
 * safeRedirectPath('/.//evil.example');     // null — collapses to //evil.example
 * ```
 *
 * @internal
 */
export function safeRedirectPath(path: unknown): string | null {
	if (typeof path !== 'string') return null;
	const normalised = resolveSameOrigin(path);
	if (normalised === null) return null;
	// The normalised form is what a browser parses: it must be safe in its own right.
	return resolveSameOrigin(normalised) === normalised ? normalised : null;
}

/**
 * Whether `path` is a safe same-origin redirect target (`/x`, never `//host`
 * or a backslash trick — see {@link safeRedirectPath}). Emit
 * `safeRedirectPath(path)`, not `path`.
 *
 * @internal
 */
export function isSafeRedirectPath(path: string): boolean {
	return safeRedirectPath(path) !== null;
}

/**
 * A sign-in's `redirectPath` (`getSignInUrl()` / the sign-in route), normalised
 * for the pending cookie: `undefined` when none was given, else the
 * {@link safeRedirectPath} form. Throws a 400 `InvalidParameter` `ApiError` for
 * an unsafe one.
 *
 * @internal
 */
export function signInRedirectPath(redirectPath: string | undefined): string | undefined {
	if (redirectPath === undefined) return undefined;
	const safe = safeRedirectPath(redirectPath);
	if (safe === null) {
		throw new ApiError('redirectPath must be a same-origin path starting with a single "/".', 400, {
			name: AuthErrors.InvalidParameter,
		});
	}
	return safe;
}
