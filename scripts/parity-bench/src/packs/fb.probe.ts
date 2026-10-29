// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// FileBucket (bb-file-bucket) parity runner for fb.cases.ts.

import { createHash, randomUUID } from 'node:crypto';
import { FileBucket } from '@aws-blocks/blocks';
import type { Scope } from '@aws-blocks/blocks';
import { describeError, param, runCase } from '../server/helpers.js';
import { trackBlock } from '../server/track.js';
import type { ProbeRunner } from '../core/types.js';

// Keys that should round-trip byte-for-byte on S3. Each is appended to the
// per-run prefix, so none starts with `/` or holds an empty or `.`/`..` segment.
const SPECIAL_KEY_NAMES = [
	'with space.txt',
	'two  spaces',
	'plus+sign',
	'percent%41literal',
	'question?mark',
	'hash#tag',
	'amp&eq=1',
	'colon:semi;',
	'back\\slash',
	'quote"apos\'',
	'lt<gt>',
	'brackets[]{}',
	'caret^pipe|tick`',
	'tilde~',
	'trailing-dot.',
	'..leading-dots',
	'emoji-😀-naïve-日本',
] as const;

// Deliberately scrambled; S3 returns them in UTF-8 byte order. No two differ
// only by case, so a case-insensitive filesystem can't merge them.
const SCAN_ORDER_NAMES = ['é', 'b2', 'A0/z', '~t', 'a/b', '_x', 'B1', 'a-c'] as const;

const KEY_PAIRS: Record<string, readonly [string, string]> = {
	case: ['Readme.txt', 'README.txt'],
	'nfc-nfd': ['caf\u00e9', 'cafe\u0301'],
	'object-then-child': ['node', 'node/child'],
	'child-then-object': ['node/child', 'node'],
};

const BULK_CONCURRENCY = 32;

/** Build a key of exactly `totalBytes` UTF-8 bytes: `prefix`, then `unit` repeated, a `/` every `perSegment` units. */
function keyOfBytes(prefix: string, totalBytes: number, unit: string, perSegment: number): string {
	const unitBytes = Buffer.byteLength(unit);
	let key = prefix;
	let inSegment = 0;
	for (;;) {
		const used = Buffer.byteLength(key);
		if (inSegment === perSegment) {
			if (used + 1 + unitBytes > totalBytes) break;
			key += '/';
			inSegment = 0;
		} else if (used + unitBytes <= totalBytes) {
			key += unit;
			inSegment++;
		} else {
			break;
		}
	}
	while (Buffer.byteLength(key) < totalBytes) key += 'a';
	return key;
}

async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
	const out: T[] = [];
	for await (const x of it) out.push(x);
	return out;
}

async function pool<T>(items: readonly T[], width: number, fn: (item: T) => Promise<void>): Promise<void> {
	let next = 0;
	const worker = async () => {
		while (next < items.length) await fn(items[next++]);
	};
	await Promise.all(Array.from({ length: Math.min(width, items.length) }, worker));
}

/** HTTP status of a presigned URL, fetched from inside the runner. The body is drained, never returned. */
async function fetchStatus(url: string, init?: RequestInit): Promise<number> {
	const res = await fetch(url, init);
	await res.arrayBuffer();
	return res.status;
}

/** A `Blob` with no type, so `fetch` sends no `Content-Type` header. */
function untypedBody(bytes: number): Blob {
	return new Blob(['x'.repeat(bytes)]);
}

function sha256(b: Uint8Array): string {
	return createHash('sha256').update(b).digest('hex');
}

/** Constructs two buckets of its own: `pty-fb` (unversioned) and `pty-fbv` (versioned, the default). */
export function fbProbe(scope: Scope): ProbeRunner {
	const bucket = trackBlock(new FileBucket(scope, 'pty-fb', { versioned: false, removalPolicy: 'destroy' }));
	const versioned = trackBlock(new FileBucket(scope, 'pty-fbv', { removalPolicy: 'destroy' }));

	/** Remove everything under `prefix` from the unversioned bucket, plus `known` keys a buggy scan could miss. */
	async function purge(prefix: string, known: readonly string[] = []): Promise<void> {
		const listed = (await collect(bucket.scan({ prefix }))).map((f) => f.path);
		const keys = [...new Set([...listed, ...known])];
		if (keys.length > 0) await bucket.deleteBatch(keys);
	}

	/** Permanently delete every version under `prefix` in the versioned bucket. */
	async function purgeVersioned(prefix: string): Promise<void> {
		for (const f of await collect(versioned.scan({ prefix }))) {
			for (const v of await versioned.listVersions(f.path)) await versioned.delete(f.path, { versionId: v.versionId });
		}
		// The mock keeps a key's current body after all its versions are deleted (that is
		// what fb.versioning.delete.current-version-id observes); hide it so the next run
		// starts clean. On S3 nothing is listed here, so no delete marker is created.
		for (const f of await collect(versioned.scan({ prefix }))) await versioned.delete(f.path);
	}

	return (c) => {
		const kind = param(c.params, 'kind', 'string');
		const prefix = `pty/${randomUUID().slice(0, 8)}/`;
		const cleanup = () => purge(prefix);

		switch (kind) {
			case 'key-length': {
				const entry = param(c.params, 'entry', 'string');
				const bytes = param(c.params, 'bytes', 'number');
				const unit = param(c.params, 'unit', 'string');
				const key = keyOfBytes(prefix, bytes, unit, unit === 'a' ? 99 : 60);
				const shape = { keyBytes: Buffer.byteLength(key), keyChars: [...key].length };
				return runCase({
					setup: async () => undefined,
					act: async () => {
						switch (entry) {
							case 'put':
								await bucket.put(key, 'x');
								return { ...shape, stored: (await bucket.get(key)) !== null };
							case 'putUrl-upload':
								return { ...shape, status: await fetchStatus(await bucket.putUrl(key), { method: 'PUT', body: untypedBody(1) }) };
							case 'get':
								return { ...shape, found: (await bucket.get(key)) !== null };
							case 'getUrl-fetch':
								return { ...shape, status: await fetchStatus(await bucket.getUrl(key)) };
							case 'delete':
								await bucket.delete(key);
								return { ...shape, deleted: true };
							case 'deleteBatch':
								await bucket.deleteBatch([key]);
								return { ...shape, deleted: true };
							case 'scan':
								return { ...shape, count: (await collect(bucket.scan({ prefix: key }))).length };
							case 'listVersions':
								return { ...shape, count: (await versioned.listVersions(key)).length };
							default:
								throw new Error(`unknown fb key-length entry ${entry}`);
						}
					},
					cleanup: async () => {
						await purge(prefix);
						await purgeVersioned(prefix);
					},
				});
			}

			case 'key-segment': {
				const key = prefix + 'a'.repeat(param(c.params, 'bytes', 'number'));
				return runCase({
					setup: async () => undefined,
					act: async () => {
						await bucket.put(key, 'x');
						return { keyBytes: Buffer.byteLength(key), stored: (await bucket.get(key)) !== null };
					},
					cleanup,
				});
			}

			case 'metadata-size': {
				const bytes = param(c.params, 'bytes', 'number');
				const key = `${prefix}meta`;
				// One entry; the size S3 counts is key bytes + value bytes.
				const metadata = { probe: 'v'.repeat(bytes - 'probe'.length) };
				return runCase({
					setup: async () => undefined,
					act: async () => {
						await bucket.put(key, 'x', { metadata });
						const got = await bucket.get(key);
						const returned = Object.entries(got?.metadata ?? {});
						return {
							stored: got !== null,
							returnedBytes: returned.reduce((n, [k, v]) => n + Buffer.byteLength(k) + Buffer.byteLength(v), 0),
						};
					},
					cleanup,
				});
			}

			case 'metadata-key-case': {
				const key = `${prefix}meta`;
				return runCase({
					setup: async () => undefined,
					act: async () => {
						await bucket.put(key, 'x', { metadata: { 'Mixed-Case': 'v' } });
						return { keys: Object.keys((await bucket.get(key))?.metadata ?? {}) };
					},
					cleanup,
				});
			}

			case 'metadata-non-ascii': {
				const key = `${prefix}meta`;
				const value = 'café-日本';
				return runCase({
					setup: async () => undefined,
					act: async () => {
						await bucket.put(key, 'x', { metadata: { note: value } });
						const returned = (await bucket.get(key))?.metadata.note;
						return { roundTrip: returned === value, returnedChars: returned === undefined ? null : [...returned].length };
					},
					cleanup,
				});
			}

			case 'content-type-default': {
				const entry = param(c.params, 'entry', 'string');
				const key = `${prefix}ct`;
				return runCase({
					setup: async () => undefined,
					act: async () => {
						let status: number | null = null;
						if (entry === 'put') await bucket.put(key, Buffer.from([1, 2, 3]));
						else status = await fetchStatus(await bucket.putUrl(key), { method: 'PUT', body: untypedBody(3) });
						return { status, contentType: (await bucket.get(key))?.contentType ?? null };
					},
					cleanup,
				});
			}

			case 'body-size': {
				const bytes = param(c.params, 'bytes', 'number');
				const key = `${prefix}body`;
				return runCase({
					setup: async () => {
						const body = Buffer.alloc(bytes);
						for (let i = 0; i < bytes; i++) body[i] = i & 0xff;
						return body;
					},
					act: async (body) => {
						await bucket.put(key, body);
						const got = await bucket.get(key);
						const listed = await collect(bucket.scan({ prefix: key }));
						return {
							size: got?.size ?? null,
							bodyLength: got?.body.length ?? null,
							sha256Match: got !== null && sha256(got.body) === sha256(body),
							scanSize: listed[0]?.size ?? null,
						};
					},
					cleanup,
				});
			}

			case 'presign-expiry': {
				const entry = param(c.params, 'entry', 'string');
				const expiresIn = param(c.params, 'expiresIn', 'number');
				const doFetch = param(c.params, 'fetch', 'boolean');
				const key = `${prefix}obj`;
				return runCase({
					setup: () => bucket.put(key, 'x'),
					act: async () => {
						const url = entry === 'getUrl' ? await bucket.getUrl(key, { expiresIn }) : await bucket.putUrl(key, { expiresIn });
						if (!doFetch) return { issued: true };
						return { issued: true, status: await fetchStatus(url) };
					},
					cleanup,
				});
			}

			case 'presign-missing':
				return runCase({
					setup: async () => undefined,
					act: async () => ({ status: await fetchStatus(await bucket.getUrl(`${prefix}missing`)) }),
					cleanup,
				});

			case 'presign-headers': {
				const key = `${prefix}page.html`;
				return runCase({
					setup: () => bucket.put(key, '<p>x</p>', { contentType: 'text/html', cacheControl: 'max-age=60' }),
					act: async () => {
						const res = await fetch(await bucket.getUrl(key));
						await res.arrayBuffer();
						return {
							status: res.status,
							contentType: res.headers.get('content-type'),
							cacheControl: res.headers.get('cache-control'),
							contentDisposition: res.headers.get('content-disposition'),
							contentTypeOptions: res.headers.get('x-content-type-options'),
						};
					},
					cleanup,
				});
			}

			case 'key-chars': {
				const doFetch = param(c.params, 'fetch', 'boolean');
				const keys = SPECIAL_KEY_NAMES.map((n) => prefix + n);
				return runCase({
					setup: async () => {
						const putFailed: Record<string, string> = {};
						for (const [i, key] of keys.entries()) {
							try {
								await bucket.put(key, SPECIAL_KEY_NAMES[i]);
							} catch (e) {
								putFailed[SPECIAL_KEY_NAMES[i]] = describeError(e).name;
							}
						}
						return putFailed;
					},
					act: async (putFailed) => {
						if (doFetch) {
							const notOk: Record<string, string | number> = {};
							for (const [i, key] of keys.entries()) {
								const name = SPECIAL_KEY_NAMES[i];
								try {
									const res = await fetch(await bucket.getUrl(key));
									const size = (await res.arrayBuffer()).byteLength;
									if (res.status !== 200) notOk[name] = res.status;
									else if (size !== Buffer.byteLength(name)) notOk[name] = `size ${size}`;
								} catch (e) {
									notOk[name] = describeError(e).name;
								}
							}
							return { putFailed, notOk };
						}
						const getMismatch: string[] = [];
						for (const [i, key] of keys.entries()) {
							const got = await bucket.get(key);
							if (got?.body.toString('utf8') !== SPECIAL_KEY_NAMES[i]) getMismatch.push(SPECIAL_KEY_NAMES[i]);
						}
						const listed = (await collect(bucket.scan({ prefix }))).map((f) => f.path.slice(prefix.length));
						const expected = new Set<string>(SPECIAL_KEY_NAMES);
						return {
							putFailed,
							getMismatch,
							scanCount: listed.length,
							scanMissing: SPECIAL_KEY_NAMES.filter((n) => !listed.includes(n)),
							scanUnexpected: listed.filter((n) => !expected.has(n)),
						};
					},
					cleanup: () => purge(prefix, keys),
				});
			}

			case 'key-pair': {
				const pair = KEY_PAIRS[param(c.params, 'pair', 'string')];
				if (!pair) throw new Error('unknown fb key pair');
				const [first, second] = pair.map((n) => prefix + n);
				return runCase({
					setup: async () => undefined,
					act: async () => {
						await bucket.put(first, 'A');
						await bucket.put(second, 'BB');
						return {
							objects: (await collect(bucket.scan({ prefix }))).length,
							firstSize: (await bucket.get(first))?.size ?? null,
							secondSize: (await bucket.get(second))?.size ?? null,
						};
					},
					cleanup: () => purge(prefix, [first, second]),
				});
			}

			case 'key-shapes': {
				const shapes: Record<string, string> = {
					'leading-slash': `/${prefix}x`,
					'double-slash': `${prefix}a//b`,
					'trailing-slash': `${prefix}trail/`,
					'dot-dot-segment': `${prefix}a/../b`,
					'dot-segment': `${prefix}./a`,
					'nul-byte': `${prefix}nul\u0000x`,
				};
				const entries: Record<string, (key: string) => Promise<unknown>> = {
					put: (k) => bucket.put(k, 'x'),
					get: (k) => bucket.get(k),
					getUrl: (k) => bucket.getUrl(k),
					putUrl: (k) => bucket.putUrl(k),
					delete: (k) => bucket.delete(k),
					deleteBatch: (k) => bucket.deleteBatch([k]),
					listVersions: (k) => versioned.listVersions(k),
					scan: (k) => collect(bucket.scan({ prefix: k })),
				};
				return runCase({
					setup: async () => undefined,
					act: async () => {
						const matrix: Record<string, Record<string, string>> = {};
						for (const [shape, key] of Object.entries(shapes)) {
							matrix[shape] = {};
							for (const [entry, call] of Object.entries(entries)) {
								try {
									await call(key);
									matrix[shape][entry] = 'ok';
								} catch (e) {
									matrix[shape][entry] = describeError(e).name;
								}
							}
						}
						return matrix;
					},
					cleanup,
				});
			}

			case 'scan-order':
				return runCase({
					setup: async () => {
						for (const n of SCAN_ORDER_NAMES) await bucket.put(prefix + n, 'x');
					},
					act: async () => {
						const order = (await collect(bucket.scan({ prefix }))).map((f) => f.path.slice(prefix.length));
						const byBytes = [...order].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
						return { order, utf8ByteOrder: order.every((n, i) => n === byBytes[i]) };
					},
					cleanup,
				});

			case 'bulk': {
				const count = param(c.params, 'count', 'number');
				const op = param(c.params, 'op', 'string');
				const keys = Array.from({ length: count }, (_, i) => `${prefix}${String(i).padStart(5, '0')}`);
				return runCase({
					setup: () => pool(keys, BULK_CONCURRENCY, (k) => bucket.put(k, '')),
					act: async () => {
						if (op === 'scan') {
							const listed = await collect(bucket.scan({ prefix }));
							return { listed: listed.length, distinct: new Set(listed.map((f) => f.path)).size };
						}
						await bucket.deleteBatch(keys);
						return { remaining: (await collect(bucket.scan({ prefix }))).length };
					},
					cleanup: () => purge(prefix, keys),
				});
			}

			case 'versions-unversioned': {
				const key = `${prefix}doc`;
				return runCase({
					setup: () => bucket.put(key, 'x'),
					act: async () => {
						const versions = await bucket.listVersions(key);
						return { count: versions.length, isCurrent: versions.map((v) => v.isCurrent) };
					},
					cleanup,
				});
			}

			case 'versions-delete-current': {
				const key = `${prefix}doc`;
				return runCase({
					setup: async () => {
						await versioned.put(key, 'one');
						await versioned.put(key, 'two');
					},
					act: async () => {
						const before = await versioned.listVersions(key);
						const current = before.find((v) => v.isCurrent);
						if (current) await versioned.delete(key, { versionId: current.versionId });
						const afterFirst = await versioned.get(key);
						const remaining = await versioned.listVersions(key);
						for (const v of remaining) await versioned.delete(key, { versionId: v.versionId });
						return {
							versionsBefore: before.length,
							hadCurrent: current !== undefined,
							afterDeletingCurrent: afterFirst?.body.toString('utf8') ?? null,
							versionsAfterFirstDelete: remaining.length,
							foundAfterDeletingAll: (await versioned.get(key)) !== null,
						};
					},
					cleanup: () => purgeVersioned(prefix),
				});
			}

			default:
				throw new Error(`unknown fb case kind ${kind}`);
		}
	};
}
