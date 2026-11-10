// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import type { CorsRule, FileBucketOptions } from './types.js';
import { validateUploadConstraintOptions } from './upload-constraints.js';
import { validationFailed } from './validation-error.js';

/**
 * Default noncurrent-version expiration (days) applied to the versioned main
 * bucket. Shared by the CDK lifecycle rule and the validation error message so
 * the documented default can't drift between them.
 */
export const DEFAULT_NONCURRENT_VERSION_EXPIRATION_DAYS = 90;

/**
 * Message for `FileBucketErrors.PresignedUploadUnsupported`. Shared so the mock
 * and the AWS runtime word the rejection identically.
 */
export function presignedUploadUnsupportedMessage(fullId: string): string {
	return (
		`FileBucket "${fullId}" has objectLock, so presigned uploads (putUrl / createUploadHandle) are not supported: ` +
		`S3 requires a signed Content-MD5 or checksum header on every upload to an Object Lock bucket, which a presigned ` +
		`URL created before the file is known can't carry. Upload through the backend with put() instead.`
	);
}

/**
 * Message for `FileBucketErrors.VersionNotFound` from `restoreVersion()`. Shared
 * so the mock and the AWS runtime word it identically. Static on purpose: the
 * error crosses the wire, so it names neither the key nor the version id.
 */
export const VERSION_NOT_FOUND_MESSAGE = 'The requested version does not exist';

/** Upper bound for `objectLock.retentionDays` (100 years). */
export const MAX_OBJECT_LOCK_RETENTION_DAYS = 36500;

/** CORS methods that mutate state; a wildcard origin must never allow these. */
const MUTATING_CORS_METHODS: ReadonlyArray<CorsRule['allowedMethods'][number]> = ['PUT', 'POST', 'DELETE'];

/**
 * Build a `ValidationFailed` error through the shared {@link validationFailed}
 * helper, the same one `mock-utils.ts` and `presigned-url.ts` use, so a rejected
 * key surfaces the same `.name`, name-prefixed `.message` and HTTP status
 * regardless of which layer rejected it. The error is a wire-safe `ApiError`
 * with status 400: the RPC serializer forwards its name and message to the
 * client as a 400 instead of collapsing it to a generic internal error.
 */
function validationError(message: string): Error {
	return validationFailed(message);
}

/**
 * True for a character that has no legitimate use in an object key or prefix:
 * - ASCII control characters (`\x00`–`\x1f`, `\x7f`) and C1 control
 *   characters (U+0080–U+009F, which includes NEL U+0085);
 * - the Unicode line and paragraph separators U+2028 and U+2029;
 * - the bidirectional embedding/override (U+202A–U+202E) and isolate
 *   (U+2066–U+2069) formatting characters, which make a key render differently
 *   from the bytes it contains.
 */
function isDisallowedKeyChar(code: number): 'control' | 'format' | null {
	if (code <= 0x1f || code === 0x7f || (code >= 0x80 && code <= 0x9f)) return 'control';
	if (code === 0x2028 || code === 0x2029) return 'format';
	if ((code >= 0x202a && code <= 0x202e) || (code >= 0x2066 && code <= 0x2069)) return 'format';
	return null;
}

/**
 * True when `segment` is a `.` or `..` path segment, either literally or once
 * every `%2e` / `%2E` in it is read as `.` (so `%2e%2e`, `.%2E` and `%2e` all
 * count). Only that exact sequence is decoded: any other `%` — including a
 * literal one such as `100%done.txt` — is left as-is, so ordinary filenames
 * containing `%` stay valid.
 */
function isDotSegment(segment: string): boolean {
	const decoded = segment.replace(/%2e/gi, '.');
	return decoded === '.' || decoded === '..';
}

/**
 * Character and segment rules shared by {@link assertValidKey} and
 * {@link assertValidPrefix}. `label` only selects the static message prefix
 * (`Invalid key` / `Invalid prefix`); messages never echo the input.
 */
function assertKeyShape(value: string, label: 'key' | 'prefix', allowTrailingSlash: boolean): void {
	for (let i = 0; i < value.length; i++) {
		const code = value.charCodeAt(i);
		const kind = isDisallowedKeyChar(code);
		if (kind === 'control') {
			throw validationError(`Invalid ${label}: contains control characters`);
		}
		if (kind === 'format') {
			throw validationError(`Invalid ${label}: contains Unicode line-separator or bidirectional formatting characters`);
		}
		if (code === 0x5c) {
			throw validationError(`Invalid ${label}: backslash not allowed`);
		}
	}
	if (value.startsWith('/')) {
		throw validationError(`Invalid ${label}: leading slash not allowed`);
	}
	const segments = value.split('/');
	for (let i = 0; i < segments.length; i++) {
		const segment = segments[i];
		if (isDotSegment(segment)) {
			throw validationError(`Invalid ${label}: contains a path traversal segment`);
		}
		// Reject an empty segment (adjacent slashes `a//b` or a trailing slash
		// `a/`). The mock maps keys onto the filesystem via `path.join`, which
		// collapses `a//b` to `a/b` and strips a trailing slash, while S3 treats
		// each as a distinct literal key — so permitting them would reintroduce a
		// mock↔S3 divergence. (A leading empty segment is reported above as a
		// leading slash; this covers interior and trailing ones.) A prefix may end
		// with `/` (`uploads/`), so its final segment is allowed to be empty.
		if (segment === '' && !(allowTrailingSlash && i === segments.length - 1)) {
			throw validationError(`Invalid ${label}: contains an empty path segment`);
		}
	}
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
 * - contains a C1 control character (U+0080–U+009F, including NEL U+0085), the
 *   Unicode line/paragraph separators U+2028 / U+2029, or a bidirectional
 *   embedding, override or isolate character (U+202A–U+202E, U+2066–U+2069) —
 *   these break log lines and headers or make a key display differently from the
 *   characters it contains;
 * - contains a backslash (`\`) — some tools and filesystems treat it as a path
 *   separator, so a key with one can address a different location than S3 does;
 * - has a leading `/` (absolute-style key) — S3 keys are not absolute paths, and
 *   a leading slash produces a surprising empty-first-segment key;
 * - contains an empty path segment — an interior `a//b` or a trailing `a/`. The
 *   mock collapses these via `path.join` while S3 treats them as distinct
 *   literal keys, so permitting them would reintroduce a mock↔S3 divergence;
 * - contains a `..` (or `.`) path SEGMENT — checked per `/`-delimited segment,
 *   not by substring, so a normal filename such as `my..file.txt` is accepted
 *   while a path traversal segment like `a/../b` is rejected. A segment also
 *   counts when it becomes `.` or `..` once each `%2e` / `%2E` is read as `.`
 *   (`a/%2e%2e/b`), since code that URL-decodes keys would see a traversal
 *   segment there. No other percent-encoding is interpreted, so `100%done.txt`
 *   and `50%25.txt` stay valid.
 *
 * Error messages are static and never include the key.
 *
 * The motivation is dev/prod parity: any key worth rejecting in local dev is
 * worth rejecting on AWS, so that a developer never sees a rejection locally
 * that silently does not occur in the deployed path.
 *
 * @param key - The object key to validate.
 * @throws {Error} With name `ValidationFailed` (an `ApiError` with status 400) if the key violates any rule.
 */
export function assertValidKey(key: string): void {
	if (typeof key !== 'string' || key.length === 0) {
		throw validationError('Invalid key: must be a non-empty string');
	}
	assertKeyShape(key, 'key', false);
}

/**
 * Validate a `scan({ prefix })` prefix with the same character and segment
 * rules as {@link assertValidKey}, adapted to a prefix:
 * - `undefined` and the empty string are accepted (an unscoped scan);
 * - a trailing `/` is accepted (`uploads/`), so the final segment may be empty;
 * - the final segment may be a partial name (`reports/2024-0`).
 *
 * Everything else matches key validation: a leading `/`, an interior empty
 * segment, a `.` / `..` segment (including its `%2e` spelling), control
 * characters, line/paragraph separators, bidirectional formatting characters
 * and backslashes are rejected. Runs in both the mock and the AWS runtime, so a
 * prefix is accepted or rejected identically. Messages never echo the prefix.
 *
 * @param prefix - The scan prefix to validate.
 * @throws {Error} With name `ValidationFailed` (an `ApiError` with status 400) if the prefix violates any rule.
 */
export function assertValidPrefix(prefix: string | undefined): void {
	if (prefix === undefined || prefix === '') return;
	if (typeof prefix !== 'string') {
		throw validationError('Invalid prefix: must be a string');
	}
	assertKeyShape(prefix, 'prefix', true);
}

/**
 * Validate the synchronous FileBucket option combinations that the CDK rejects
 * at synth, so the local mock fails fast on exactly what `cdk synth`/deploy
 * would reject (mock↔CDK parity — see bb-app-setting's validation.ts for the
 * same pattern).
 *
 * The CORS and noncurrent-expiration guards were previously duplicated verbatim in `index.cdk.ts` and
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
 * is owned elsewhere and skips these guards on both paths). The one exception
 * is the upload-constraint check at the end ({@link validateUploadConstraintOptions}):
 * those options are enforced at runtime, so the external branches run that
 * check on its own.
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

	// Object Lock locks object VERSIONS, so S3 requires versioning on the
	// bucket. Reject the contradiction instead of silently re-enabling
	// versioning (which would also flip the version-aware method typings).
	const objectLock = options?.objectLock;
	if (objectLock !== undefined) {
		if (options?.versioned === false) {
			throw new Error(
				`FileBucket "${fullId}": objectLock requires versioning, but versioned is false. ` +
				`Remove versioned: false (versioning is on by default) or remove objectLock.`,
			);
		}
		if (objectLock.mode !== 'governance' && objectLock.mode !== 'compliance') {
			throw new Error(
				`FileBucket "${fullId}": objectLock.mode must be 'governance' or 'compliance' (got ${String(objectLock.mode)}).`,
			);
		}
		const days = objectLock.retentionDays;
		if (!Number.isInteger(days) || days <= 0 || days > MAX_OBJECT_LOCK_RETENTION_DAYS) {
			throw new Error(
				`FileBucket "${fullId}": objectLock.retentionDays must be an integer between 1 and ` +
				`${MAX_OBJECT_LOCK_RETENTION_DAYS} (got ${days}).`,
			);
		}
	}

	// Upload constraints (`allowedContentTypes`, `maxUploadBytes`) are enforced
	// by the runtime methods, not by S3 bucket configuration, so their shape is
	// checked here too and by the AWS runtime constructor (see
	// upload-constraints.ts). A wrapped bucket still enforces them, so the
	// external-bucket branches call validateUploadConstraintOptions directly.
	validateUploadConstraintOptions(fullId, options);
}
