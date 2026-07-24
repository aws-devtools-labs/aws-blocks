// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Framework-agnostic Supabase JWT verifier.
 *
 * Validates a Supabase-issued JWT **locally** using `jose`, with zero
 * per-request round-trips to the Supabase auth server:
 *
 *  - Asymmetric tokens (ES256 / RS256 — Supabase's new signing-key era) are
 *    verified against the project's JWKS at
 *    `<supabaseUrl>/auth/v1/.well-known/jwks.json`. The key set is fetched
 *    once and cached in-process (per Lambda container); `jose` handles key
 *    rotation and re-fetch on unknown `kid`.
 *  - Symmetric tokens (HS256 — legacy anon / service-role era) are verified
 *    against the project's shared JWT secret, supplied via `getSecret`.
 *
 * The signing algorithm is auto-detected from the token's protected header,
 * so a single verifier transparently supports both eras. `iss`, `aud` and
 * `exp` are always enforced.
 */
import { createRemoteJWKSet, jwtVerify, decodeProtectedHeader } from 'jose';
import type { JWTVerifyGetKey } from 'jose';
import type { SupabaseClaims } from './types.js';

export interface VerifierConfig {
	/** Supabase project URL, e.g. `https://abcxyz.supabase.co`. */
	supabaseUrl: string;
	/** Expected `aud` claim. Defaults to `'authenticated'`. */
	audience?: string;
	/**
	 * Resolver for the legacy HS256 shared secret. Required only when the
	 * incoming tokens are HS*-signed; asymmetric tokens ignore it.
	 */
	getSecret?: () => Promise<string>;
}

export type SupabaseVerifier = (token: string) => Promise<SupabaseClaims>;

/** Strip trailing slashes and derive the Supabase auth issuer URL. */
export function issuerFor(supabaseUrl: string): string {
	return `${supabaseUrl.replace(/\/+$/, '')}/auth/v1`;
}

/**
 * Build a reusable verifier bound to one Supabase project. The returned
 * function is safe to cache and call concurrently.
 */
export function createSupabaseVerifier(config: VerifierConfig): SupabaseVerifier {
	const issuer = issuerFor(config.supabaseUrl);
	const audience = config.audience ?? 'authenticated';
	const jwksUrl = new URL(`${issuer}/.well-known/jwks.json`);

	// Lazily created and cached across invocations so JWKS is fetched at most
	// once per process.
	let jwks: JWTVerifyGetKey | undefined;

	return async function verify(token: string): Promise<SupabaseClaims> {
		let alg: string | undefined;
		try {
			alg = decodeProtectedHeader(token).alg;
		} catch {
			throw new Error('Malformed JWT: could not decode protected header');
		}

		const options = { issuer, audience };

		if (alg?.startsWith('HS')) {
			if (!config.getSecret) {
				throw new Error(`Token is ${alg}-signed but no HS256 secret is configured`);
			}
			const secret = new TextEncoder().encode(await config.getSecret());
			const { payload } = await jwtVerify(token, secret, options);
			return payload as SupabaseClaims;
		}

		if (!jwks) {
			jwks = createRemoteJWKSet(jwksUrl);
		}
		const { payload } = await jwtVerify(token, jwks, options);
		return payload as SupabaseClaims;
	};
}
