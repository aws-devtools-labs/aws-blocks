// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * On-disk layout for the FileBucket mock.
 *
 * Internal data (metadata, version history) is segregated into sibling roots
 * so it can never collide with user keys:
 *
 * ```
 * .bb-data/{fullId}/content/{key}                    file body (byte-identical)
 * .bb-data/{fullId}/meta/{key}.json                  sidecar metadata
 * .bb-data/{fullId}/versions/{key}/{versionId}       version body
 * .bb-data/{fullId}/versions/{key}/{versionId}.json  version metadata
 * .bb-data/{fullId}/versions/{key}/__deleted__       delete marker (sentinel)
 * .bb-data/{fullId}/version-counters/{sha256(key)}   highest version number issued
 * ```
 *
 * Because user content lives only under `content/`, `scan()` can yield every
 * file it finds with no marker-based filtering — a user key like
 * `data.__meta__.json` or `logs/__versions__/x` is stored verbatim and is
 * never confused with internal bookkeeping.
 *
 * Both the mock (`index.mock.ts`) and the dev file-server (`file-server.ts`)
 * import these helpers so the two stay in lockstep.
 */

import { createHash } from 'node:crypto';
import { join } from 'node:path';

/** Subdirectory holding file content, byte-identical to what was written. */
export const CONTENT_DIR = 'content';
/** Subdirectory holding sidecar metadata JSON. */
export const META_DIR = 'meta';
/** Subdirectory holding version history, one directory per key. */
export const VERSIONS_DIR = 'versions';
/** Sentinel filename marking a versioned key as deleted. */
export const DELETE_MARKER = '__deleted__';
/**
 * Flat directory of per-key version counters, each named by a hash of the key.
 * Kept out of `versions/{key}/` so no nested key (`a/x` beside `a`) can turn a
 * counter file into a directory or the other way round.
 */
const VERSION_COUNTERS_DIR = 'version-counters';
/** Suffix for version metadata sidecars (internal namespace only). */
const VERSION_META_SUFFIX = '.json';

/** Root directory under which all user content is stored. */
export function contentRoot(root: string): string {
	return join(root, CONTENT_DIR);
}

/** Absolute path to a file's content. */
export function contentPath(root: string, key: string): string {
	return join(root, CONTENT_DIR, key);
}

/** Absolute path to a file's sidecar metadata. */
export function metaPath(root: string, key: string): string {
	return join(root, META_DIR, key + '.json');
}

/** Directory holding all versions of a single key. */
export function versionsDirFor(root: string, key: string): string {
	return join(root, VERSIONS_DIR, key);
}

/** Absolute path to a specific version's body. */
export function versionContentPath(root: string, key: string, versionId: string): string {
	return join(root, VERSIONS_DIR, key, versionId);
}

/** Absolute path to a specific version's metadata sidecar. */
export function versionMetaPath(root: string, key: string, versionId: string): string {
	return join(root, VERSIONS_DIR, key, versionId + VERSION_META_SUFFIX);
}

/** Absolute path to a key's delete-marker sentinel. */
export function deleteMarkerPath(root: string, key: string): string {
	return join(root, VERSIONS_DIR, key, DELETE_MARKER);
}

/** Absolute path to the file recording the highest version number issued for a key. */
export function lastVersionPath(root: string, key: string): string {
	return join(root, VERSION_COUNTERS_DIR, createHash('sha256').update(key).digest('hex'));
}

/** True if a versions-directory entry is a real version body (not metadata or a sentinel). */
export function isVersionEntry(entry: string): boolean {
	return entry !== DELETE_MARKER && !entry.endsWith(VERSION_META_SUFFIX);
}
