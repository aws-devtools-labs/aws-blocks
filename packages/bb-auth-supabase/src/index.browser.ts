// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Browser surface for AuthSupabase.
 *
 * Supabase issues, stores, and refreshes access tokens on the client via
 * `@supabase/supabase-js`. This block validates those tokens server-side, so
 * the browser surface is intentionally tiny: a helper to attach the current
 * access token as a Bearer header on Blocks API calls (the server counterpart
 * to the app-generated "auth attacher" middleware).
 */

/**
 * Build an `Authorization` header record from a Supabase access token.
 * Returns an empty object when there is no token, so it can be spread
 * unconditionally into a fetch/RPC headers bag.
 *
 * @example
 * ```typescript
 * const { data } = await supabase.auth.getSession();
 * await api.createPost(input, { headers: supabaseAuthHeader(data.session?.access_token) });
 * ```
 */
export function supabaseAuthHeader(
	accessToken: string | null | undefined,
): Record<string, string> {
	return accessToken ? { Authorization: `Bearer ${accessToken}` } : {};
}

export type { SupabaseUser, SupabaseClaims } from './types.js';
