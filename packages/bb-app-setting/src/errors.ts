// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Typed error constants for AppSetting. Use with `isBlocksError()` in catch blocks.
 *
 * @example
 * ```typescript
 * import { isBlocksError } from '@aws-blocks/core';
 * import { AppSettingErrors } from '@aws-blocks/bb-app-setting';
 *
 * try {
 *   await setting.put(value);
 * } catch (e: unknown) {
 *   if (isBlocksError(e, AppSettingErrors.ValidationFailed)) {
 *     // schema validation failed or value exceeds 4 KB
 *   }
 *   throw e;
 * }
 * ```
 */
export const AppSettingErrors = {
	/** Thrown when the SSM parameter does not exist. */
	ParameterNotFound: 'ParameterNotFoundException',
	/** Thrown when schema validation fails, value exceeds 4 KB, or options are invalid. */
	ValidationFailed: 'ValidationFailedException',
	/**
	 * Thrown when an AppSetting data method (`get`/`put`) is called in the
	 * browser. AppSetting is server-only; the browser build has no store or
	 * credentials. Expose the value through your own API method instead.
	 */
	BrowserNotSupported: 'BrowserNotSupportedException',
} as const;
