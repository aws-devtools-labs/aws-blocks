// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Error constants for AuthBasic. Use with `isBlocksError()` for typed error handling.
 *
 * @example
 * ```typescript
 * import { isBlocksError } from '@aws-blocks/core';
 * import { AuthBasicErrors } from '@aws-blocks/bb-auth-basic';
 *
 * try {
 *   await auth.signIn('alice', 'wrong', context);
 * } catch (e) {
 *   if (isBlocksError(e, AuthBasicErrors.InvalidCredentials)) {
 *     // handle bad credentials
 *   }
 * }
 * ```
 */
export const AuthBasicErrors = {
	InvalidCredentials: 'InvalidCredentialsException',
	UserAlreadyExists: 'UserAlreadyExistsException',
	InvalidCode: 'InvalidCodeException',
	SessionExpired: 'SessionExpiredException',
	InvalidPassword: 'InvalidPasswordException',
} as const;
