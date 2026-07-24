// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Error constants for AuthSupabase. Use with `isBlocksError()` for typed
 * error handling on both server and client.
 *
 * @example
 * ```typescript
 * import { isBlocksError } from '@aws-blocks/core';
 * import { AuthSupabaseErrors } from '@aws-blocks/bb-auth-supabase';
 *
 * try {
 *   await auth.requireAuth(context);
 * } catch (e) {
 *   if (isBlocksError(e, AuthSupabaseErrors.SessionExpired)) {
 *     // prompt re-authentication
 *   }
 * }
 * ```
 */
export const AuthSupabaseErrors = {
	/** No valid session / token could not be verified. */
	SessionExpired: 'SessionExpiredException',
	/** Token was present but malformed or failed verification. */
	InvalidToken: 'InvalidTokenException',
	/** Authenticated, but the required role was not present. */
	Forbidden: 'ForbiddenException',
} as const;

export type AuthSupabaseErrorName = (typeof AuthSupabaseErrors)[keyof typeof AuthSupabaseErrors];
