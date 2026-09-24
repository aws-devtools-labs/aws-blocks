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
import { Scope, registerSdkIdentifiers, getSdkIdentifiers } from '@aws-blocks/core';
import type { ScopeParent } from '@aws-blocks/core';
import { BB_NAME, BB_VERSION } from './version.js';
import { validatePresignedUrlExpiry } from './presigned-url.js';
import type {
	FileBucketOptions, PutOptions, PutUrlOptions, ScanOptions,
	FileContent, FileInfo, ExternalBucketRef,
	FileDownloadClient, FileUploadClient, FileVersionInfo,
	GetOptionsFor, DeleteOptionsFor, GetUrlOptionsFor,
} from './types.js';
import { Logger } from '@aws-blocks/bb-logger';
import type { ChildLogger } from '@aws-blocks/bb-logger';

// Re-export public types
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
		try {
			const result = await this.s3.send(new GetObjectCommand({
				Bucket: getSdkIdentifiers(this).bucketName, Key: path,
				...(options ? { VersionId: (options as any).versionId } : {}),
			}));
			const bytes = await result.Body!.transformToByteArray();
			return {
				body: Buffer.from(bytes),
				contentType: result.ContentType ?? 'application/octet-stream',
				metadata: result.Metadata ?? {},
				size: result.ContentLength ?? bytes.length,
			};
		} catch (e: any) {
			if (e.name === 'NoSuchKey') return null;
			throw e;
		}
	}

	async delete(path: string, options?: DeleteOptionsFor<O>): Promise<void> {
		await this.s3.send(new DeleteObjectCommand({
			Bucket: getSdkIdentifiers(this).bucketName, Key: path,
			...(options ? { VersionId: (options as any).versionId } : {}),
		}));
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
		const expiresIn = validatePresignedUrlExpiry(opts?.expiresIn ?? 3600);
		return getSignedUrl(this.s3, new GetObjectCommand({
			Bucket: getSdkIdentifiers(this).bucketName, Key: path,
			...(opts?.versionId ? { VersionId: opts.versionId } : {}),
		}), {
			expiresIn,
		});
	}

	async putUrl(path: string, options?: PutUrlOptions): Promise<string> {
		const expiresIn = validatePresignedUrlExpiry(options?.expiresIn ?? 3600);
		return getSignedUrl(this.s3, new PutObjectCommand({
			Bucket: getSdkIdentifiers(this).bucketName, Key: path, ContentType: options?.contentType,
		}), { expiresIn });
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
		await this.s3.send(new CopyObjectCommand({
			Bucket: getSdkIdentifiers(this).bucketName,
			Key: path,
			CopySource: `${getSdkIdentifiers(this).bucketName}/${path}?versionId=${versionId}`,
		}));
	}

	static fromExisting(bucketName: string): ExternalBucketRef {
		return { __brand: 'ExternalBucketRef' as const, bucketName };
	}
}
