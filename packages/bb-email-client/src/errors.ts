// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Typed error constants for Email. Use with `isBlocksError()` in catch blocks.
 *
 * @example
 * ```typescript
 * try {
 *   await email.send({ to: 'user@example.com', subject: 'Hi', body: 'Hello' });
 * } catch (e: unknown) {
 *   if (isBlocksError(e, EmailErrors.SendFailed)) {
 *     // General send failure — check error message for details
 *   }
 *   if (isBlocksError(e, EmailErrors.InvalidInput)) {
 *     // malformed input (e.g. invalid email address)
 *   }
 *   throw e;
 * }
 * ```
 */
export const EmailErrors = {
	SendFailed: 'EmailSendFailedException',
	InvalidInput: 'InvalidInputException',
	DomainNotVerified: 'DomainNotVerifiedException',
	AccountPaused: 'AccountSendingPausedException',
	RateLimited: 'RateLimitedException',
} as const;
