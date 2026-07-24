// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { Scope, type ScopeParent, type BlocksContext, ApiError } from '@aws-blocks/core';
import { AppSetting } from '@aws-blocks/bb-app-setting';
import type { BlocksAuth } from '@aws-blocks/auth-common';
import { createSupabaseVerifier, type SupabaseVerifier } from './verify.js';
import { AuthSupabaseErrors } from './errors.js';
import type { AuthSupabaseOptions, SupabaseClaims, SupabaseUser } from './types.js';

export { AuthSupabaseErrors, type AuthSupabaseErrorName } from './errors.js';
export type { AuthSupabaseOptions, SupabaseUser, SupabaseClaims } from './types.js';
export type { BlocksAuth, AuthUser } from '@aws-blocks/auth-common';
export { supabaseAuthHeader } from './index.browser.js';

/**
 * Supabase authentication Building Block.
 *
 * Gates Blocks API methods by validating the caller's Supabase JWT — a
 * first-class, framework-agnostic alternative to per-request token
 * introspection. Verification happens **locally** via `jose` (no per-request
 * round-trip to Supabase); see {@link createSupabaseVerifier}.
 *
 * Tokens are stateless, so — unlike session-based auth blocks — this block
 * provisions no session store or cookies. The caller sends
 * `Authorization: Bearer <supabase-access-token>`; the block verifies it and
 * returns the mapped user.
 *
 * ## Usage
 *
 * ```typescript
 * import { Scope, ApiNamespace } from '@aws-blocks/core';
 * import { AuthSupabase } from '@aws-blocks/bb-auth-supabase';
 *
 * const scope = new Scope('my-app');
 * const auth = new AuthSupabase(scope, 'auth', {
 *   supabaseUrl: 'https://abcxyz.supabase.co',
 * });
 *
 * export const api = new ApiNamespace(scope, 'api', (context) => ({
 *   async createPost(input: NewPost) {
 *     const user = await auth.requireAuth(context); // throws 401 if unauthenticated
 *     return db.posts.create({ ...input, authorId: user.userId });
 *   },
 * }));
 * ```
 *
 * ## Key eras
 *
 * - **New asymmetric keys (ES256/RS256):** verified against the project JWKS
 *   at `<supabaseUrl>/auth/v1/.well-known/jwks.json`. No secret required.
 * - **Legacy HS256 (anon/service-role era):** verified against the project's
 *   shared JWT secret. In production the secret lives in an AppSetting (SSM
 *   SecureString) provisioned by this block; for local dev/tests pass
 *   `jwtSecret` inline.
 *
 * The algorithm is auto-detected per token, so both eras work simultaneously.
 */
export class AuthSupabase extends Scope implements BlocksAuth {
	private readonly supabaseUrl: string;
	private readonly audience: string;
	private readonly inlineSecret?: string;
	/**
	 * SSM SecureString holding the legacy HS256 secret. Provisioned only when
	 * no inline secret is supplied. Absent for pure-asymmetric projects that
	 * never configure a value.
	 */
	private readonly jwtSecretSetting?: AppSetting;
	private verifier?: SupabaseVerifier;

	constructor(scope: ScopeParent, id: string, options: AuthSupabaseOptions) {
		super(id, { parent: scope });
		if (!options?.supabaseUrl) {
			throw new Error('AuthSupabase: `supabaseUrl` is required');
		}
		this.supabaseUrl = options.supabaseUrl;
		this.audience = options.audience ?? 'authenticated';
		this.inlineSecret = options.jwtSecret;
		if (options.jwtSecret === undefined) {
			// Provision an SSM SecureString for the (optional) legacy HS256
			// secret. Asymmetric-only projects can simply leave it unset.
			this.jwtSecretSetting = new AppSetting(this, 'jwt-secret', { secret: true });
		}
	}

	/** Build (once) and return the cached local verifier. */
	private getVerifier(): SupabaseVerifier {
		if (!this.verifier) {
			const getSecret = this.inlineSecret !== undefined
				? async () => this.inlineSecret as string
				: this.jwtSecretSetting
					? () => this.jwtSecretSetting!.get()
					: undefined;
			this.verifier = createSupabaseVerifier({
				supabaseUrl: this.supabaseUrl,
				audience: this.audience,
				getSecret,
			});
		}
		return this.verifier;
	}

	/** Extract a Bearer token from the request's `Authorization` header. */
	private extractToken(context: BlocksContext): string | null {
		const header =
			context.request.headers.get('authorization') ??
			context.request.headers.get('Authorization');
		if (!header) return null;
		const [scheme, token] = header.split(' ');
		if (!token || scheme?.toLowerCase() !== 'bearer') return null;
		return token.trim() || null;
	}

	/** Map verified Supabase claims onto the common user shape. */
	private toUser(claims: SupabaseClaims): SupabaseUser {
		return {
			userId: claims.sub,
			username: claims.email ?? claims.phone ?? claims.sub,
			email: claims.email,
			role: claims.role,
			appMetadata: claims.app_metadata,
			userMetadata: claims.user_metadata,
			claims,
		};
	}

	// ── BlocksAuth interface ────────────────────────────────────────────

	/**
	 * Return the authenticated user, or `null` if the request carries no
	 * valid Supabase token. Never throws for auth failures.
	 */
	async getCurrentUser(context: BlocksContext): Promise<SupabaseUser | null> {
		const token = this.extractToken(context);
		if (!token) return null;
		try {
			const claims = await this.getVerifier()(token);
			if (!claims.sub) return null;
			return this.toUser(claims);
		} catch {
			// Malformed / expired / wrong-issuer / bad-signature all resolve to
			// "not authenticated" for getCurrentUser and checkAuth.
			return null;
		}
	}

	/**
	 * Require an authenticated user. Throws `ApiError` 401 (name
	 * `SessionExpiredException`) when no valid token is present.
	 */
	async requireAuth(context: BlocksContext): Promise<SupabaseUser> {
		const user = await this.getCurrentUser(context);
		if (!user) {
			throw new ApiError('Authentication required', 401, {
				name: AuthSupabaseErrors.SessionExpired,
			});
		}
		return user;
	}

	/** Return whether the request carries a valid Supabase session. */
	async checkAuth(context: BlocksContext): Promise<boolean> {
		return (await this.getCurrentUser(context)) !== null;
	}

	/**
	 * Require an authenticated user whose `role` claim equals `role`. Throws
	 * 401 when unauthenticated, 403 (name `ForbiddenException`) when the role
	 * does not match. Note: Supabase's top-level `role` is usually
	 * `'authenticated'`; finer RBAC typically lives in `app_metadata`.
	 */
	async requireRole(context: BlocksContext, role: string): Promise<SupabaseUser> {
		const user = await this.requireAuth(context);
		if (user.role !== role) {
			throw new ApiError('Forbidden', 403, { name: AuthSupabaseErrors.Forbidden });
		}
		return user;
	}
}
