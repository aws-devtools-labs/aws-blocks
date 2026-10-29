// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// FileBucket (bb-file-bucket) parity cases. Pure data — executed by fb.probe.ts.

import type { ParityCase } from '../core/types.js';

const S3_KEYS = 'https://docs.aws.amazon.com/AmazonS3/latest/userguide/object-keys.html';
const S3_METADATA = 'https://docs.aws.amazon.com/AmazonS3/latest/userguide/UsingMetadata.html';
const S3_PRESIGN = 'https://docs.aws.amazon.com/AmazonS3/latest/userguide/using-presigned-url.html';
const S3_LIST = 'https://docs.aws.amazon.com/AmazonS3/latest/API/API_ListObjectsV2.html';
const S3_DELETE_OBJECTS = 'https://docs.aws.amazon.com/AmazonS3/latest/API/API_DeleteObjects.html';
const S3_VERSIONING = 'https://docs.aws.amazon.com/AmazonS3/latest/userguide/versioning-workflows.html';
const FB_DESIGN = 'packages/bb-file-bucket/DESIGN.md';

/** Every public entry point that takes an object key and so can hit the 1,024-byte key limit. */
export type FbKeyEntry = 'put' | 'putUrl-upload' | 'get' | 'getUrl-fetch' | 'delete' | 'deleteBatch' | 'scan' | 'listVersions';

const ENTRY_LABEL: Record<FbKeyEntry, string> = {
	put: 'put()',
	'putUrl-upload': 'putUrl() then an HTTP PUT to the URL from the runner',
	get: 'get() of a key that was never written',
	'getUrl-fetch': 'getUrl() then an HTTP GET of the URL from the runner',
	delete: 'delete()',
	deleteBatch: 'deleteBatch() with one key',
	scan: 'scan({ prefix }) with the key as prefix',
	listVersions: 'listVersions() on the versioned bucket',
};

function fbCase(c: Omit<ParityCase, 'pack' | 'block'>): ParityCase {
	return { pack: 'fb', block: 'bb-file-bucket', ...c };
}

const keyLengthCases: readonly ParityCase[] = [
	fbCase({
		id: 'fb.key-length.put.1024-bytes',
		category: 'limits',
		description: 'put() + get() a 1,024-byte ASCII key (exactly at the S3 limit), split into 100-byte segments',
		source: `${S3_KEYS} (key is UTF-8, maximum 1,024 bytes)`,
		params: { kind: 'key-length', entry: 'put', bytes: 1024, unit: 'a' },
	}),
	fbCase({
		id: 'fb.key-length.put.multibyte-1025-bytes',
		category: 'limits',
		description: 'put() a key of ~340 characters that is 1,025 UTF-8 bytes (3-byte CJK characters); the limit counts bytes, not characters',
		source: `${S3_KEYS} (1,024 bytes; "a single character may require 2 bytes")`,
		params: { kind: 'key-length', entry: 'put', bytes: 1025, unit: '日' },
	}),
	fbCase({
		id: 'fb.key-length.put.segment-300-bytes',
		category: 'limits',
		description: 'put() a key whose single path segment is 300 bytes (total well under 1,024); S3 has no per-segment limit, a filesystem has NAME_MAX 255',
		source: `${S3_KEYS} (only the 1,024-byte total applies; "there is no hierarchy")`,
		params: { kind: 'key-segment', bytes: 300 },
	}),
	...(['put', 'putUrl-upload', 'get', 'getUrl-fetch', 'delete', 'deleteBatch', 'scan', 'listVersions'] as const).map(
		(entry): ParityCase =>
			fbCase({
				id: `fb.key-length.${entry}.1025-bytes`,
				category: 'limits',
				description: `${ENTRY_LABEL[entry]} with a 1,025-byte ASCII key (one byte over the S3 limit)`,
				source: `${S3_KEYS} (maximum 1,024 bytes); ${FB_DESIGN} ("Key length validated ... (warns, does not reject)")`,
				params: { kind: 'key-length', entry, bytes: 1025, unit: 'a' },
			}),
	),
];

const metadataCases: readonly ParityCase[] = [
	...[2048, 2049].map(
		(bytes): ParityCase =>
			fbCase({
				id: `fb.metadata.put.${bytes}-bytes`,
				category: 'limits',
				description: `put() with user metadata totalling ${bytes} UTF-8 bytes (sum of key + value bytes)`,
				source: `${S3_METADATA} ("user-defined metadata is limited to 2 KB ... sum of the number of bytes in the UTF-8 encoding of each key and value")`,
				params: { kind: 'metadata-size', bytes },
			}),
	),
	fbCase({
		id: 'fb.metadata.put.key-case',
		category: 'consistency',
		description: 'put() with a mixed-case metadata key, then get(); which key spelling comes back',
		source: `${S3_METADATA} ("Amazon S3 stores user-defined metadata keys in lowercase")`,
		params: { kind: 'metadata-key-case' },
	}),
	fbCase({
		id: 'fb.metadata.put.non-ascii-value',
		category: 'errors',
		description: 'put() with a metadata value containing non-ASCII characters (é, 日本), then get(); does the value round-trip',
		source: `${S3_METADATA} ("conform to using US-ASCII characters when using REST"; non-ASCII values are RFC 2047 encoded)`,
		params: { kind: 'metadata-non-ascii' },
	}),
];

const bodyCases: readonly ParityCase[] = [
	fbCase({
		id: 'fb.content-type.put.default',
		category: 'consistency',
		description: 'put() a Buffer with no contentType, then get(); which Content-Type is stored',
		source: `${S3_METADATA} (Content-Type is user-controlled system metadata); README PutOptions.contentType`,
		params: { kind: 'content-type-default', entry: 'put' },
	}),
	fbCase({
		id: 'fb.content-type.putUrl-upload.default',
		category: 'consistency',
		description: 'putUrl() with no contentType, HTTP PUT without a Content-Type header, then get(); which Content-Type is stored',
		source: `${S3_PRESIGN}; ${FB_DESIGN} (dev file-server falls back to application/octet-stream "matching S3's stored content type")`,
		params: { kind: 'content-type-default', entry: 'putUrl-upload' },
	}),
	fbCase({
		id: 'fb.body.put.empty',
		category: 'consistency',
		description: 'put() a zero-byte body, then get() and scan(); reported sizes',
		source: S3_KEYS,
		params: { kind: 'body-size', bytes: 0 },
	}),
	fbCase({
		id: 'fb.body.put.6-mib',
		category: 'limits',
		description: 'put() a 6 MiB body generated server-side, then get(); size and SHA-256 match',
		source: `${FB_DESIGN} (D-FB-1 Buffer bodies; "No multipart upload" locally)`,
		params: { kind: 'body-size', bytes: 6 * 1024 * 1024 },
	}),
];

const presignCases: readonly ParityCase[] = [
	fbCase({
		id: 'fb.presign.getUrl.expires-604800',
		category: 'limits',
		description: 'getUrl() with expiresIn 604,800 s (7 days, the SigV4 maximum), then HTTP GET; status',
		source: `${S3_PRESIGN} ("Valid up to 7 days when you're using AWS Signature Version 4")`,
		params: { kind: 'presign-expiry', entry: 'getUrl', expiresIn: 604800, fetch: true },
	}),
	fbCase({
		id: 'fb.presign.getUrl.expires-604801',
		category: 'limits',
		description: 'getUrl() with expiresIn 604,801 s (one second over 7 days); is a URL issued',
		source: `${S3_PRESIGN} (SigV4 presigned URLs are valid up to 7 days)`,
		params: { kind: 'presign-expiry', entry: 'getUrl', expiresIn: 604801, fetch: false },
	}),
	fbCase({
		id: 'fb.presign.putUrl.expires-604801',
		category: 'limits',
		description: 'putUrl() with expiresIn 604,801 s (one second over 7 days); is a URL issued',
		source: `${S3_PRESIGN} (SigV4 presigned URLs are valid up to 7 days)`,
		params: { kind: 'presign-expiry', entry: 'putUrl', expiresIn: 604801, fetch: false },
	}),
	fbCase({
		id: 'fb.presign.getUrl.expires-0',
		category: 'limits',
		description: 'getUrl() with expiresIn 0, then an immediate HTTP GET; status',
		source: `${S3_PRESIGN} (expiration time); README GetUrlOptions.expiresIn`,
		params: { kind: 'presign-expiry', entry: 'getUrl', expiresIn: 0, fetch: true },
	}),
	fbCase({
		id: 'fb.presign.getUrl.missing-key',
		category: 'errors',
		description: 'getUrl() for a key that does not exist, then HTTP GET; status (404 needs s3:ListBucket, else 403)',
		source: `${S3_PRESIGN}; https://docs.aws.amazon.com/AmazonS3/latest/API/API_GetObject.html (NoSuchKey vs AccessDenied without s3:ListBucket)`,
		params: { kind: 'presign-missing' },
	}),
	fbCase({
		id: 'fb.presign.getUrl.response-headers',
		category: 'consistency',
		description: 'put() with contentType text/html and cacheControl, then HTTP GET of getUrl(); Content-Type, Cache-Control, Content-Disposition, X-Content-Type-Options',
		source: `${S3_METADATA} (Cache-Control is stored system metadata); ${FB_DESIGN} (dev server adds Content-Disposition: attachment + nosniff)`,
		params: { kind: 'presign-headers' },
	}),
];

const keyCharCases: readonly ParityCase[] = [
	fbCase({
		id: 'fb.key-chars.put-get-scan.special',
		category: 'consistency',
		description: 'put() 17 keys with spaces, + % ? # & = : ; \\ " < > emoji etc., then get() each and scan(); which keys fail to round-trip',
		source: `${S3_KEYS} ("You can use any UTF-8 character in an object key name"; characters that might require special handling)`,
		params: { kind: 'key-chars', fetch: false },
	}),
	fbCase({
		id: 'fb.key-chars.getUrl-fetch.special',
		category: 'consistency',
		description: 'put() the same special-character keys, then HTTP GET each getUrl(); which keys do not return 200 with the right size',
		source: `${S3_KEYS} (characters that "most likely must be URL encoded"); ${S3_PRESIGN}`,
		params: { kind: 'key-chars', fetch: true },
	}),
	fbCase({
		id: 'fb.key-chars.put.case-variants',
		category: 'consistency',
		description: 'put() Readme.txt and README.txt with different bodies, then scan() and get() both; are they two objects',
		source: `${S3_KEYS} ("Object key names are case sensitive")`,
		params: { kind: 'key-pair', pair: 'case' },
	}),
	fbCase({
		id: 'fb.key-chars.put.unicode-normalization',
		category: 'consistency',
		description: 'put() "café" in NFC (U+00E9) and NFD (e + U+0301) with different bodies; are they two objects',
		source: `${S3_KEYS} (key is a sequence of UTF-8 bytes; sorted by byte value)`,
		params: { kind: 'key-pair', pair: 'nfc-nfd' },
	}),
	fbCase({
		id: 'fb.key-chars.put.object-then-child',
		category: 'consistency',
		description: 'put() "node", then put() "node/child"; both exist in S3 (flat namespace)',
		source: `${S3_KEYS} ("The Amazon S3 data model is a flat structure ... There is no hierarchy")`,
		params: { kind: 'key-pair', pair: 'object-then-child' },
	}),
	fbCase({
		id: 'fb.key-chars.put.child-then-object',
		category: 'consistency',
		description: 'put() "node/child", then put() "node"; both exist in S3 (flat namespace)',
		source: `${S3_KEYS} ("The Amazon S3 data model is a flat structure ... There is no hierarchy")`,
		params: { kind: 'key-pair', pair: 'child-then-object' },
	}),
	fbCase({
		id: 'fb.key-chars.rejected-shapes.all-entries',
		category: 'errors',
		description: 'Leading /, a//b, trailing /, a/../b, ./a and a NUL byte on put, get, getUrl, putUrl, delete, deleteBatch, listVersions, scan; error name per entry point',
		source: `${S3_KEYS} (period-only segments, ".." rules); ${FB_DESIGN} ("assertValidKey ... called from every key-accepting method on both layers")`,
		params: { kind: 'key-shapes' },
	}),
];

const listCases: readonly ParityCase[] = [
	fbCase({
		id: 'fb.scan.order.utf8-bytes',
		category: 'consistency',
		description: 'put() 8 keys (B1, _x, a-c, a/b, b2, ~t, é, A0/z) in scrambled order, then scan(); returned order',
		source: `${S3_LIST} ("returns objects in lexicographical order"); ${S3_KEYS} (sorted "by their UTF-8 encoded byte values")`,
		params: { kind: 'scan-order' },
	}),
	fbCase({
		id: 'fb.scan.pagination.1001',
		category: 'limits',
		description: 'put() 1,001 objects under one prefix, then scan(); count (S3 pages at 1,000)',
		source: `${S3_LIST} ("Returns some or all (up to 1,000) of the objects")`,
		params: { kind: 'bulk', count: 1001, op: 'scan' },
	}),
	fbCase({
		id: 'fb.deleteBatch.1001',
		category: 'limits',
		description: 'put() 1,001 objects, deleteBatch() all of them, then scan(); remaining count (DeleteObjects caps at 1,000 keys)',
		source: `${S3_DELETE_OBJECTS} ("The request can contain a list of up to 1,000 keys"); ${FB_DESIGN} D-FB-3`,
		params: { kind: 'bulk', count: 1001, op: 'deleteBatch' },
	}),
];

const versioningCases: readonly ParityCase[] = [
	fbCase({
		id: 'fb.versioning.listVersions.unversioned-bucket',
		category: 'consistency',
		description: 'listVersions() on a versioned: false bucket after one put(); how many versions are reported',
		source: `${S3_VERSIONING} ("Each object has a version ID, whether or not S3 Versioning is enabled ... Amazon S3 sets the value of the version ID to null")`,
		params: { kind: 'versions-unversioned' },
	}),
	fbCase({
		id: 'fb.versioning.delete.current-version-id',
		category: 'consistency',
		description: 'put() v1 then v2, delete({ versionId }) of the current version, get(); then delete the other version, get()',
		source: `${S3_VERSIONING} ("If your DELETE operation specifies the versionId, that object version is permanently deleted"); https://docs.aws.amazon.com/AmazonS3/latest/API/API_DeleteObject.html`,
		params: { kind: 'versions-delete-current' },
	}),
];

/** FileBucket probes: S3 key, metadata, presign, listing and versioning edges, each on every entry point that can hit it. */
export const fbCases: readonly ParityCase[] = [
	...keyLengthCases,
	...metadataCases,
	...bodyCases,
	...presignCases,
	...keyCharCases,
	...listCases,
	...versioningCases,
];
