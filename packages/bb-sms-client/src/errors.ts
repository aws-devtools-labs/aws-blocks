// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Typed error constants for SmsClient. Use with `isBlocksError()` in catch blocks.
 *
 * @example
 * ```typescript
 * try {
 *   await sms.send({ to: '+14155550123', body: 'Your code is 1234' });
 * } catch (e: unknown) {
 *   if (isBlocksError(e, SmsErrors.OptedOut)) {
 *     // Recipient has opted out — stop messaging this number
 *   }
 *   if (isBlocksError(e, SmsErrors.InvalidInput)) {
 *     // malformed input (e.g. non-E.164 phone number)
 *   }
 *   throw e;
 * }
 * ```
 */
export const SmsErrors = {
	SendFailed: 'SmsSendFailedException',
	InvalidInput: 'InvalidInputException',
	OptedOut: 'PhoneNumberOptedOutException',
	InvalidTarget: 'InvalidTargetException',
	RateLimited: 'RateLimitedException',
} as const;
