// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Shared types for FileBucket. Imported by mock, aws, and browser entry points.
 * This file has zero runtime dependencies — types only.
 */
import type { ChildLogger } from '@aws-blocks/bb-logger';

// ── Constructor options ─────────────────────────────────────────────────────

export interface FileBucketOptions {
	/** Enable object versioning. Default: false. */
	versioned?: boolean;
	/** CORS rules for browser-based access. */
	corsRules?: CorsRule[];
	/** Lifecycle rules for automatic object expiration or transitions. */
	lifecycleRules?: LifecycleRule[];
	/** Wrap an existing S3 bucket instead of creating one. */
	bucket?: ExternalBucketRef;
	/**
	 * CDK removal behavior for the underlying S3 bucket. When omitted,
	 * CDK's default applies (RETAIN — the bucket and its contents are
	 * preserved on `cdk destroy`).
	 *
	 * Pass `'destroy'` to drop the bucket on teardown (`RemovalPolicy.DESTROY`).
	 * By default `autoDeleteObjects` (which empties the bucket before deletion)
	 * is enabled **only in sandbox mode**. In a prod stack, `'destroy'` sets
	 * DESTROY but does NOT auto-empty — S3 rejects deleting a non-empty bucket,
	 * so a populated prod bucket is preserved rather than silently wiped. To
	 * opt a genuinely-ephemeral prod bucket into auto-empty behavior, set
	 * {@link autoDeleteObjects} explicitly.
	 *
	 * Why sandbox-only by default: CDK implements `autoDeleteObjects` via a
	 * hidden `Custom::S3AutoDeleteObjects` Lambda whose delete behavior
	 * stack-level retention Aspects (`RemovalPolicies.of(stack).retain()`)
	 * cannot override. Keeping it out of prod stacks by default ensures those
	 * Aspects remain effective unless a caller deliberately opts out.
	 *
	 * Pass `'retain'` to set the policy explicitly (identical to omitting
	 * it today, but robust against stack-layer policy overrides).
	 *
	 * Templates that apply `RemovalPolicies.of(stack).destroy()` at the
	 * top level override this setting.
	 *
	 * Ignored by the mock and browser runtimes (no AWS resource to retain).
	 */
	removalPolicy?: 'destroy' | 'retain';
	/**
	 * Explicitly control whether the bucket is emptied before deletion via
	 * CDK's `autoDeleteObjects`. Only takes effect when the bucket is being
	 * destroyed (`removalPolicy: 'destroy'`, or sandbox default).
	 *
	 * When omitted, defaults to sandbox-only: auto-empty is enabled in sandbox
	 * mode and disabled in prod. Set `true` to force auto-empty for a
	 * deliberately-ephemeral prod bucket, or `false` to disable it even in
	 * sandbox.
	 *
	 * ⚠️ Enabling this provisions a hidden `Custom::S3AutoDeleteObjects` Lambda
	 * whose delete behavior stack-level retention Aspects
	 * (`RemovalPolicies.of(stack).retain()`) cannot override. Only opt in for a
	 * bucket you genuinely intend to be throwaway — this is a deliberate,
	 * visible footgun rather than the default.
	 *
	 * Ignored by the mock and browser runtimes.
	 */
	autoDeleteObjects?: boolean;
	/** Optional logger for internal operations. When omitted, a default Logger at error level is created. */
	logger?: ChildLogger;
}

// ── Method options ──────────────────────────────────────────────────────────

export interface PutOptions {
	/** MIME type of the file (e.g., `image/png`). */
	contentType?: string;
	/** Custom metadata key-value pairs. */
	metadata?: Record<string, string>;
	/** Cache-Control header value. */
	cacheControl?: string;
}

export interface GetUrlOptions {
	/** URL expiration in seconds. Default: 3600. */
	expiresIn?: number;
}

export interface PutUrlOptions {
	/** URL expiration in seconds. Default: 3600. */
	expiresIn?: number;
	/** Required content type for the upload. */
	contentType?: string;
}

export interface ScanOptions {
	/** Only list files whose keys start with this prefix. */
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
 */
export type GetOptionsFor<O extends FileBucketOptions> =
	O extends { versioned: true } ? VersionedGetOptions : undefined;

/**
 * Resolves the delete options type based on whether versioning is enabled.
 * Versioned buckets accept `{ versionId }`, non-versioned accept no options.
 */
export type DeleteOptionsFor<O extends FileBucketOptions> =
	O extends { versioned: true } ? VersionedDeleteOptions : undefined;

/**
 * Resolves the getUrl/getFileHandle options type based on whether versioning is enabled.
 * Versioned buckets accept `{ expiresIn, versionId }`, non-versioned accept `{ expiresIn }`.
 */
export type GetUrlOptionsFor<O extends FileBucketOptions> =
	O extends { versioned: true } ? VersionedGetUrlOptions : GetUrlOptions;

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

export interface ExternalBucketRef {
	readonly __brand: 'ExternalBucketRef';
	readonly bucketName: string;
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
	readonly contentType?: string;
}
