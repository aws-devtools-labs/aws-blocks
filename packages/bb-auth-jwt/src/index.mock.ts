// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Local-dev / test entry point for AuthBearerJwt.
 *
 * Production `AuthBearerJwt` verifies tokens against a remote JWKS endpoint,
 * which needs network access and a real issuer. `createLocalJwt()` closes that
 * gap for offline dev/tests: it generates an in-process ES256 key pair, wires
 * the public key in as a **local** JWKS (`jose.createLocalJWKSet`, no network),
 * and hands back a `mint()` helper that signs verifiable tokens with the
 * matching private key. The returned `auth` is a normal `AuthBearerJwt` and
 * behaves identically to production for verification.
 *
 * @example
 * ```typescript
 * const { auth, mint } = createLocalJwt({ id: 'app' }, 'auth');
 * const token = await mint({ sub: 'user-1', email: 'a@b.com' });
 * // send `Authorization: Bearer ${token}` to a handler that calls auth.requireAuth(context)
 * ```
 */
import { SignJWT, createLocalJWKSet, type JWK } from 'jose';
import { generateKeyPairSync } from 'node:crypto';
import type { ScopeParent } from '@aws-blocks/core';
import { AuthBearerJwt } from './index.js';

export { AuthBearerJwt, AuthBearerJwtErrors } from './index.js';
export type { AuthBearerUser, AuthBearerJwtOptions, SecretLike } from './index.js';

/** Options for {@link createLocalJwt}. */
export interface LocalJwtOptions {
	/** Issuer the tokens carry and the block validates. @default 'https://local-dev.example.com' */
	issuer?: string;
	/** Expected audience. When set, minted tokens carry it and the block enforces it. */
	audience?: string;
	/** Claims that must be present. @default [] */
	requiredClaims?: string[];
	/** Which claim carries the subject. @default 'sub' */
	subjectClaim?: string;
}

/** Claims accepted by {@link LocalJwt.mint}. */
export interface MintClaims {
	/** Subject id. @default a fixed dev value */
	sub?: string;
	email?: string;
	/** Token lifetime, jose format. @default '1h' */
	expiresIn?: string;
	/** Any additional claims (e.g. custom RLS claims). */
	[claim: string]: unknown;
}

/** Handle returned by {@link createLocalJwt}. */
export interface LocalJwt {
	/** A production `AuthBearerJwt` wired to a local, in-memory JWKS. */
	auth: AuthBearerJwt;
	/** Mint a signed, verifiable token. */
	mint(claims?: MintClaims): Promise<string>;
	/** The issuer the tokens carry and the block validates. */
	issuer: string;
	/** The public JWK served by the local JWKS. */
	publicJwk: JWK;
}

const DEFAULT_SUB = '00000000-0000-0000-0000-00000000dev0';
const DEFAULT_ISSUER = 'https://local-dev.example.com';

/**
 * Build an `AuthBearerJwt` backed by a locally-generated ES256 key + in-memory
 * JWKS, plus a `mint()` token factory. No network, no real issuer.
 *
 * Synchronous by design: this is called at module scope from a backend
 * definition, and that module is bundled to CJS for Lambda, where a top-level
 * `await` is a build error. The key pair is therefore generated with Node's
 * synchronous crypto rather than jose's promise-based `generateKeyPair`.
 */
export function createLocalJwt(
	scope: ScopeParent,
	id: string,
	options: LocalJwtOptions = {},
): LocalJwt {
	const issuer = options.issuer ?? DEFAULT_ISSUER;
	const audience = options.audience;

	const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
	const kid = 'local-dev-key';
	const publicJwk: JWK = {
		...(publicKey.export({ format: 'jwk' }) as JWK),
		kid,
		alg: 'ES256',
		use: 'sig',
	};

	// Local (in-memory) JWKS — same resolver shape as createRemoteJWKSet, no fetch.
	const jwks = createLocalJWKSet({ keys: [publicJwk] });

	const auth = new AuthBearerJwt(scope, id, {
		issuer,
		jwks,
		audience,
		requiredClaims: options.requiredClaims,
		subjectClaim: options.subjectClaim,
	});

	async function mint(claims: MintClaims = {}): Promise<string> {
		const { sub = DEFAULT_SUB, email, expiresIn = '1h', ...extra } = claims;
		const payload: Record<string, unknown> = { ...extra };
		if (email !== undefined) payload.email = email;
		let builder = new SignJWT(payload)
			.setProtectedHeader({ alg: 'ES256', kid })
			.setIssuer(issuer)
			.setSubject(sub)
			.setIssuedAt()
			.setExpirationTime(expiresIn);
		if (audience) builder = builder.setAudience(audience);
		return builder.sign(privateKey);
	}

	return { auth, mint, issuer, publicJwk };
}
