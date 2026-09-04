// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { Scope, registerSdkIdentifiers } from '@aws-blocks/core';
import { getMockDataDir } from '@aws-blocks/core/bb-utils';
import type { ScopeParent } from '@aws-blocks/core';
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { assertContainedPath } from './mock-utils.js';
import {
	contentRoot, contentPath, metaPath,
	versionsDirFor, versionContentPath, versionMetaPath,
	deleteMarkerPath, isVersionEntry,
} from './paths.js';
import { mintFileToken, LOCAL_FILE_SECRET } from './tokens.js';
import { validateBucketName } from './bucket-name.js';
import type {
	FileBucketOptions, PutOptions, PutUrlOptions, ScanOptions,
	FileContent, FileInfo, ExternalBucketRef,
	FileDownloadClient, FileUploadClient, FileVersionInfo,
	GetOptionsFor, DeleteOptionsFor, GetUrlOptionsFor,
} from './types.js';

export type {
	FileBucketOptions, PutOptions, GetUrlOptions, PutUrlOptions, ScanOptions,
	FileContent, FileInfo, CorsRule, LifecycleRule, ExternalBucketRef,
	FileDownloadClient, FileUploadClient, FileVersionInfo,
	FileDownloadDescriptor, FileUploadDescriptor,
	VersionedGetOptions, VersionedDeleteOptions, VersionedGetUrlOptions,
	GetOptionsFor, DeleteOptionsFor, GetUrlOptionsFor,
} from './types.js';

import { Logger } from '@aws-blocks/bb-logger';
import type { ChildLogger } from '@aws-blocks/bb-logger';
import { BB_NAME, BB_VERSION } from './version.js';

export { FileBucketErrors } from './errors.js';

// ── Helpers ─────────────────────────────────────────────────────────────────

const MAX_KEY_BYTES = 1024; // S3 key limit

function blocksError(name: string, message: string): Error {
	const err = new Error(`${name}: ${message}`);
	err.name = name;
	return err;
}

interface SidecarMeta {
	contentType: string;
	metadata: Record<string, string>;
	cacheControl?: string;
}

function getDevBaseUrl(): string {
	const port = (globalThis as any).__BLOCKS_DEV_SERVER_PORT__ ?? 3001;
	return `http://localhost:${port}`;
}

// ── FileBucket (mock) ───────────────────────────────────────────────────────

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
 * - Use presigned URLs (`getUrl` / `putUrl`) for direct browser upload/download
 * - Use `getFileHandle` / `createUploadHandle` for ergonomic browser file transfers
 * - Prefer `scan({ prefix })` over unscoped `scan()` to limit enumeration cost
 *
 * **Scaling:** S3 scales automatically. No provisioned throughput. Costs are
 * per-request plus storage. Individual objects up to 5 TB. For objects larger
 * than ~100 MB, consider multipart upload.
 */
export class FileBucket<O extends FileBucketOptions = FileBucketOptions> extends Scope {
	private dataDir: string;
	private versioned: boolean;

	/** @internal Logger for internal operations. Defaults to error-level when not provided. */
	protected log: ChildLogger;

	constructor(scope: ScopeParent, id: string, options?: O) {
		super(id, { parent: scope, bbName: BB_NAME, bbVersion: BB_VERSION });
		// Validate the derived bucket name against S3's naming rules so local
		// dev fails the same way a deploy would. Validate `fullId` (the real
		// deployed bucket name), not the `mock-` prefixed local name, to keep
		// parity with the CDK path.
		if (!options?.bucket) validateBucketName(this.fullId);
		this.log = options?.logger ?? new Logger(this, 'logger', { level: 'error' });
		this.dataDir = getMockDataDir(this);
		this.versioned = options?.versioned ?? true;
		this.registerClientMiddleware('@aws-blocks/bb-file-bucket/middleware');
		this.registerDevAttachment('@aws-blocks/bb-file-bucket/file-server');
		registerSdkIdentifiers(this.fullId, { bucketName: `mock-${this.fullId}` });
		// Register in global registry so the file-server can delegate PUT to bucket.put()
		const registry = ((globalThis as any).__BLOCKS_FILE_BUCKET_REGISTRY__ ??= new Map());
		registry.set(this.fullId, this);
	}

	/**
	 * Upload a file.
	 *
	 * Overwrites any existing file at the given path.
	 *
	 * @param path - The object key (e.g., `uploads/photo.jpg`).
	 * @param body - The file content.
	 * @param options - Optional metadata and content settings.
	 *
	 * @example
	 * ```typescript
	 * await bucket.put('reports/q1.pdf', pdfBuffer, {
	 *   contentType: 'application/pdf',
	 * });
	 * ```
	 */
	async put(path: string, body: Buffer | string, options?: PutOptions): Promise<void> {
		this.validateKey(path);
		const filePath = contentPath(this.dataDir, path);
		mkdirSync(dirname(filePath), { recursive: true });

		const buf = typeof body === 'string' ? Buffer.from(body) : body;
		const meta: SidecarMeta = {
			contentType: options?.contentType ?? 'application/octet-stream',
			metadata: options?.metadata ?? {},
			cacheControl: options?.cacheControl,
		};

		if (this.versioned) {
			const versionId = this.nextVersionId(path);
			const versionsDir = versionsDirFor(this.dataDir, path);
			mkdirSync(versionsDir, { recursive: true });
			writeFileSync(versionContentPath(this.dataDir, path, versionId), buf);
			writeFileSync(versionMetaPath(this.dataDir, path, versionId), JSON.stringify(meta));
			// Remove any delete marker
			try { unlinkSync(deleteMarkerPath(this.dataDir, path)); } catch {}
		}

		this.writeMeta(path, meta);
		writeFileSync(filePath, buf);
	}

	/**
	 * Download a file.
	 *
	 * @param path - The object key.
	 * @param options - Optional. On versioned buckets, pass `{ versionId }` to retrieve a specific version.
	 * @returns The file content and metadata, or null if the file does not exist.
	 *
	 * @example
	 * ```typescript
	 * const file = await bucket.get('reports/q1.pdf');
	 * if (file) {
	 *   console.log(file.contentType); // 'application/pdf'
	 * }
	 * ```
	 */
	async get(path: string, options?: GetOptionsFor<O>): Promise<FileContent | null> {
		this.validateKey(path);
		const versionId = (options as any)?.versionId as string | undefined;
		if (versionId && this.versioned) {
			const vPath = versionContentPath(this.dataDir, path, versionId);
			if (!existsSync(vPath)) return null;
			const body = readFileSync(vPath);
			const meta = this.readVersionMeta(path, versionId);
			return { body, contentType: meta.contentType, metadata: meta.metadata, size: body.length };
		}
		const filePath = contentPath(this.dataDir, path);
		if (!existsSync(filePath)) return null;
		// Check for delete marker
		if (this.versioned && existsSync(deleteMarkerPath(this.dataDir, path))) return null;

		const body = readFileSync(filePath);
		const meta = this.readMeta(path);
		return {
			body,
			contentType: meta.contentType,
			metadata: meta.metadata,
			size: body.length,
		};
	}

	/**
	 * Delete a file.
	 *
	 * On non-versioned buckets, permanently removes the file.
	 * On versioned buckets without `versionId`, places a delete marker (file appears deleted
	 * but previous versions are preserved). With `versionId`, permanently removes that version.
	 *
	 * No-op if the file does not exist (matches S3 behavior).
	 *
	 * @param path - The object key.
	 * @param options - Optional. On versioned buckets, pass `{ versionId }` to permanently delete a specific version.
	 *
	 * @example
	 * ```typescript
	 * await bucket.delete('uploads/old-photo.jpg');
	 * ```
	 */
	async delete(path: string, options?: DeleteOptionsFor<O>): Promise<void> {
		this.validateKey(path);
		const versionId = (options as any)?.versionId as string | undefined;
		if (this.versioned && versionId) {
			// Permanently delete a specific version
			try { unlinkSync(versionContentPath(this.dataDir, path, versionId)); } catch {}
			try { unlinkSync(versionMetaPath(this.dataDir, path, versionId)); } catch {}
			return;
		}
		if (this.versioned) {
			// Place a delete marker — current file stays on disk for version history
			const versionsDir = versionsDirFor(this.dataDir, path);
			mkdirSync(versionsDir, { recursive: true });
			writeFileSync(deleteMarkerPath(this.dataDir, path), '');
			return;
		}
		try { unlinkSync(contentPath(this.dataDir, path)); } catch {}
		try { unlinkSync(metaPath(this.dataDir, path)); } catch {}
	}

	/**
	 * Delete multiple files in a single operation.
	 *
	 * Uses S3 DeleteObjects for efficient bulk deletion (up to 1,000 keys
	 * per request). Chunking is handled internally.
	 *
	 * @param paths - The object keys to delete.
	 *
	 * @example
	 * ```typescript
	 * await bucket.deleteBatch(['tmp/a.txt', 'tmp/b.txt', 'tmp/c.txt']);
	 * ```
	 */
	async deleteBatch(paths: string[]): Promise<void> {
		for (const p of paths) {
			await this.delete(p);
		}
	}

	/**
	 * Generate a presigned URL for downloading a file.
	 *
	 * @param path - The object key.
	 * @param options - URL generation options.
	 * @returns A presigned URL string.
	 *
	 * @example
	 * ```typescript
	 * const url = await bucket.getUrl('reports/q1.pdf', { expiresIn: 3600 });
	 * ```
	 */
	async getUrl(path: string, options?: GetUrlOptionsFor<O>): Promise<string> {
		const expiresIn = (options as any)?.expiresIn ?? 3600;
		const token = mintFileToken(this.fullId, path, 'GET', expiresIn, LOCAL_FILE_SECRET);
		const encodedPath = path.split('/').map(s => encodeURIComponent(s)).join('/');
		let url = `${getDevBaseUrl()}/.bb-file-bucket/${this.fullId}/${encodedPath}?token=${token}`;
		const versionId = (options as any)?.versionId;
		if (versionId && this.versioned) url += `&versionId=${versionId}`;
		return url;
	}

	/**
	 * Generate a presigned URL for uploading a file.
	 *
	 * @param path - The object key.
	 * @param options - URL generation options.
	 * @returns A presigned URL string.
	 *
	 * @example
	 * ```typescript
	 * const url = await bucket.putUrl('uploads/photo.jpg', {
	 *   expiresIn: 600,
	 *   contentType: 'image/jpeg',
	 * });
	 * ```
	 */
	async putUrl(path: string, options?: PutUrlOptions): Promise<string> {
		const expiresIn = options?.expiresIn ?? 3600;
		const token = mintFileToken(this.fullId, path, 'PUT', expiresIn, LOCAL_FILE_SECRET, options?.contentType);
		const encodedPath = path.split('/').map(s => encodeURIComponent(s)).join('/');
		return `${getDevBaseUrl()}/.bb-file-bucket/${this.fullId}/${encodedPath}?token=${token}`;
	}

	/**
	 * Get a file handle for browser-side download.
	 *
	 * Returns a Transferable descriptor that the client middleware hydrates
	 * into an object with `.download()` and `.getUrl()` methods. Use this
	 * instead of `getUrl()` when you want the client to download files
	 * without manually managing presigned URLs.
	 *
	 * @param path - The object key.
	 * @param options - URL generation options.
	 * @returns A Transferable file download handle.
	 *
	 * @example
	 * ```typescript
	 * // Backend
	 * async getReport(name: string) {
	 *   return bucket.getFileHandle('reports/' + name);
	 * }
	 *
	 * // Frontend
	 * const file = await api.getReport('q1.pdf');
	 * const blob = await file.download();
	 * ```
	 */
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

	/**
	 * Create an upload handle for browser-side file upload.
	 *
	 * Returns a Transferable descriptor that the client middleware hydrates
	 * into an object with `.upload(body)` and `.getUrl()` methods. Use this
	 * instead of `putUrl()` when you want the client to upload files
	 * without manually managing presigned URLs.
	 *
	 * @param path - The object key.
	 * @param options - URL generation options.
	 * @returns A Transferable file upload handle.
	 *
	 * @example
	 * ```typescript
	 * // Backend
	 * async getUploadSlot(name: string) {
	 *   return bucket.createUploadHandle('uploads/' + name, {
	 *     contentType: 'image/jpeg',
	 *   });
	 * }
	 *
	 * // Frontend
	 * const slot = await api.getUploadSlot('photo.jpg');
	 * await slot.upload(fileBlob);
	 * ```
	 */
	async createUploadHandle(path: string, options?: PutUrlOptions): Promise<FileUploadClient> {
		const expiresIn = options?.expiresIn ?? 3600;
		const token = mintFileToken(this.fullId, path, 'PUT', expiresIn, LOCAL_FILE_SECRET, options?.contentType);
		const encodedPath = path.split('/').map(s => encodeURIComponent(s)).join('/');
		const url = `${getDevBaseUrl()}/.bb-file-bucket/${this.fullId}/${encodedPath}?token=${token}`;
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

	/**
	 * List files in the bucket.
	 *
	 * Returns an `AsyncIterable` that paginates internally. Use `prefix`
	 * to scope the listing. Without a prefix, enumerates all files —
	 * this is expensive on large buckets.
	 *
	 * @param options - Listing options.
	 * @returns An async iterable of file info objects.
	 *
	 * @example
	 * ```typescript
	 * for await (const file of bucket.scan({ prefix: 'uploads/' })) {
	 *   console.log(file.path, file.size);
	 * }
	 * ```
	 */
	async *scan(options?: ScanOptions): AsyncIterable<FileInfo> {
		const root = contentRoot(this.dataDir);
		for (const absPath of this.walkDir(root)) {
			const relPath = relative(root, absPath).replace(/\\/g, '/');
			if (options?.prefix && !relPath.startsWith(options.prefix)) continue;
			// Skip files with delete markers
			if (this.versioned && existsSync(deleteMarkerPath(this.dataDir, relPath))) continue;
			const stat = statSync(absPath);
			yield { path: relPath, size: stat.size, lastModified: stat.mtime };
		}
	}

	/**
	 * List all versions of a file. Only available on versioned buckets.
	 *
	 * Returns versions newest-first. Includes the current version and all
	 * previous versions. Does not include delete markers.
	 *
	 * @param path - The object key.
	 * @returns An array of version metadata, newest first.
	 *
	 * @example
	 * ```typescript
	 * const versions = await bucket.listVersions('report.pdf');
	 * for (const v of versions) {
	 *   console.log(v.versionId, v.lastModified, v.isCurrent);
	 * }
	 * ```
	 */
	async listVersions(path: string): Promise<FileVersionInfo[]> {
		const versionsDir = versionsDirFor(this.dataDir, path);
		if (!existsSync(versionsDir)) return [];
		const entries = readdirSync(versionsDir).filter(isVersionEntry);
		if (entries.length === 0) return [];

		const hasDeleteMarker = existsSync(deleteMarkerPath(this.dataDir, path));
		const versions: FileVersionInfo[] = entries.map(versionId => {
			const vPath = versionContentPath(this.dataDir, path, versionId);
			const stat = statSync(vPath);
			return { versionId, lastModified: stat.mtime, size: stat.size, isCurrent: false };
		});
		// Sort newest first; break ties by version number (descending) for deterministic ordering
		versions.sort((a, b) => {
			const timeDiff = b.lastModified.getTime() - a.lastModified.getTime();
			if (timeDiff !== 0) return timeDiff;
			const aNum = parseInt(a.versionId.slice(1), 10);
			const bNum = parseInt(b.versionId.slice(1), 10);
			return bNum - aNum;
		});
		// Mark the newest as current (unless there's a delete marker)
		if (versions.length > 0 && !hasDeleteMarker) {
			versions[0].isCurrent = true;
		}
		return versions;
	}

	/**
	 * Restore a previous version of a file, making it the current version.
	 *
	 * Creates a new version that is a copy of the specified old version.
	 * On S3, this is implemented as a CopyObject from the old version to the same key.
	 *
	 * @param path - The object key.
	 * @param versionId - The version to restore.
	 *
	 * @example
	 * ```typescript
	 * const versions = await bucket.listVersions('report.pdf');
	 * await bucket.restoreVersion('report.pdf', versions[1].versionId);
	 * ```
	 */
	async restoreVersion(path: string, versionId: string): Promise<void> {
		const vPath = versionContentPath(this.dataDir, path, versionId);
		if (!existsSync(vPath)) {
			throw blocksError('NoSuchVersion', `Version "${versionId}" does not exist for "${path}"`);
		}
		const body = readFileSync(vPath);
		const meta = this.readVersionMeta(path, versionId);
		await this.put(path, body, { contentType: meta.contentType, metadata: meta.metadata });
	}

	/**
	 * Create a reference to an existing S3 bucket not managed by this scope.
	 *
	 * @param bucketName - The name of the existing S3 bucket.
	 */
	static fromExisting(bucketName: string): ExternalBucketRef {
		return { __brand: 'ExternalBucketRef' as const, bucketName };
	}

	// ── Internal helpers ──────────────────────────────────────────────────

	private validateKey(key: string): void {
		if (Buffer.byteLength(key, 'utf8') > MAX_KEY_BYTES) {
			this.log.warn(`Key "${key}" exceeds S3's 1,024-byte limit`);
		}
		assertContainedPath(contentRoot(this.dataDir), key);
	}

	private writeMeta(path: string, meta: SidecarMeta): void {
		const mPath = metaPath(this.dataDir, path);
		mkdirSync(dirname(mPath), { recursive: true });
		writeFileSync(mPath, JSON.stringify(meta));
	}

	private readMeta(path: string): SidecarMeta {
		return this.readMetaFile(metaPath(this.dataDir, path));
	}

	private readVersionMeta(path: string, versionId: string): SidecarMeta {
		return this.readMetaFile(versionMetaPath(this.dataDir, path, versionId));
	}

	private readMetaFile(mPath: string): SidecarMeta {
		if (existsSync(mPath)) {
			try { return JSON.parse(readFileSync(mPath, 'utf8')); } catch {}
		}
		return { contentType: 'application/octet-stream', metadata: {} };
	}

	private walkDir(dir: string): string[] {
		if (!existsSync(dir)) return [];
		const results: string[] = [];
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const full = join(dir, entry.name);
			if (entry.isDirectory()) {
				results.push(...this.walkDir(full));
			} else {
				results.push(full);
			}
		}
		return results;
	}

	private nextVersionId(path: string): string {
		const dir = versionsDirFor(this.dataDir, path);
		if (!existsSync(dir)) return 'v1';
		const existing = readdirSync(dir)
			.filter(f => f.startsWith('v') && !f.includes('.'))
			.map(f => parseInt(f.slice(1), 10))
			.filter(n => !isNaN(n));
		return `v${(existing.length > 0 ? Math.max(...existing) : 0) + 1}`;
	}
}
