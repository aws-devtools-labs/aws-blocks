// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Typed error constants for FileBucket. Use with `isBlocksError()` in catch blocks.
 *
 * Note: `get()` returns `null` for a missing object (and a missing `versionId`)
 * rather than throwing — use `if (!file)` for that case. `FileNotFound` is only
 * thrown by methods that require the object to exist. `VersionNotFound` is thrown
 * by `restoreVersion()` when the target `versionId` cannot be resolved.
 *
 * @example
 * ```typescript
 * const file = await bucket.get('missing.txt');
 * if (!file) {
 *   // file (or version) does not exist — get() returns null, never throws
 * }
 *
 * try {
 *   await bucket.restoreVersion('report.pdf', versionId);
 * } catch (e: unknown) {
 *   if (isBlocksError(e, FileBucketErrors.VersionNotFound)) {
 *     // that version no longer exists
 *   }
 *   throw e;
 * }
 * ```
 */
export const FileBucketErrors = {
	FileNotFound: 'NoSuchKey',
	FileTooLarge: 'EntityTooLarge',
	VersionNotFound: 'NoSuchVersion',
} as const;
