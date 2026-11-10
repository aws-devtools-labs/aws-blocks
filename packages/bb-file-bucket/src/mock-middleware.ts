// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * @aws-blocks/bb-file-bucket/mock-middleware
 *
 * Self-registering client middleware for local dev.
 * Hydrates { __blocks: 'file-bucket/download' } and { __blocks: 'file-bucket/upload' }
 * descriptors into live file handles with .download() / .upload() methods.
 */

import { registerMiddleware } from '@aws-blocks/core/client';
import type { FileDownloadClient, FileUploadClient } from './types.js';

export type { FileDownloadClient, FileUploadClient };

function isDownloadDescriptor(data: unknown): data is { __blocks: 'file-bucket/download'; url: string } {
	if (typeof data !== 'object' || data === null) return false;
	const d = data as Record<string, unknown>;
	return d.__blocks === 'file-bucket/download' && typeof d.url === 'string';
}

function isUploadDescriptor(data: unknown): data is { __blocks: 'file-bucket/upload'; url: string; contentType?: string } {
	if (typeof data !== 'object' || data === null) return false;
	const d = data as Record<string, unknown>;
	return d.__blocks === 'file-bucket/upload' && typeof d.url === 'string';
}

/**
 * Hydrates `{ __blocks: 'file-bucket/download' }` and
 * `{ __blocks: 'file-bucket/upload' }` descriptors into live file handles.
 * Registered as response middleware via `registerMiddleware` below.
 *
 * The middleware runs on the result of every API call in the app, so it
 * walks arrays and plain objects to find nested descriptors. Every other
 * object comes back as a plain object with the same own enumerable keys
 * (a JSON key such as `"__proto__"` stays an ordinary key) and
 * `Object.prototype` as its prototype; primitives are returned unchanged.
 */
function hydrate(data: unknown): unknown {
	if (isDownloadDescriptor(data)) {
		const { url } = data;
		return {
			async download(): Promise<Blob> {
				const res = await fetch(url);
				if (!res.ok) throw new Error(`Download failed: ${res.status}`);
				return res.blob();
			},
			getUrl(): string { return url; },
			toJSON() { return { __blocks: 'file-bucket/download' as const, url }; },
		} satisfies FileDownloadClient;
	}

	if (isUploadDescriptor(data)) {
		const { url, contentType } = data;
		return {
			async upload(body: Blob | File | ArrayBuffer): Promise<void> {
				const headers: Record<string, string> = {};
				if (contentType) headers['Content-Type'] = contentType;
				const res = await fetch(url, { method: 'PUT', body, headers });
				if (!res.ok) throw new Error(`Upload failed: ${res.status}`);
			},
			getUrl(): string { return url; },
			toJSON() { return { __blocks: 'file-bucket/upload' as const, url, contentType }; },
		} satisfies FileUploadClient;
	}

	if (Array.isArray(data)) return data.map(hydrate);
	if (typeof data === 'object' && data !== null) {
		// Object.fromEntries defines own data properties, so a JSON key named
		// `__proto__` stays a key instead of becoming the copy's prototype.
		return Object.fromEntries(Object.entries(data).map(([k, v]) => [k, hydrate(v)]));
	}
	return data;
}

registerMiddleware({ onResponse: hydrate });
