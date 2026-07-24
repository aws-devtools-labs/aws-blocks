// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import type { JWTPayload } from 'jose';
import type { AuthUser } from '@aws-blocks/auth-common';

/**
 * The subset of Supabase JWT claims this block reads, plus the standard
 * registered claims carried by `JWTPayload`. Supabase populates `sub` for
 * every authenticated user; `role`, `email`, and the metadata bags are
 * present depending on project configuration.
 */
export interface SupabaseClaims extends JWTPayload {
	/** Supabase user id (uuid). Always present on a valid user token. */
	sub: string;
	email?: string;
	phone?: string;
	/** Postgres role, e.g. `'authenticated'` or `'anon'`. */
	role?: string;
	/** Provider-controlled metadata (roles, provider list, etc.). */
	app_metadata?: Record<string, unknown>;
	/** User-editable metadata (display name, avatar, etc.). */
	user_metadata?: Record<string, unknown>;
	/** Supabase session id, when present. */
	session_id?: string;
}

/**
 * User shape returned by AuthSupabase. Extends the common `AuthUser`
 * (`userId`, `username`) with Supabase-specific fields and the raw verified
 * claims for callers that need finer-grained authorization.
 */
export interface SupabaseUser extends AuthUser {
	email?: string;
	role?: string;
	appMetadata?: Record<string, unknown>;
	userMetadata?: Record<string, unknown>;
	/** The full set of verified claims. */
	claims: SupabaseClaims;
}

/** Options for the AuthSupabase Building Block. */
export interface AuthSupabaseOptions {
	/** Supabase project URL, e.g. `https://abcxyz.supabase.co`. */
	supabaseUrl: string;
	/** Expected `aud` claim. Defaults to `'authenticated'`. */
	audience?: string;
	/**
	 * Legacy HS256 shared secret provided inline. Intended for local dev and
	 * tests. In production, omit this — the block provisions an AppSetting
	 * (SSM SecureString) named `jwt-secret` and resolves it at runtime.
	 * Not needed at all for projects using Supabase's new asymmetric signing
	 * keys (verified via JWKS).
	 */
	jwtSecret?: string;
}
