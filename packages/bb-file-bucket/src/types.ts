// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Shared types for FileBucket. Imported by mock, aws, and browser entry points.
 * This file has zero runtime dependencies — types only.
 */
import type { ChildLogger } from '@aws-blocks/bb-logger';

// ── Constructor options ─────────────────────────────────────────────────────

export interface FileBucketOptions {
	/**
	 * Enable object versioning. Default: true. Pass `false` to opt out.
	 *
	 * Note for the version-aware method typings (`get`/`delete`/`getUrl`/
	 * `getFileHandle`): selecting the NON-versioned (optionless) typings
	 * requires the literal `versioned: false`. A non-literal `boolean` value
	 * (e.g. one widened from a variable) — or omitting the option entirely —
	 * resolves to the versioned-aware typings, which match the default-on
	 * runtime behavior. See {@link GetOptionsFor} et al.
	 */
	versioned?: boolean;
	/**
	 * CORS rules for browser-based access.
	 *
	 * Default: none — browsers block every cross-origin `fetch()` to the
	 * deployed bucket. Required whenever browser code fetches a presigned URL directly
	 * (`download()` / `upload()` on a file handle, or `fetch()` on a
	 * `getUrl()` / `putUrl()` URL) against a deployed stack. Not inherited from
	 * the stack's `defaults.allowedOrigins` or the Hosting domain. The local dev
	 * server accepts any origin, so a missing rule only fails after deploy.
	 * Ignored when `bucket` wraps an existing bucket — configure CORS on that
	 * bucket itself.
	 *
	 * @example
	 * ```ts
	 * new FileBucket(scope, 'uploads', {
	 *   corsRules: [{
	 *     allowedOrigins: ['http://localhost:3000', 'https://app.example.com'],
	 *     allowedMethods: ['GET', 'PUT'],
	 *     allowedHeaders: ['Content-Type'],
	 *   }],
	 * });
	 * ```
	 */
	corsRules?: CorsRule[];
	/** Lifecycle rules for automatic object expiration or transitions. */
	lifecycleRules?: LifecycleRule[];
	/**
	 * Enable S3 server access logging. Default: false (opt-in).
	 *
	 * When `true`, a dedicated, locked-down log bucket is provisioned
	 * (all public access blocked, S3-managed encryption, SSL enforced) and
	 * the main bucket delivers its access logs there under the
	 * `access-logs/` prefix. Access logs are expired automatically after the
	 * stack-wide `logRetention` default (see `BlocksDefaults.logRetention`);
	 * `RetentionDays.INFINITE` keeps them indefinitely (no expiry rule).
	 *
	 * Resolves from the stack `defaults.storageAccessLogging` when omitted, and
	 * from `defaults.accessLogging` when that is unset too, so a stack can opt
	 * every FileBucket into logging without a per-block option. Ignored by the
	 * mock and browser runtimes (no AWS resource).
	 */
	accessLogging?: boolean;
	/**
	 * Server-side encryption at rest. S3 always encrypts objects; this only
	 * selects the key.
	 *
	 * - `'aws-managed'` (default): SSE-S3 with S3-managed keys. No key charge and
	 *   no per-request KMS cost.
	 * - `'customer-managed'`: SSE-KMS with a **dedicated** customer-managed KMS
	 *   key (CMK) for this bucket, with automatic yearly rotation. You control the
	 *   key policy and every use is logged in CloudTrail. Incurs the KMS monthly
	 *   key charge; S3 Bucket Keys are enabled to keep per-request KMS charges
	 *   low. The key follows the bucket's removal policy (destroyed with a
	 *   `'destroy'` bucket, retained with a `'retain'` one).
	 * - a {@link ExternalKmsKeyRef} from {@link FileBucket.fromKmsKey}: SSE-KMS
	 *   with an **existing** CMK you own, so several buckets (or tables) can share
	 *   one key. The key policy must let the account's IAM principals use it —
	 *   Blocks grants the runtime role `kms:Decrypt` / `kms:GenerateDataKey*` on
	 *   it, which only takes effect when the key policy delegates to IAM.
	 *
	 * Presigned `getUrl()` / `putUrl()` URLs keep working under SSE-KMS: they are
	 * signed by the runtime role, which holds the key permissions.
	 *
	 * The access-log bucket (see {@link accessLogging}) always uses SSE-S3: S3
	 * server access logging can't deliver to an SSE-KMS bucket.
	 *
	 * @example
	 * ```ts
	 * const key = FileBucket.fromKmsKey('arn:aws:kms:us-east-1:111122223333:key/abcd-1234');
	 * new FileBucket(scope, 'invoices', { encryption: key });
	 * ```
	 *
	 * Ignored, with a synth warning, when `bucket` wraps an existing bucket.
	 * Ignored by the mock and browser runtimes (no AWS resource to encrypt).
	 */
	encryption?: 'aws-managed' | 'customer-managed' | ExternalKmsKeyRef;
	/**
	 * Enable S3 Object Lock (write-once-read-many) with a default retention
	 * period applied to every new object version. Default: off.
	 *
	 * - `mode: 'governance'` — principals with `s3:BypassGovernanceRetention`
	 *   can still shorten the retention or delete a locked version.
	 * - `mode: 'compliance'` — **nobody**, including the account root user, can
	 *   delete a locked version or shorten its retention until it expires.
	 * - `retentionDays` — how long each version stays locked (a positive integer,
	 *   at most 36500).
	 *
	 * Locking applies to object **versions**: `delete(path)` still succeeds (it
	 * adds a delete marker, so the file disappears from `get` and `scan`), but
	 * permanently deleting a locked version (`delete(path, { versionId })`)
	 * fails until its retention expires, and the noncurrent-version expiration
	 * rule (see {@link noncurrentVersionExpirationDays}) only removes a version
	 * once its lock has expired.
	 *
	 * Presigned uploads are not supported: S3 requires a signed `Content-MD5` or
	 * checksum header on every upload to an Object Lock bucket, which a URL
	 * presigned before the file is known can't carry. `putUrl()` and
	 * `createUploadHandle()` throw `FileBucketErrors.PresignedUploadUnsupported`;
	 * upload with `put()` (the SDK adds the checksum). Downloads are unaffected.
	 *
	 * Requirements, checked at synth:
	 * - versioning must stay on (`versioned: false` is rejected);
	 * - the bucket must be retained — `removalPolicy: 'destroy'` (including the
	 *   sandbox preset's default) is rejected, because locked objects can't be
	 *   emptied, so a teardown would fail. Pass `removalPolicy: 'retain'` to use
	 *   Object Lock in a sandbox.
	 *
	 * Adding `objectLock` to an already-deployed FileBucket is an in-place
	 * update: CloudFormation enables Object Lock on the existing bucket. S3 can't
	 * turn Object Lock off once it's on. Changing `mode` or `retentionDays` is
	 * also an in-place update that applies to new versions only.
	 *
	 * @example
	 * ```ts
	 * new FileBucket(scope, 'audit-exports', {
	 *   objectLock: { mode: 'governance', retentionDays: 365 },
	 * });
	 * ```
	 *
	 * Ignored, with a synth warning, when `bucket` wraps an existing bucket.
	 *
	 * The mock validates the option and rejects presigned uploads, but does not
	 * enforce retention.
	 */
	objectLock?: ObjectLockOptions;
	/**
	 * Days after which NONCURRENT object versions are permanently expired,
	 * bounding the storage cost that versioning would otherwise let grow
	 * unbounded. Only applies when versioning is enabled (the default).
	 * Default: 90.
	 *
	 * Must be a positive integer; a non-positive or non-integer value is
	 * rejected at synth. There is no "disable" sentinel — noncurrent-version
	 * expiration is always on for a versioned bucket to cap version growth. To
	 * opt out entirely, disable versioning (`versioned: false`), which drops
	 * the rule. Ignored by the mock and browser runtimes (no AWS resource).
	 */
	noncurrentVersionExpirationDays?: number;
	/**
	 * Wrap an existing S3 bucket instead of creating one.
	 *
	 * @remarks
	 * When set, FileBucket binds to the supplied bucket as-is and returns early:
	 * NONE of the secure defaults this construct normally applies are applied to
	 * an externally-supplied bucket — not `enforceSSL`, versioning + noncurrent-version
	 * expiration, server access logging, `blockPublicAccess`, encryption, nor the
	 * wildcard-CORS guard. You own that bucket's security posture; configure these
	 * on the bucket itself (or via its own CDK construct) before wrapping it.
	 */
	bucket?: ExternalBucketRef;
	/**
	 * CDK removal behavior for the underlying S3 bucket. When omitted, it
	 * falls back to the stack's posture default (`BlocksDefaults.removalPolicy`
	 * from the chosen `BlocksPresets` entry — DESTROY in `sandbox`, RETAIN in
	 * `production`).
	 *
	 * Pass `'destroy'` for sandbox / ephemeral stacks where the bucket
	 * should be dropped on teardown. This also enables `autoDeleteObjects`
	 * so CloudFormation can empty the bucket before deletion — required
	 * since S3 rejects DELETE on a non-empty bucket.
	 *
	 * Pass `'retain'` to set the policy explicitly, keeping the bucket and its
	 * contents on `cdk destroy` regardless of the stack default.
	 *
	 * Templates that apply `RemovalPolicies.of(stack).destroy()` at the
	 * top level override this setting.
	 *
	 * Ignored by the mock and browser runtimes (no AWS resource to retain).
	 */
	removalPolicy?: 'destroy' | 'retain';
	/**
	 * Content types this bucket accepts on upload. Default: any content type.
	 *
	 * Each entry is an exact media type (`'application/pdf'`) or a `type/*`
	 * wildcard (`'image/*'`), without parameters. Matching ignores case and
	 * parameters, so `text/plain; charset=utf-8` matches `'text/plain'` or
	 * `'text/*'`. A wildcard matches every subtype of its type except the types
	 * a browser can display as a page (scripts included) or run as a script:
	 * `text/html`, `image/svg+xml`, `application/xhtml+xml`, `text/xml`,
	 * `application/xml`, `text/xsl`, `text/javascript`, `text/ecmascript`,
	 * `application/javascript`, `application/ecmascript`,
	 * `application/x-javascript`, and any subtype ending in `+xml`
	 * (`application/atom+xml`, …). So `'image/*'` does not accept
	 * `image/svg+xml`, and `'text/*'` does not accept `text/html`. To accept one
	 * of these, list it exactly (`['image/*', 'image/svg+xml']`), and serve its
	 * downloads with `getUrl()`'s `attachment` option.
	 *
	 * Checked by `put()`, `putUrl()` and `createUploadHandle()` against the
	 * effective content type — the caller's `contentType`, or
	 * `application/octet-stream` when omitted (list it to accept uploads that
	 * don't name a type). A content type that isn't listed throws
	 * `ValidationFailed` (HTTP 400). Presigned uploads always sign the content
	 * type, so the uploader can't send a different one.
	 *
	 * Must be a non-empty array of `type/subtype` or `type/*` strings; anything
	 * else is rejected at synth (and by the mock at construction). Enforced by the
	 * mock and the AWS runtime identically, including for a bucket wrapped with
	 * `bucket`.
	 *
	 * @example
	 * ```ts
	 * new FileBucket(scope, 'avatars', { allowedContentTypes: ['image/png', 'image/jpeg'] });
	 * ```
	 */
	allowedContentTypes?: string[];
	/**
	 * Largest upload, in bytes, this bucket accepts. Default: no limit (S3's own
	 * limits apply).
	 *
	 * When set:
	 * - `putUrl()` and `createUploadHandle()` require `contentLength` and reject
	 *   one above the limit; the signed URL only accepts a body of exactly that
	 *   size;
	 * - `put()` rejects a body above the limit.
	 *
	 * A rejection throws `ValidationFailed` (HTTP 400). Must be a positive safe
	 * integer (at most `Number.MAX_SAFE_INTEGER`); anything else is rejected at
	 * synth (and by the mock at construction).
	 * Enforced by the mock and the AWS runtime identically, including for a
	 * bucket wrapped with `bucket`.
	 *
	 * @example
	 * ```ts
	 * new FileBucket(scope, 'uploads', { maxUploadBytes: 10 * 1024 * 1024 }); // 10 MiB
	 * ```
	 */
	maxUploadBytes?: number;
	/** Optional logger for internal operations. When omitted, a default Logger at error level is created. */
	logger?: ChildLogger;
}

// ── Method options ──────────────────────────────────────────────────────────

export interface PutOptions {
	/**
	 * MIME type of the file (e.g., `image/png`). Default: `application/octet-stream`.
	 *
	 * Must be a single `type/subtype` media type with optional `; name=value`
	 * parameters (no comma-separated list, ASCII only), or `put()` throws
	 * `ValidationFailed`. Must be in the bucket's `allowedContentTypes` when that option is set;
	 * otherwise `put()` throws `ValidationFailed`.
	 */
	contentType?: string;
	/**
	 * Custom metadata key-value pairs.
	 *
	 * Set when the object is written and can't be edited in place: each `put()`
	 * replaces the object's metadata, so a `put()` without `metadata` leaves
	 * none. To change it, `put()` the same body again with the complete new set
	 * (see "Changing Metadata" in the README). S3 stores the keys in lowercase,
	 * so use lowercase keys.
	 */
	metadata?: Record<string, string>;
	/** Cache-Control header value. */
	cacheControl?: string;
}

export interface GetUrlOptions {
	/** URL expiration in whole seconds. Must be an integer from 1 to 604800. Default: 3600. */
	expiresIn?: number;
	/**
	 * Make the browser download the file instead of displaying it. Default: off —
	 * the file is served with its stored content type and displayed inline when
	 * the browser can render it.
	 *
	 * - `true` signs `Content-Disposition: attachment` into the URL.
	 * - a filename (e.g. `'report.pdf'`) also suggests that name:
	 *   `attachment; filename="report.pdf"; filename*=UTF-8''report.pdf`. Control
	 *   characters and zero-width/directional formatting characters are
	 *   removed, and a name that is empty, `.` or `..` afterwards throws
	 *   `ValidationFailed`; in the quoted ASCII `filename`, quotes,
	 *   backslashes, `%` and non-ASCII characters become `_`, while `filename*`
	 *   carries the full UTF-8 name.
	 *
	 * Recommended for user-uploaded content: a file displayed inline can run as a
	 * page (HTML, SVG) in whatever origin serves it.
	 *
	 * @throws `ValidationFailed` when neither a boolean nor a non-empty filename.
	 */
	attachment?: boolean | string;
}

export interface PutUrlOptions {
	/** URL expiration in whole seconds. Must be an integer from 1 to 604800. Default: 3600. */
	expiresIn?: number;
	/**
	 * Required content type for the upload. Default: `application/octet-stream`.
	 *
	 * Always signed into the URL: the upload must send exactly this
	 * `Content-Type` header, or S3 (and the local dev server) rejects it with
	 * `403 SignatureDoesNotMatch`. `createUploadHandle().upload()` sends it for
	 * you. Must be a single `type/subtype` media type with optional `; name=value`
	 * parameters (no comma-separated list, ASCII only). Must be in the bucket's
	 * `allowedContentTypes` when that option is set;
	 * otherwise the call throws `ValidationFailed`.
	 */
	contentType?: string;
	/**
	 * Exact size of the upload, in bytes. When set, it is signed into the URL and
	 * S3 (and the local dev server) only accepts a body of exactly this size.
	 * Browsers set `Content-Length` from the body automatically. `0` is a valid
	 * size and signs a zero-byte upload.
	 *
	 * Required when the bucket sets `maxUploadBytes`, and must not exceed it.
	 *
	 * @throws `ValidationFailed` when not a non-negative safe integer, missing while
	 *   `maxUploadBytes` is set, or above `maxUploadBytes`.
	 */
	contentLength?: number;
}

export interface ScanOptions {
	/**
	 * Only list files whose keys start with this prefix.
	 *
	 * Validated with the same rules as object keys, except that it may be empty
	 * and may end with `/`: a leading `/`, an empty interior segment, a `.` or
	 * `..` segment, a backslash and control or bidirectional formatting
	 * characters throw `ValidationFailed`.
	 */
	prefix?: string;
}

// ── Versioning options (extend base options with versionId) ─────────────────

/** Options for get on versioned buckets. */
export interface VersionedGetOptions {
	/** Retrieve a specific version. Omit to get the latest. */
	versionId?: string;
}

/** Options for delete on versioned buckets. */
export interface VersionedDeleteOptions {
	/** Delete a specific version permanently. Omit to place a delete marker. */
	versionId?: string;
}

/** Options for getUrl/getFileHandle on versioned buckets. */
export interface VersionedGetUrlOptions extends GetUrlOptions {
	/** Generate URL for a specific version. */
	versionId?: string;
}

// ── Conditional type helpers ────────────────────────────────────────────────

/**
 * Resolves the get options type based on whether versioning is enabled.
 * Versioned buckets accept `{ versionId }`, non-versioned accept no options.
 * Versioning is on by default, so only an explicit `versioned: false` selects
 * the non-versioned (optionless) shape. A non-literal `boolean` (widened from
 * a variable) or an absent `versioned` resolves to the versioned-aware shape,
 * matching the default-on runtime behavior.
 */
export type GetOptionsFor<O extends FileBucketOptions> =
	O extends { versioned: false } ? undefined : VersionedGetOptions;

/**
 * Resolves the delete options type based on whether versioning is enabled.
 * Versioned buckets accept `{ versionId }`, non-versioned accept no options.
 * Versioning is on by default, so only an explicit `versioned: false` selects
 * the non-versioned (optionless) shape.
 */
export type DeleteOptionsFor<O extends FileBucketOptions> =
	O extends { versioned: false } ? undefined : VersionedDeleteOptions;

/**
 * Resolves the getUrl/getFileHandle options type based on whether versioning is enabled.
 * Versioned buckets accept `{ expiresIn, versionId }`, non-versioned accept `{ expiresIn }`.
 * Versioning is on by default, so only an explicit `versioned: false` selects
 * the non-versioned shape.
 */
export type GetUrlOptionsFor<O extends FileBucketOptions> =
	O extends { versioned: false } ? GetUrlOptions : VersionedGetUrlOptions;

// ── Return types ────────────────────────────────────────────────────────────

export interface FileContent {
	/** The file body as a Buffer. */
	body: Buffer;
	/** MIME type of the file. */
	contentType: string;
	/** Custom metadata key-value pairs. */
	metadata: Record<string, string>;
	/** File size in bytes. */
	size: number;
}

export interface FileInfo {
	/** The object key. */
	path: string;
	/** File size in bytes. */
	size: number;
	/** Last modification timestamp. */
	lastModified: Date;
}

/** Metadata for a single object version. */
export interface FileVersionInfo {
	/** The version identifier. */
	versionId: string;
	/** When this version was created. */
	lastModified: Date;
	/** Size in bytes. */
	size: number;
	/** Whether this is the current (latest) version. */
	isCurrent: boolean;
}

// ── Infrastructure types ────────────────────────────────────────────────────

export interface CorsRule {
	allowedOrigins: string[];
	allowedMethods: ('GET' | 'PUT' | 'POST' | 'DELETE' | 'HEAD')[];
	allowedHeaders?: string[];
	exposedHeaders?: string[];
	maxAge?: number;
}

export interface LifecycleRule {
	/** Prefix filter for the rule. */
	prefix?: string;
	/** Days after creation to expire objects. */
	expirationDays?: number;
	/** Days after creation to transition to Infrequent Access. */
	transitionToIaDays?: number;
}

/**
 * A reference to a pre-existing S3 bucket to wrap via {@link FileBucketOptions.bucket}
 * (see that field's remarks — a wrapped bucket does not receive FileBucket's
 * secure defaults). Produced by `FileBucket.fromExisting(bucketName)`.
 */
export interface ExternalBucketRef {
	readonly __brand: 'ExternalBucketRef';
	readonly bucketName: string;
}

/**
 * A reference to an existing customer-managed KMS key, produced by
 * {@link FileBucket.fromKmsKey}. Pass it as the `encryption` option to encrypt
 * the bucket with a CMK you already own — letting several buckets (or tables)
 * share one key instead of each provisioning its own dedicated key.
 */
export interface ExternalKmsKeyRef {
	readonly __brand: 'ExternalKmsKeyRef';
	readonly keyArn: string;
}

/** S3 Object Lock settings for {@link FileBucketOptions.objectLock}. */
export interface ObjectLockOptions {
	/** `'governance'` (bypassable with `s3:BypassGovernanceRetention`) or `'compliance'` (not bypassable by anyone). */
	mode: 'governance' | 'compliance';
	/** Default retention, in days, applied to every new object version. Positive integer, at most 36500. */
	retentionDays: number;
}

// ── Client handle types (hydrated by middleware) ────────────────────────────

/** Client-side download handle. Works server-side and serializes via toJSON() for the wire. */
export interface FileDownloadClient {
	/** Download the file as a Blob (server) or via fetch (client). */
	download(): Promise<Blob>;
	/** Get the presigned URL. */
	getUrl(): string;
	/** @internal Transferable serialization — called automatically by JSON.stringify(). */
	toJSON(): FileDownloadDescriptor;
}

/** Client-side upload handle. Works server-side and serializes via toJSON() for the wire. */
export interface FileUploadClient {
	/** Upload a file body to the presigned URL. */
	upload(body: Blob | File | ArrayBuffer): Promise<void>;
	/** Get the presigned URL. */
	getUrl(): string;
	/** @internal Transferable serialization — called automatically by JSON.stringify(). */
	toJSON(): FileUploadDescriptor;
}

// ── Wire descriptor types ───────────────────────────────────────────────────

export interface FileDownloadDescriptor {
	readonly __blocks: 'file-bucket/download';
	readonly url: string;
}

export interface FileUploadDescriptor {
	readonly __blocks: 'file-bucket/upload';
	readonly url: string;
	/** The signed content type the upload must send. Always set by current servers. */
	readonly contentType?: string;
}
