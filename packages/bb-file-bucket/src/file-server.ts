// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Dev server attachment for FileBucket.
 * Serves token-gated GET/PUT requests at /.bb-file-bucket/{fullId}/{path}?token=...
 * Mirrors S3 presigned URL behavior: method-scoped, time-limited, path-specific.
 *
 * Storage layout mirrors `index.mock.ts` via the shared `paths.ts` helpers, so
 * user content (under `content/`) is never confused with internal metadata or
 * version bookkeeping. PUT always delegates to the registered FileBucket
 * instance so uploads get versioning, key validation, and metadata handling —
 * there is no direct-write fallback.
 */

import type { Server, IncomingMessage, ServerResponse } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isBlocksError } from '@aws-blocks/core';
import { validateFileToken, LOCAL_FILE_SECRET } from './tokens.js';
import { assertContainedPath } from './mock-utils.js';
import { contentRoot, contentPath, metaPath, versionContentPath, versionMetaPath } from './paths.js';

const PREFIX = '/.bb-file-bucket/';

function parseUrl(url: string): { fullId: string; path: string; token: string; versionId?: string } | null {
	if (!url.startsWith(PREFIX)) return null;
	const [pathPart, query] = url.slice(PREFIX.length).split('?');
	if (!pathPart || !query) return null;
	const params = new URLSearchParams(query);
	const token = params.get('token');
	if (!token) return null;
	const slashIdx = pathPart.indexOf('/');
	if (slashIdx === -1) return null;
	return {
		fullId: pathPart.slice(0, slashIdx),
		path: decodeURIComponent(pathPart.slice(slashIdx + 1)),
		token,
		versionId: params.get('versionId') ?? undefined,
	};
}

function collectBody(req: IncomingMessage): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		req.on('data', (chunk: Buffer) => chunks.push(chunk));
		req.on('end', () => resolve(Buffer.concat(chunks)));
		req.on('error', reject);
	});
}

function sendError(res: ServerResponse, status: number, error: string): void {
	res.writeHead(status, { 'Content-Type': 'application/json' });
	res.end(JSON.stringify({ error }));
}

export function attach(httpServer: Server) {
	const originalListeners = httpServer.listeners('request').slice() as Array<(req: IncomingMessage, res: ServerResponse) => void>;
	httpServer.removeAllListeners('request');

	httpServer.on('request', (req: IncomingMessage, res: ServerResponse) => {
		const url = req.url || '';
		if (!url.startsWith(PREFIX)) {
			// Pass through to original handlers
			for (const listener of originalListeners) {
				listener(req, res);
			}
			return;
		}

		// CORS for browser uploads/downloads
		const origin = req.headers.origin || '*';
		// Reflecting the request Origin (falling back to '*') is intentional: it
		// lets a localhost cross-port dev server (e.g. Vite/webpack on a different
		// port) call this local file-server. This dev file-server is local tooling
		// only and NEVER deploys to AWS / production.
		// It is safe because Access-Control-Allow-Credentials is deliberately NOT
		// set, so the reflected origin carries no ambient credentials: presigned-URL
		// auth is a query-string token, not a cookie / ambient session. That is what
		// makes reflecting an arbitrary origin here safe.
		// WARNING: do not re-add Access-Control-Allow-Credentials and do not
		// 'tighten' this reflection without understanding the above.
		res.setHeader('Access-Control-Allow-Origin', origin);
		res.setHeader('Access-Control-Allow-Methods', 'GET, PUT, OPTIONS');
		res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

		if (req.method === 'OPTIONS') {
			res.writeHead(200);
			res.end();
			return;
		}

		const parsed = parseUrl(url);
		if (!parsed) {
			sendError(res, 400, 'Invalid file URL');
			return;
		}

		const { fullId, path, token, versionId } = parsed;
		const dataDir = join(process.cwd(), '.bb-data', fullId);

		try {
			// User keys live under the content root; validate against it so a
			// traversal attempt can't escape into internal meta/version storage.
			assertContainedPath(contentRoot(dataDir), path);
		} catch (err) {
			const message = isBlocksError(err, 'ValidationFailed') ? err.message : 'Invalid path: traversal detected';
			sendError(res, 400, message);
			return;
		}

		// versionId is attacker-controlled and is joined into a filesystem path
		// (versionContentPath). It must match the generated format (`v<n>`);
		// anything else (e.g. `../../../etc/passwd`) is rejected so it can't be
		// used for path traversal / arbitrary file read.
		if (versionId !== undefined && !/^v\d{1,10}$/.test(versionId)) {
			sendError(res, 400, 'Invalid versionId');
			return;
		}

		if (req.method === 'GET') {
			const valid = validateFileToken(token, LOCAL_FILE_SECRET, fullId, path, 'GET');
			if (!valid) {
				sendError(res, 403, 'Invalid or expired token');
				return;
			}

			// Resolve the file to read — specific version or current
			let readPath = contentPath(dataDir, path);
			let metaFilePath = metaPath(dataDir, path);
			if (versionId) {
				const vPath = versionContentPath(dataDir, path, versionId);
				if (existsSync(vPath)) {
					readPath = vPath;
					metaFilePath = versionMetaPath(dataDir, path, versionId);
				}
			}

			if (!existsSync(readPath)) {
				sendError(res, 404, 'NoSuchKey');
				return;
			}

			let contentType = 'application/octet-stream';
			if (existsSync(metaFilePath)) {
				try {
					const meta = JSON.parse(readFileSync(metaFilePath, 'utf8'));
					contentType = meta.contentType ?? contentType;
				} catch {}
			}

			const body = readFileSync(readPath);
			// The stored object body and its Content-Type are attacker-controlled
			// (any client with a presigned PUT can upload arbitrary bytes under an
			// arbitrary content type). Serving that back inline turns the dev file
			// server into a stored-XSS vector: an uploaded `text/html` (or sniffed
			// HTML/SVG) payload would execute in the origin of the local app.
			// `nosniff` stops the browser from MIME-sniffing octet-streams into
			// HTML, and `Content-Disposition: attachment` forces a download rather
			// than inline rendering — so an uploaded document can never run as a
			// page. Real S3 objects served through CloudFront are hardened the same
			// way; this keeps local dev from being weaker than production.
			res.writeHead(200, {
				'Content-Type': contentType,
				'Content-Length': body.length.toString(),
				'X-Content-Type-Options': 'nosniff',
				'Content-Disposition': 'attachment',
			});
			res.end(body);
		} else if (req.method === 'PUT') {
			const valid = validateFileToken(token, LOCAL_FILE_SECRET, fullId, path, 'PUT');
			if (!valid) {
				sendError(res, 403, 'Invalid or expired token');
				return;
			}

			// PUT delegates to the registered FileBucket instance, which owns the
			// storage layout (content/meta/versions) plus versioning and key
			// validation. The dev server and the buckets share a process, so the
			// instance is always registered in practice; if it's missing, fail
			// loud rather than silently writing an unversioned object.
			const registry: Map<string, { put?: unknown }> | undefined = (globalThis as any).__BLOCKS_FILE_BUCKET_REGISTRY__;
			const bucket = registry?.get(fullId);
			if (!bucket || typeof bucket.put !== 'function') {
				sendError(res, 500, `No FileBucket registered for "${fullId}" — cannot handle upload`);
				return;
			}

			// Content-Type parity with real S3: when a presigned PUT URL is
			// minted with a contentType, the AWS SDK adds `content-type` to the
			// signed headers, so S3 returns 403 SignatureDoesNotMatch if the
			// uploaded request's Content-Type differs from (or omits) the signed
			// value. The mock used to ignore the request header entirely and
			// accept any upload, masking a failure that only surfaced in prod.
			// Enforce the same check here so a mismatch fails loudly in local dev.
			const requestContentType = req.headers['content-type'];
			if (valid.contentType !== undefined && requestContentType !== valid.contentType) {
				sendError(
					res,
					403,
					`SignatureDoesNotMatch: request Content-Type ${
						requestContentType === undefined ? '(missing)' : `"${requestContentType}"`
					} does not match the signed Content-Type "${valid.contentType}". ` +
						`Send the same Content-Type header that was used to create the upload URL.`,
				);
				return;
			}

			collectBody(req).then(async (body) => {
				// When a contentType was signed, it equals the (now validated)
				// request header. Otherwise fall back to whatever the request
				// sent, then octet-stream — matching S3's stored content type.
				const contentType = valid.contentType || requestContentType || 'application/octet-stream';
				await (bucket.put as (p: string, b: Buffer, o: { contentType: string }) => Promise<void>)(
					path, body, { contentType },
				);
				res.writeHead(200);
				res.end();
			}).catch((err) => {
				sendError(res, 500, err instanceof Error ? err.message : String(err));
			});
		} else {
			res.writeHead(405);
			res.end();
		}
	});
}
