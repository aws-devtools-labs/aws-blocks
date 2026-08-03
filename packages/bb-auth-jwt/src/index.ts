// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { Scope, type ScopeParent, type BlocksContext, ApiError } from '@aws-blocks/core';
import type { BlocksAuth, AuthUser } from '@aws-blocks/auth-common';
import {
  createRemoteJWKSet,
  jwtVerify,
  decodeProtectedHeader,
  decodeJwt,
  type JWTPayload,
  type JWTVerifyGetKey,
} from 'jose';
import { Logger } from '@aws-blocks/bb-logger';
import type { ChildLogger } from '@aws-blocks/bb-logger';

export type { BlocksAuth, AuthUser } from '@aws-blocks/auth-common';

/** A secret value, inline or resolved lazily at runtime (mirrors AuthOIDC's SecretLike). */
export type SecretLike = string | (() => string | Promise<string>);

/**
 * User shape returned by AuthBearerJwt. Extends the common `AuthUser` with the
 * full verified JWT claims — pass to `db.withRLS({ userId, claims })`.
 */
export interface AuthBearerUser extends AuthUser {
  claims: JWTPayload & Record<string, unknown>;
}

/**
 * Options for the AuthBearerJwt Building Block.
 *
 * Verifies an externally-issued bearer JWT (the identity provider's own client
 * SDK owns sign-in and token lifecycle) against a configured issuer + key set,
 * then surfaces the claims for RLS. Stateless: no session store, no infra.
 */
export interface AuthBearerJwtOptions {
  /**
   * Expected `iss`. One trusted issuer, or several. When more than one is
   * configured, the default `userId` becomes `${iss}:${sub}` so subjects from
   * different issuers can't collide.
   */
  issuer: string | string[];

  /**
   * Signing keys. Either a remote JWKS URL (recommended — fetched + cached),
   * a `{ [issuer]: jwksUri }` map (one JWKS per issuer), or a pre-built
   * resolver (`jose.createLocalJWKSet`, used by the local-dev mock).
   * Mutually exclusive with `hmacSecret`.
   */
  jwks?: string | Record<string, string> | JWTVerifyGetKey;

  /**
   * Symmetric (HS256) verification secret. OPT-IN ONLY — asymmetric JWKS is
   * the default and preferred path; a symmetric issuer must set this
   * explicitly, so HS256 is never silently accepted. Mutually exclusive with `jwks`.
   */
  hmacSecret?: SecretLike;

  /** Expected `aud`. When omitted, the audience check is skipped. */
  audience?: string;

  /**
   * Claims that must be present for downstream RLS to work. Missing → 401.
   * @default []
   */
  requiredClaims?: string[];

  /** Which claim carries the stable subject. @default 'sub' */
  subjectClaim?: string;

  /**
   * Map verified claims → the returned user. Overrides the default mapping
   * (`userId` from `subjectClaim` — or `${iss}:${sub}` when multi-issuer;
   * `username` from `email` ?? subject).
   */
  mapUser?: (claims: JWTPayload & Record<string, unknown>) => AuthBearerUser;

  /**
   * JWKS cache duration in ms. Bounds the window a compromised/rotated key
   * stays trusted. @default 300_000 (5 min)
   */
  jwksCacheMaxAge?: number;

  /** Allowed clock skew (seconds) for `exp`/`nbf`/`iat`. @default 0 */
  clockTolerance?: number;

  /** Optional logger. Defaults to an error-level Logger. */
  logger?: ChildLogger;
}

/**
 * Error constants for AuthBearerJwt. Use with `isBlocksError(e, AuthBearerJwtErrors.X)`.
 * - MissingToken / InvalidToken / UnsupportedAlgorithm → client-side issue
 * - MissingClaim → issuer/token-config issue (a required claim was stripped)
 * - JwksFetchFailed → issuer infrastructure issue (JWKS endpoint unreachable)
 */
export const AuthBearerJwtErrors = {
  MissingToken: 'MissingTokenException',
  InvalidToken: 'InvalidTokenException',
  UnsupportedAlgorithm: 'UnsupportedAlgorithmException',
  MissingClaim: 'MissingClaimException',
  JwksFetchFailed: 'JwksFetchFailedException',
} as const;

/** Asymmetric algorithms accepted by default. HS256 is added only when `hmacSecret` is set. */
const ASYMMETRIC_ALGORITHMS = ['RS256', 'RS384', 'RS512', 'ES256', 'ES384', 'ES512'] as const;
const DEFAULT_JWKS_CACHE_MAX_AGE_MS = 300_000;

/**
 * Provider-agnostic bearer-JWT authentication Building Block.
 *
 * Verifies an externally-issued JWT via JWKS (asymmetric) — or an opt-in HS256
 * shared secret — with no calls to the issuer on the critical path. Sibling to
 * `AuthOIDC`: OIDC owns interactive sign-in + server sessions; this statelessly
 * verifies tokens minted elsewhere (e.g. by a provider's client SDK).
 *
 * ## Usage
 *
 * ```typescript
 * const auth = new AuthBearerJwt(scope, 'auth', {
 *   issuer: 'https://issuer.example.com',
 *   jwks:   'https://issuer.example.com/.well-known/jwks.json',
 *   audience: 'my-api',
 * });
 *
 * export const api = new ApiNamespace(scope, 'api', (context) => ({
 *   async listTodos() {
 *     const user = await auth.requireAuth(context);
 *     return db.withRLS({ userId: user.userId, claims: user.claims })
 *       .query(sql`SELECT * FROM todos`);
 *   },
 * }));
 * ```
 *
 * ## Security properties
 * - Validates `iss` (prevents cross-tenant token confusion)
 * - Validates `aud` when configured
 * - Key source is fixed from config — never derived from the token
 * - Algorithm allowlist — rejects `alg: none`; HS256 only when explicitly opted in
 * - `jose` validates `exp`/`iat`/`nbf`
 */
export class AuthBearerJwt extends Scope implements BlocksAuth {
  private readonly issuers: string[];
  private readonly audience?: string;
  private readonly requiredClaims: string[];
  private readonly subjectClaim: string;
  private readonly clockTolerance: number;
  private readonly allowedAlgorithms: string[];
  private readonly mapUser?: (claims: JWTPayload & Record<string, unknown>) => AuthBearerUser;

  /** Single asymmetric resolver (URL or injected). Set unless per-issuer map or HS256. */
  private readonly jwks?: JWTVerifyGetKey;
  /** Per-issuer asymmetric resolvers, keyed by `iss`. */
  private readonly jwksByIssuer?: Map<string, JWTVerifyGetKey>;
  /** Symmetric secret resolver (set only in HS256 mode). */
  private readonly hmacSecret?: SecretLike;

  /** @internal */
  protected log: ChildLogger;

  constructor(scope: ScopeParent, id: string, options: AuthBearerJwtOptions) {
    super(id, { parent: scope });
    this.log = options?.logger ?? new Logger(this, 'logger', { level: 'error' });

    this.issuers = Array.isArray(options.issuer) ? options.issuer : [options.issuer];
    if (this.issuers.length === 0 || this.issuers.some((i) => !i)) {
      throw new Error('AuthBearerJwt: at least one non-empty issuer is required.');
    }
    if (!options.jwks && !options.hmacSecret) {
      throw new Error('AuthBearerJwt: provide `jwks` (asymmetric, preferred) or `hmacSecret` (HS256, opt-in).');
    }
    if (options.jwks && options.hmacSecret) {
      throw new Error('AuthBearerJwt: `jwks` and `hmacSecret` are mutually exclusive.');
    }

    this.audience = options.audience;
    this.requiredClaims = options.requiredClaims ?? [];
    this.subjectClaim = options.subjectClaim ?? 'sub';
    this.clockTolerance = options.clockTolerance ?? 0;
    this.mapUser = options.mapUser;

    if (options.hmacSecret) {
      this.hmacSecret = options.hmacSecret;
      this.allowedAlgorithms = ['HS256'];
      return;
    }

    this.allowedAlgorithms = [...ASYMMETRIC_ALGORITHMS];
    const cacheMaxAge = options.jwksCacheMaxAge ?? DEFAULT_JWKS_CACHE_MAX_AGE_MS;
    const jwks = options.jwks!;

    if (typeof jwks === 'function') {
      // Injected resolver (local-dev mock via jose.createLocalJWKSet).
      this.jwks = jwks;
    } else if (typeof jwks === 'string') {
      // One JWKS URL for all issuers.
      this.jwks = createRemoteJWKSet(new URL(jwks), { cacheMaxAge });
    } else {
      // Per-issuer JWKS map.
      this.jwksByIssuer = new Map(
        Object.entries(jwks).map(([iss, uri]) => [iss, createRemoteJWKSet(new URL(uri), { cacheMaxAge })]),
      );
    }
  }

  // ── BlocksAuth interface ────────────────────────────────────────────────

  async requireAuth(context: BlocksContext): Promise<AuthBearerUser> {
    const token = this.extractToken(context);
    this.validateAlgorithm(token);
    const payload = await this.verifyToken(token);
    this.validateRequiredClaims(payload);
    return this.toUser(payload);
  }

  async checkAuth(context: BlocksContext): Promise<boolean> {
    try {
      await this.requireAuth(context);
      return true;
    } catch {
      return false;
    }
  }

  async getCurrentUser(context: BlocksContext): Promise<AuthBearerUser | null> {
    try {
      return await this.requireAuth(context);
    } catch {
      return null;
    }
  }

  // ── Internal helpers ─────────────────────────────────────────────────

  private extractToken(context: BlocksContext): string {
    const authHeader = context.request.headers.get('authorization');
    if (!authHeader?.startsWith('Bearer ')) {
      throw new ApiError(
        'Missing or malformed Authorization header. Expected: Bearer <token>',
        401,
        { name: AuthBearerJwtErrors.MissingToken },
      );
    }
    return authHeader.slice(7);
  }

  private validateAlgorithm(token: string): void {
    let header;
    try {
      header = decodeProtectedHeader(token);
    } catch {
      throw new ApiError('Invalid token format', 401, { name: AuthBearerJwtErrors.InvalidToken });
    }
    if (!header.alg || !this.allowedAlgorithms.includes(header.alg)) {
      throw new ApiError(
        `Unsupported JWT algorithm: ${header.alg ?? 'none'}. Allowed: ${this.allowedAlgorithms.join(', ')}.`,
        401,
        { name: AuthBearerJwtErrors.UnsupportedAlgorithm },
      );
    }
  }

  private async verifyToken(token: string): Promise<JWTPayload & Record<string, unknown>> {
    try {
      let key: JWTVerifyGetKey | Uint8Array;
      let expectedIssuer: string | string[];

      if (this.jwksByIssuer) {
        // The JWKS getKey callback receives an *undecoded* payload, so we must
        // read `iss` up front (unverified) to select the right key set. Full
        // signature/iss verification still happens in jwtVerify below.
        const iss = decodeJwt(token).iss;
        const resolver = iss ? this.jwksByIssuer.get(iss) : undefined;
        if (!iss || !resolver) {
          throw new ApiError(`Untrusted or unknown issuer '${iss ?? '(none)'}'`, 401, {
            name: AuthBearerJwtErrors.InvalidToken,
          });
        }
        key = resolver;
        expectedIssuer = iss;
      } else if (this.jwks) {
        key = this.jwks;
        expectedIssuer = this.issuers.length === 1 ? this.issuers[0] : this.issuers;
      } else {
        const secret = typeof this.hmacSecret === 'function' ? await this.hmacSecret() : this.hmacSecret!;
        key = new TextEncoder().encode(secret);
        expectedIssuer = this.issuers.length === 1 ? this.issuers[0] : this.issuers;
      }

      const { payload } = await jwtVerify(token, key as any, {
        issuer: expectedIssuer,
        ...(this.audience ? { audience: this.audience } : {}),
        algorithms: this.allowedAlgorithms,
        clockTolerance: this.clockTolerance,
      });
      return payload as JWTPayload & Record<string, unknown>;
    } catch (e: any) {
      if (e instanceof ApiError) throw e; // e.g. untrusted-issuer from the map path
      const isFetchFail =
        (e?.code === 'ERR_JWKS_NO_MATCHING_KEY' && e?.message?.includes('fetch')) ||
        (e?.code === 'ERR_JOSE_GENERIC' && (e?.cause?.code === 'ECONNREFUSED' || e?.cause?.code === 'ENOTFOUND'));
      if (isFetchFail) {
        throw new ApiError('Failed to fetch JWKS from the issuer. It may be unreachable.', 503, {
          name: AuthBearerJwtErrors.JwksFetchFailed,
          cause: e,
        });
      }
      const message = e?.code === 'ERR_JWT_EXPIRED'
        ? 'Token expired. The client should refresh its session.'
        : `Token verification failed: ${e?.message ?? 'unknown error'}`;
      throw new ApiError(message, 401, { name: AuthBearerJwtErrors.InvalidToken, cause: e });
    }
  }

  private validateRequiredClaims(payload: JWTPayload & Record<string, unknown>): void {
    for (const claim of this.requiredClaims) {
      if (!(claim in payload)) {
        throw new ApiError(
          `Required claim '${claim}' missing from token.`,
          401,
          { name: AuthBearerJwtErrors.MissingClaim },
        );
      }
    }
  }

  private toUser(payload: JWTPayload & Record<string, unknown>): AuthBearerUser {
    if (this.mapUser) return this.mapUser(payload);

    const subject = payload[this.subjectClaim];
    if (!subject || typeof subject !== 'string') {
      throw new ApiError(`Token missing '${this.subjectClaim}' claim`, 401, {
        name: AuthBearerJwtErrors.InvalidToken,
      });
    }
    const userId = this.issuers.length > 1 ? `${payload.iss}:${subject}` : subject;
    const username = (payload.email as string) ?? subject;
    return { userId, username, claims: payload };
  }
}
