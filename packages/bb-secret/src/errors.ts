// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Typed error constants for Secret. Use with `isBlocksError()` in catch blocks.
 *
 * Errors cross the wire by `name` (not `code`), so these string values are the
 * stable, matchable identity on both server and client. `SecretNotFound` mirrors
 * the Secrets Manager error name so customers familiar with AWS encounter a
 * familiar string.
 *
 * @example
 * ```typescript
 * import { isBlocksError } from '@aws-blocks/core';
 * import { SecretErrors } from '@aws-blocks/bb-secret';
 *
 * try {
 *   await secret.put(value);
 * } catch (e: unknown) {
 *   if (isBlocksError(e, SecretErrors.ValidationFailed)) {
 *     // schema validation failed
 *   }
 *   throw e;
 * }
 * ```
 */
export const SecretErrors = {
	/**
	 * Schema validation failed, or a stored value could not be parsed as JSON
	 * when a schema is configured.
	 */
	ValidationFailed: 'ValidationFailedException',
	/**
	 * The secret does not exist in Secrets Manager (e.g. deleted out-of-band, or
	 * a `fromExisting()` ARN that points at nothing). `get()` returns `null` for a
	 * missing secret rather than throwing; this is thrown by `put()` when the
	 * target secret does not exist.
	 */
	SecretNotFound: 'ResourceNotFoundException',
	/** The Secret Building Block was used in an unsupported environment (e.g. the browser). */
	NotSupported: 'NotSupportedException',
} as const;
