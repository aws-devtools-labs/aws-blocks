// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import {
	S3Client,
	PutObjectCommand,
	GetObjectCommand,
	DeleteObjectCommand,
	DeleteObjectsCommand,
	ListObjectsV2Command,
	ListObjectVersionsCommand,
	CopyObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Scope, registerSdkIdentifiers, getSdkIdentifiers, blocksError } from '@aws-blocks/core';
import type { ScopeParent } from '@aws-blocks/core';
import { BB_NAME, BB_VERSION } from './version.js';
import type {
	FileBucketOptions, PutOptions, PutUrlOptions, ScanOptions,
	FileContent, FileInfo, ExternalBucketRef,
	FileDownloadClient, FileUploadClient, FileVersionInfo,
	GetOptionsFor, DeleteOptionsFor, GetUrlOptionsFor,
} from './types.js';
import { Logger } from '@aws-blocks/bb-logger';
import type { ChildLogger } from '@aws-blocks/bb-logger';

// Re-export public types
import { FileBucketErrors } from './errors.js';
export { FileBucketErrors } from './errors.js';
export type {
	FileBucketOptions, PutOptions, GetUrlOptions, PutUrlOptions, ScanOptions,
	FileContent, FileInfo, CorsRule, LifecycleRule, ExternalBucketRef,
	FileDownloadClient, FileUploadClient, FileVersionInfo,
	FileDownloadDescriptor, FileUploadDescriptor,
	VersionedGetOptions, VersionedDeleteOptions, VersionedGetUrlOptions,
	GetOptionsFor, DeleteOptionsFor, GetUrlOptionsFor,
} from './types.js';

/**
 * File storage backed by Amazon S3.
 *
 * **When to use:** You need to store, retrieve, or serve binary files —
 * user uploads, generated reports, images, videos, or static assets.
 *
 * **When NOT to use:** If you need structured key-value data with conditional
 * writes, use `KVStore`. If you need queryable records with indexes, use
 * `DistributedTable`.
 *
 * **Best practices:**
 * - Use path prefixes to organize files (e.g., `uploads/{userId}/`, `reports/`)
 * - Set `contentType` on `put()` to ensure correct MIME handling on download
 * - Use `getFileHandle` / `createUploadHandle` for ergonomic browser file transfers
 * - Use presigned URLs (`getUrl` / `putUrl`) when you need direct URL control
 * - Prefer `scan({ prefix })` over unscoped `scan()` to limit enumeration cost
 *
 * **Scaling:** S3 scales automatically. No provisioned throughput. Costs are
 * per-request plus storage. Individual objects up to 5 TB. For objects larger
 * than ~100 MB, consider multipart upload.
 */
export class FileBucket<O extends FileBucketOptions = FileBucketOptions> extends Scope {
	readonly bbName = BB_NAME;
	private s3: S3Client;

	/** @internal Logger for internal operations. Defaults to error-level when not provided. */
	protected log: ChildLogger;

	constructor(scope: ScopeParent, id: string, options?: O) {
		super(id, { parent: scope, bbName: BB_NAME, bbVersion: BB_VERSION });
		this.log = options?.logger ?? new Logger(this, 'logger', { level: 'error' });
		this.registerClientMiddleware('@aws-blocks/bb-file-bucket/middleware');
		const bucketName = options?.bucket ? options.bucket.bucketName : this.fullId;
		registerSdkIdentifiers(this.fullId, { bucketName });
		this.s3 = new S3Client({
			customUserAgent: this.buildUserAgentChain(),
		});
	}

	async put(path: string, body: Buffer | string, options?: PutOptions): Promise<void> {
		await this.s3.send(new PutObjectCommand({
			Bucket: getSdkIdentifiers(this).bucketName,
			Key: path,
			Body: typeof body === 'string' ? Buffer.from(body) : body,
			ContentType: options?.contentType,
			Metadata: options?.metadata,
			CacheControl: options?.cacheControl,
		}));
	}

	async get(path: string, options?: GetOptionsFor<O>): Promise<FileContent | null> {
		const versionId = (options as { versionId?: string } | undefined)?.versionId;
		try {
			const result = await this.s3.send(new GetObjectCommand({
				Bucket: getSdkIdentifiers(this).bucketName, Key: path,
				...(versionId !== undefined ? { VersionId: versionId } : {}),
			}));
			const bytes = await result.Body!.transformToByteArray();
			return {
				body: Buffer.from(bytes),
				contentType: result.ContentType ?? 'application/octet-stream',
				metadata: result.Metadata ?? {},
				size: result.ContentLength ?? bytes.length,
			};
		} catch (e: unknown) {
			if (e instanceof Error) {
				// A missing object is "not found" — return null per get()'s
				// documented contract, matching the mock.
				if (e.name === 'NoSuchKey') return null;
				// An unknown `versionId` is also "not found" (the mock returns null
				// for it), but S3 does NOT signal it as NoSuchVersion: an id S3
				// cannot resolve is rejected up front with `InvalidArgument`
				// ("Invalid version id specified", 400) — verified against real S3 —
				// while a well-formed id that no longer exists surfaces as
				// `NoSuchVersion`. Fold both to null, but only when the caller
				// actually supplied a versionId, so an InvalidArgument raised by
				// anything else still propagates.
				if (versionId !== undefined && (e.name === 'InvalidArgument' || e.name === 'NoSuchVersion')) return null;
			}
			throw e;
		}
	}

	async delete(path: string, options?: DeleteOptionsFor<O>): Promise<void> {
		const versionId = (options as { versionId?: string } | undefined)?.versionId;
		try {
			await this.s3.send(new DeleteObjectCommand({
				Bucket: getSdkIdentifiers(this).bucketName, Key: path,
				...(versionId !== undefined ? { VersionId: versionId } : {}),
			}));
		} catch (e: unknown) {
			// The mock deletes a specific version with `try { unlink } catch {}` — a
			// silent no-op for an unknown version. Match that: S3 rejects an
			// unresolvable versionId with `InvalidArgument` (or `NoSuchVersion` for a
			// well-formed id that no longer exists), and DeleteObject is already a
			// no-op for a missing key. Only swallow when a versionId was supplied, so
			// an InvalidArgument from anything else still surfaces.
			if (
				versionId !== undefined &&
				e instanceof Error &&
				(e.name === 'InvalidArgument' || e.name === 'NoSuchVersion')
			) {
				return;
			}
			throw e;
		}
	}

	async deleteBatch(paths: string[]): Promise<void> {
		const CHUNK_SIZE = 1000;
		for (let i = 0; i < paths.length; i += CHUNK_SIZE) {
			const chunk = paths.slice(i, i + CHUNK_SIZE);
			await this.s3.send(new DeleteObjectsCommand({
				Bucket: getSdkIdentifiers(this).bucketName,
				Delete: { Objects: chunk.map(Key => ({ Key })), Quiet: true },
			}));
		}
	}

	async getUrl(path: string, options?: GetUrlOptionsFor<O>): Promise<string> {
		const opts = options as any;
		return getSignedUrl(this.s3, new GetObjectCommand({
			Bucket: getSdkIdentifiers(this).bucketName, Key: path,
			...(opts?.versionId ? { VersionId: opts.versionId } : {}),
		}), {
			expiresIn: opts?.expiresIn ?? 3600,
		});
	}

	async putUrl(path: string, options?: PutUrlOptions): Promise<string> {
		return getSignedUrl(this.s3, new PutObjectCommand({
			Bucket: getSdkIdentifiers(this).bucketName, Key: path, ContentType: options?.contentType,
		}), { expiresIn: options?.expiresIn ?? 3600 });
	}

	async getFileHandle(path: string, options?: GetUrlOptionsFor<O>): Promise<FileDownloadClient> {
		const url = await this.getUrl(path, options);
		return {
			download: async () => {
				const res = await fetch(url);
				if (!res.ok) throw new Error(`Download failed: ${res.status}`);
				return res.blob();
			},
			getUrl: () => url,
			toJSON: () => ({ __blocks: 'file-bucket/download' as const, url }),
		};
	}

	async createUploadHandle(path: string, options?: PutUrlOptions): Promise<FileUploadClient> {
		const url = await this.putUrl(path, options);
		const contentType = options?.contentType;
		return {
			upload: async (body: Blob | File | ArrayBuffer) => {
				const headers: Record<string, string> = {};
				if (contentType) headers['Content-Type'] = contentType;
				const res = await fetch(url, { method: 'PUT', body, headers });
				if (!res.ok) throw new Error(`Upload failed: ${res.status}`);
			},
			getUrl: () => url,
			toJSON: () => ({ __blocks: 'file-bucket/upload' as const, url, contentType }),
		};
	}

	async *scan(options?: ScanOptions): AsyncIterable<FileInfo> {
		let continuationToken: string | undefined;
		do {
			const result = await this.s3.send(new ListObjectsV2Command({
				Bucket: getSdkIdentifiers(this).bucketName, Prefix: options?.prefix, ContinuationToken: continuationToken,
			}));
			for (const obj of result.Contents ?? []) {
				yield { path: obj.Key!, size: obj.Size ?? 0, lastModified: obj.LastModified ?? new Date() };
			}
			continuationToken = result.NextContinuationToken;
		} while (continuationToken);
	}

	async listVersions(path: string): Promise<FileVersionInfo[]> {
		const versions: FileVersionInfo[] = [];
		let keyMarker: string | undefined;
		let versionIdMarker: string | undefined;
		do {
			const result = await this.s3.send(new ListObjectVersionsCommand({
				Bucket: getSdkIdentifiers(this).bucketName, Prefix: path, KeyMarker: keyMarker, VersionIdMarker: versionIdMarker,
			}));
			for (const v of result.Versions ?? []) {
				if (v.Key !== path) continue; // prefix match may include other keys
				versions.push({
					versionId: v.VersionId!,
					lastModified: v.LastModified ?? new Date(),
					size: v.Size ?? 0,
					isCurrent: v.IsLatest ?? false,
				});
			}
			keyMarker = result.NextKeyMarker;
			versionIdMarker = result.NextVersionIdMarker;
		} while (keyMarker);
		// Newest first
		versions.sort((a, b) => b.lastModified.getTime() - a.lastModified.getTime());
		return versions;
	}

	async restoreVersion(path: string, versionId: string): Promise<void> {
		const encodedPath = path.split('/').map(s => encodeURIComponent(s)).join('/');
		try {
			await this.s3.send(new CopyObjectCommand({
				Bucket: getSdkIdentifiers(this).bucketName,
				Key: path,
				// Encode the caller-supplied versionId too: it lands in a hand-built
				// `x-amz-copy-source` header, so a value with `&`, `#`, `?` or a space
				// would corrupt the header (and could append query params) rather than
				// being rejected as an unknown version.
				CopySource: `${getSdkIdentifiers(this).bucketName}/${encodedPath}?versionId=${encodeURIComponent(versionId)}`,
			}));
		} catch (e: unknown) {
			// An unknown version (or a missing key) is a violated precondition.
			// Match the mock exactly: throw via core's `blocksError('NoSuchVersion',
			// …)` — the same producer the mock uses — so both `.name` (matchable via
			// `isBlocksError(e, 'NoSuchVersion')`) AND the name-prefixed `.message`
			// agree across runtimes, instead of the raw S3 error whose enumerable
			// `$metadata`/ARNs would leak to the client if serialized (Core rule 5).
			// S3 spells an unresolvable version id as `InvalidRequest` on CopyObject
			// (verified against real S3), `InvalidArgument` for a malformed id, or
			// `NoSuchVersion` for a well-formed id that no longer exists.
			if (
				e instanceof Error &&
				(e.name === 'NoSuchVersion' ||
					e.name === 'NoSuchKey' ||
					e.name === 'InvalidRequest' ||
					e.name === 'InvalidArgument')
			) {
				throw blocksError(FileBucketErrors.VersionNotFound, `Version "${versionId}" does not exist for "${path}"`);
			}
			throw e;
		}
	}

	static fromExisting(bucketName: string): ExternalBucketRef {
		return { __brand: 'ExternalBucketRef' as const, bucketName };
	}
}
