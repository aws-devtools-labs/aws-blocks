// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import type { CorsRule, FileBucketOptions } from './types.js';

/**
 * Default noncurrent-version expiration (days) applied to the versioned main
 * bucket. Shared by the CDK lifecycle rule and the validation error message so
 * the documented default can't drift between them.
 */
export const DEFAULT_NONCURRENT_VERSION_EXPIRATION_DAYS = 90;

/** CORS methods that mutate state; a wildcard origin must never allow these. */
const MUTATING_CORS_METHODS: ReadonlyArray<CorsRule['allowedMethods'][number]> = ['PUT', 'POST', 'DELETE'];

/**
 * Build a `ValidationFailed`-named error the same way `mock-utils.ts`'s local
 * `blocksError` helper does, so a rejected key surfaces the same `.name` and
 * name-prefixed `.message` regardless of which layer rejected it. Kept as a
 * small local helper (rather than importing core's `blocksError`) to keep this
 * module dependency-light — it has no other runtime imports.
 */
function validationError(message: string): Error {
	const err = new Error(`ValidationFailed: ${message}`);
	err.name = 'ValidationFailed';
	return err;
}

/**
 * Validate an object key against the rules that must hold on EVERY runtime, so
 * a key rejected in local dev is rejected identically on AWS (and vice versa).
 *
 * This is the portable half of key validation: it depends only on the key
 * string, with no filesystem or SDK access, so it is safe to run in both the
 * mock and the AWS runtime. (The mock additionally runs a filesystem realpath /
 * symlink guard via `assertContainedPath`, which is inherently local-only and
 * stays mock-only — this function does not replace it.)
 *
 * Rejects a key that:
 * - is empty or not a string — there is no meaningful object to address;
 * - contains a NUL byte or any other ASCII control character (`\x00`–`\x1f` or
 *   `\x7f`) — control bytes in a key are almost always a bug or an injected
 *   value and have no legitimate use in an S3 key;
 * - has a leading `/` (absolute-style key) — S3 keys are not absolute paths, and
 *   a leading slash produces a surprising empty-first-segment key;
 * - contains a `..` (or `.`) path SEGMENT — checked per `/`-delimited segment,
 *   not by substring, so a normal filename such as `my..file.txt` is accepted
 *   while a path traversal segment like `a/../b` is rejected.
 *
 * The motivation is dev/prod parity: any key worth rejecting in local dev is
 * worth rejecting on AWS, so that a developer never sees a rejection locally
 * that silently does not occur in the deployed path.
 *
 * @param key - The object key to validate.
 * @throws {Error} With name `ValidationFailed` if the key violates any rule.
 */
export function assertValidKey(key: string): void {
	if (typeof key !== 'string' || key.length === 0) {
		throw validationError('Invalid key: must be a non-empty string');
	}
	for (let i = 0; i < key.length; i++) {
		const code = key.charCodeAt(i);
		if (code <= 0x1f || code === 0x7f) {
			throw validationError('Invalid key: contains control characters');
		}
	}
	if (key.startsWith('/')) {
		throw validationError('Invalid key: leading slash not allowed');
	}
	for (const segment of key.split('/')) {
		if (segment === '..' || segment === '.') {
			throw validationError('Invalid key: contains a path traversal segment');
		}
	}
}

/**
 * Validate the synchronous FileBucket option combinations that the CDK rejects
 * at synth, so the local mock fails fast on exactly what `cdk synth`/deploy
 * would reject (mock↔CDK parity — see bb-app-setting's validation.ts for the
 * same pattern).
 *
 * These are the two guards previously duplicated verbatim in `index.cdk.ts` and
 * `index.mock.ts`; extracting them keeps a single source of truth. Both checks
 * depend only on the option shape (not on an async value/schema), so they are
 * safe to run synchronously in both constructors.
 *
 * Throws a plain `Error` (no `error.name`) ON PURPOSE: the CDK synth path threw
 * bare `Error`s, and the mock deliberately matched that (a `blocksError`-style
 * `error.name` would diverge from the CDK guards). Keeping bare `Error`s here
 * preserves the exact pre-refactor behavior on both paths.
 *
 * The caller gates this on the non-external branch (an `external`/wrapped bucket
 * is owned elsewhere and bypasses these guards on both paths).
 *
 * @param fullId - The bucket's scope-derived id, used in error messages.
 * @param options - The FileBucket options to validate.
 */
export function validateFileBucketOptions(fullId: string, options?: FileBucketOptions): void {
	// Reject unsafe CORS: a wildcard origin ('*') combined with a mutating
	// method (PUT/POST/DELETE) lets any site issue state-changing cross-origin
	// requests.
	for (const rule of options?.corsRules ?? []) {
		if (rule.allowedOrigins.includes('*')) {
			const mutating = rule.allowedMethods.filter(m => MUTATING_CORS_METHODS.includes(m));
			if (mutating.length > 0) {
				throw new Error(
					`FileBucket "${fullId}": CORS rule with wildcard origin '*' must not allow mutating method(s) ${mutating.join(', ')}. ` +
					`Specify explicit allowedOrigins (e.g. 'https://app.example.com') for ${mutating.join(', ')} instead of '*'.`,
				);
			}
		}
	}

	// Reject a non-positive or non-integer noncurrent-version expiration. The
	// FORMAT is validated regardless of `versioned` so a malformed value is
	// caught even when versioning is off; the rule itself is only APPLIED when
	// versioning is on (see the main-bucket lifecycle rules).
	if (options?.noncurrentVersionExpirationDays !== undefined) {
		const days = options.noncurrentVersionExpirationDays;
		if (!Number.isInteger(days) || days <= 0) {
			throw new Error(
				`FileBucket "${fullId}": noncurrentVersionExpirationDays must be a positive integer (got ${days}). ` +
				`Omit it to use the default of ${DEFAULT_NONCURRENT_VERSION_EXPIRATION_DAYS} days.`,
			);
		}
	}
}
