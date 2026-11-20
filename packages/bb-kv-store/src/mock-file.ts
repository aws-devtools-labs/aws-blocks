// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The data file of the mock: `.cdk-blocks/local/data/{fullId}/store.json`.
 *
 * The file has a version, so that the loader can tell a file of an earlier
 * format from a damaged file:
 *
 * ```json
 * { "version": 2, "items": [{ "_bkv_pk": "a", "_bkv_value": "hello" }] }
 * ```
 *
 * Each entry of `items` is the exact DynamoDB item (see `item.ts`).
 *
 * The loader reads three formats:
 *
 * - Version 2, above. An entry that is not an item of the store (a corrupt
 *   entry) is left out. The loader keeps a copy of the file and reports it.
 * - Version 1, the `store.json` of `KVStore` before it took over
 *   `DistributedTable`: an object of key to JSON string, or of key to
 *   `{ value, ttl }`. It has no version field. The loader converts it, and
 *   first keeps a copy of the file as it was (`store.json.bak`). The store
 *   writes `store.json` again in the current format, and `LegacyKVStore` reads
 *   the items of release 0.4.0 from that copy.
 * - The `data.json` of `DistributedTable`: an array of `[serializedKey, item]`
 *   pairs. The loader reads it only when the directory has no `store.json`,
 *   and converts it.
 *
 * A conversion puts each entry through the layout of a write (`layoutItem`):
 * the key checks, the merge of the key into the value, and the layout checks.
 * It is all or nothing. A file in any other shape, or a file with an entry
 * that does not convert, is renamed to a `.bak` file and reported once at warn
 * level. The store then starts empty. The mock does not write over a file that
 * it cannot read.
 */
import { copyFileSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ChildLogger } from '@aws-cdk-blocks/bb-logger';
import { isPlainObject } from './errors.js';
import {
	compareByBaseKey,
	type Item,
	isStoredItem,
	itemExpired,
	type KeyModel,
	keyOfItem,
	layoutItem,
} from './item.js';
import { RELEASE_MODEL, RELEASE_PK, RELEASE_TTL, RELEASE_VALUE } from './legacy/layout.js';
import { nowEpochSeconds } from './ttl.js';

/** The name of the data file in the mock data directory of a store. */
const FILE_NAME = 'store.json';
/** The name of the data file that `DistributedTable` wrote. */
const TABLE_FILE_NAME = 'data.json';
/** The version that this code writes. Version 1 had no version field. */
const FILE_VERSION = 2;

/** What a data file holds, once it is read. */
interface FileContent {
	items: Item[];
	/** The number of entries of a version 2 file that are not items of the store. */
	dropped: number;
	/** Whether the items come from an earlier format. */
	converted: boolean;
}

/** The result of {@link loadMockFile}. */
export interface LoadedMockFile {
	/** The live items of the store. */
	items: Item[];
	/** Whether the caller must write the file again: the load converted an earlier format, or left entries out. */
	rewrite: boolean;
}

/**
 * Load the items of a store from its mock data directory. See the file comment
 * for the formats and for what happens to a file that cannot be read.
 */
export function loadMockFile(
	dir: string,
	model: KeyModel,
	log: Pick<ChildLogger, 'warn'>,
	context: Record<string, unknown>,
): LoadedMockFile {
	const storePath = join(dir, FILE_NAME);
	const tablePath = join(dir, TABLE_FILE_NAME);
	const hasStoreFile = existsSync(storePath);
	const source = hasStoreFile ? storePath : existsSync(tablePath) ? tablePath : undefined;
	if (source === undefined) return { items: [], rewrite: false };

	const content = readContent(source, hasStoreFile ? readStoreFile : readTableFile, model);
	if (!content) {
		const backup = backupPath(source);
		renameSync(source, backup);
		log.warn(
			`KVStore mock: the data file ${source} is not in a format that this version can read. ` +
				`It was renamed to ${backup}, and the store starts empty.`,
			context,
		);
		return { items: [], rewrite: false };
	}
	if (content.dropped > 0) {
		const backup = backupPath(source);
		copyFileSync(source, backup);
		log.warn(
			`KVStore mock: ${content.dropped} of the entries in the data file ${source} are not items of this store. ` +
				`The store left them out. ${backup} is a copy of the file as it was.`,
			context,
		);
	}
	if (hasStoreFile && content.converted) {
		// The caller writes `store.json` again, in the current format. Keep the
		// file of the release first (see `loadReleaseFile`).
		copyFileSync(source, backupPath(source));
	}
	// Drop an item whose expiry has passed, as DynamoDB does in the background.
	// Without this the file only grows, and every write rewrites the dead rows.
	const now = nowEpochSeconds();
	return {
		items: content.items.filter((item) => !itemExpired(model, item, now)),
		rewrite: content.converted || content.dropped > 0,
	};
}

/** Write the items of a store to its mock data directory, in the current format. */
export function saveMockFile(dir: string, items: Iterable<Item>): void {
	writeFileSync(join(dir, FILE_NAME), JSON.stringify({ version: FILE_VERSION, items: [...items] }, null, 2));
}

/** Read and interpret a file. `undefined` when the file is not JSON or is not in a format that `read` knows. */
function readContent(
	path: string,
	read: (parsed: unknown, model: KeyModel) => FileContent | undefined,
	model: KeyModel,
): FileContent | undefined {
	try {
		return read(JSON.parse(readFileSync(path, 'utf8')), model);
	} catch {
		// Not JSON, or an entry of an earlier format that the layout of a write refuses.
		return undefined;
	}
}

/** Interpret a parsed `store.json`: the current format, or version 1. */
function readStoreFile(parsed: unknown, model: KeyModel): FileContent | undefined {
	if (!isPlainObject(parsed)) return undefined;
	if (parsed.version === FILE_VERSION && Array.isArray(parsed.items)) {
		const items = parsed.items.filter((entry): entry is Item => isStoredItem(model, entry));
		return { items, dropped: parsed.items.length - items.length, converted: false };
	}
	// Version 1: every entry is a JSON string, or `{ value, ttl }`. An entry of
	// any other shape throws, so a file that only looks like version 1 is not
	// converted in part.
	const items = Object.entries(parsed).map(([key, entry]) => {
		const { value, ttl } = versionOneEntry(entry);
		return layoutItem(model, key, JSON.parse(value), ttl);
	});
	return { items, dropped: 0, converted: true };
}

/** One entry of a version 1 file: the JSON text of the value, and the expiry in epoch seconds if it has one. */
function versionOneEntry(entry: unknown): { value: string; ttl: number | undefined } {
	if (typeof entry === 'string') return { value: entry, ttl: undefined };
	if (
		isPlainObject(entry) &&
		typeof entry.value === 'string' &&
		(entry.ttl === undefined || typeof entry.ttl === 'number') &&
		Object.keys(entry).every((name) => name === 'value' || name === 'ttl')
	) {
		return { value: entry.value, ttl: entry.ttl };
	}
	throw new Error('not an entry of a version 1 file');
}

/** Interpret a parsed `data.json` of `DistributedTable`: `[serializedKey, item]` pairs, for a store with a declared key. */
function readTableFile(parsed: unknown, model: KeyModel): FileContent | undefined {
	if (!Array.isArray(parsed) || !model.declared) return undefined;
	const items = parsed.map((pair) => {
		if (!Array.isArray(pair) || pair.length !== 2 || !isPlainObject(pair[1])) {
			throw new Error('not an entry of a table file');
		}
		const row = pair[1];
		return layoutItem(model, keyOfItem(model, row), row, undefined);
	});
	return { items, dropped: 0, converted: true };
}

/** A name for a file to set aside: `<path>.bak`, or `<path>.bak.2`, `.bak.3`, … when that name is taken. */
function backupPath(path: string): string {
	let name = `${path}.bak`;
	for (let n = 2; existsSync(name); n++) name = `${path}.bak.${n}`;
	return name;
}

// ── The data file of a release up to 0.4.0, for `LegacyKVStore` ─────────────

/**
 * Load the data file of a store of release 0.4.0 or earlier as the items of that
 * release, `{ pk, value: <JSON text>, ttl? }`, in key order.
 *
 * The file is `store.json`, if it is a version 1 file. If a `KVStore` of this
 * release loaded the directory first, with the old line of the app unchanged,
 * `store.json` is not that file any more. The loader converted it, or it could
 * not convert it and set it aside. In both cases the file of release 0.4.0 is a
 * copy, `store.json.bak`, and this function reads the copy. What that `KVStore`
 * wrote to the converted file is not read.
 *
 * An entry is read as release 0.4.0 reads it: a JSON string, or
 * `{ value, ttl }`. Any other entry is left out. Expired items stay, so
 * `includeExpired` works.
 *
 * This function does not write. When the directory holds a data file but no file
 * of release 0.4.0, it reports that once at warn level, and the store reads as
 * empty.
 */
export function loadReleaseFile(dir: string, log: Pick<ChildLogger, 'warn'>, context: Record<string, unknown>): Item[] {
	const candidates = releaseFileCandidates(dir);
	for (const path of candidates) {
		const items = readVersionOneFile(path);
		if (items) return items.sort((a, b) => compareByBaseKey(RELEASE_MODEL, a, b));
	}
	if (candidates.length > 0) {
		log.warn(
			`KVStore mock: ${candidates[0]} is not the data file of a KVStore release up to 0.4.0, and the directory holds no copy of one. ` +
				'LegacyKVStore reads the store as empty, and leaves the files as they are.',
			context,
		);
	}
	return [];
}

/** `store.json`, and then the files that a loader set aside (`store.json.bak`, `.bak.2`, …), oldest first. Only those that exist. */
function releaseFileCandidates(dir: string): string[] {
	const storePath = join(dir, FILE_NAME);
	const paths = existsSync(storePath) ? [storePath] : [];
	for (let n = 1; ; n++) {
		const backup = n === 1 ? `${storePath}.bak` : `${storePath}.bak.${n}`;
		if (!existsSync(backup)) return paths;
		paths.push(backup);
	}
}

/** The items of a version 1 file. `undefined` when the file is not JSON, is not an object, or is a current file. */
function readVersionOneFile(path: string): Item[] | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(path, 'utf8'));
	} catch {
		return undefined;
	}
	if (!isPlainObject(parsed) || (parsed.version === FILE_VERSION && Array.isArray(parsed.items))) return undefined;
	const items: Item[] = [];
	for (const [key, entry] of Object.entries(parsed)) {
		if (typeof entry === 'string') {
			items.push(releaseItem(key, entry, undefined));
		} else if (isPlainObject(entry) && typeof entry.value === 'string') {
			items.push(releaseItem(key, entry.value, typeof entry.ttl === 'number' ? entry.ttl : undefined));
		}
	}
	return items;
}

function releaseItem(key: string, value: string, ttl: number | undefined): Item {
	return ttl === undefined
		? { [RELEASE_PK]: key, [RELEASE_VALUE]: value }
		: { [RELEASE_PK]: key, [RELEASE_VALUE]: value, [RELEASE_TTL]: ttl };
}

/** Write the items of a release to the data file of the store, as a version 1 file: the format of that release. */
export function saveReleaseFile(dir: string, items: Iterable<Item>): void {
	const entries: Record<string, unknown> = {};
	for (const item of items) {
		const value = item[RELEASE_VALUE];
		entries[item[RELEASE_PK] as string] = RELEASE_TTL in item ? { value, ttl: item[RELEASE_TTL] } : value;
	}
	writeFileSync(join(dir, FILE_NAME), JSON.stringify(entries, null, 2));
}
