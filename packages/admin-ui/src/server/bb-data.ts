// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The local `.bb-data` read path for the data browser.
 *
 * A locally-run blocks app persists each store as a JSON file under
 * `<projectRoot>/.bb-data/<storeName>/`. That is the whole "database" in local
 * mode, so reading it is a file read plus a normalisation — no client, no
 * credentials, no network.
 *
 * THREE THINGS THIS MODULE IS SHAPED BY
 *
 * 1. `blockFullId` arrives from a URL PATH SEGMENT, so it is hostile input.
 *    It is rejected on shape before it ever reaches the filesystem, and every
 *    resolved path is checked for containment inside `.bb-data` AFTER
 *    `realpathSync`. The implementation we model on resolved lexically and
 *    checked `startsWith`, which stops `../../etc` but NOT a symlink inside
 *    `.bb-data` pointing out of the project — a symlink is invisible to a
 *    lexical check because the escape happens in the kernel, not in the string.
 *
 * 2. `readLocalData` NEVER THROWS. Every failure comes back as a populated
 *    `error` + `errorCode` with `source: 'unavailable'`, because a data browser
 *    that 500s on a malformed fixture file is useless exactly when you need it
 *    — the malformed file is usually the thing you opened the browser to look
 *    at. Note that the stores list survives an error: one unparseable store
 *    must not hide the block's other stores.
 *
 * 3. `totalRecordsExact` is `true` here, and it is EARNED rather than copied.
 *    See `ParsedStore.scanComplete`.
 */

import { readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, join, resolve, sep } from 'node:path';
import type { BlockKeySchema, DataRecord, DataStore } from '../contract/v1.js';
import { decodeCursor, encodeCursor, InvalidCursorError, resolvePageLimit } from './data-cursor.js';
import { keySchemaFields, resolveSerializedKey } from './pair-key.js';
import { isAncillaryStoreName, redactRecordValue, redactValue } from './redact.js';

/** The on-disk root a locally-run blocks app writes its stores into. */
const BB_DATA_DIRNAME = '.bb-data';

/**
 * Filename preference within a store directory. Different block kinds name
 * their file differently (`data.json` for table-shaped stores, `store.json`
 * for KV/session stores, `state.json` for auth state), and a store directory
 * can hold more than one — a lock file, a backup, a sibling index. Preferring
 * in this order keeps the browser deterministic instead of alphabetical-by-
 * accident.
 */
const PREFERRED_FILENAMES = ['data.json', 'store.json', 'state.json'] as const;

/**
 * The key-field name reported for the object-map format.
 *
 * An object map has exactly ONE conceptual key — the property name — so naming
 * it is truthful. It is deliberately the generic `'key'` and not `pk`: `pk`
 * would be a claim about a schema this module cannot see.
 */
const OBJECT_MAP_KEY_FIELD = 'key';

/** A store on disk. `dir`/`file` are server-side only — see `toPublicStore`. */
export interface LocalStore extends DataStore {
	dir: string;
	file: string;
}

export interface ReadLocalDataOptions {
	projectRoot: string;
	blockFullId: string;
	store?: string;
	cursor?: string;
	limit?: number;
	/**
	 * The block's declared key schema, when discovery resolved one.
	 *
	 * The pair format stores its key as a single serialized string
	 * (`'["u1","t9"]'`) whose field NAMES live in the block's source, not in the
	 * file — so without this the key column has no labels and `keyValues` cannot
	 * be filled in. Passing the discovered schema is what turns an opaque
	 * `["u1","t9"]` into a labelled `userId · todoId`, which is also what a later
	 * edit or delete needs to address the record by.
	 */
	keySchema?: BlockKeySchema;
}

export interface LocalDataPage {
	stores: DataStore[];
	activeStore?: string;
	keyFields: string[];
	records: DataRecord[];
	nextCursor?: string;
	totalRecords: number;
	totalRecordsExact: boolean;
	redacted: boolean;
	source: 'bb-data' | 'unavailable';
	error?: string;
	errorCode?: 'STORE_NOT_FOUND' | 'UNPARSEABLE' | 'BAD_CURSOR';
}

/**
 * Shape validation for a block id that arrived from a URL path segment.
 *
 * Rejects rather than sanitises: there is no legitimate `.bb-data` store name
 * containing a path separator, a `..`, or a NUL, so a value carrying one is a
 * traversal attempt or a bug, and either way silently rewriting it into
 * something that resolves would be worse than refusing it. This runs BEFORE
 * any filesystem call, so a hostile id never reaches a syscall at all.
 *
 * The `typeof` guard is not redundant despite the parameter type: this value
 * comes from an HTTP route, where a TypeScript type is a promise rather than a
 * fact.
 */
export function isSafeBlockFullId(blockFullId: string): boolean {
	if (typeof blockFullId !== 'string' || blockFullId.length === 0) return false;
	// NUL truncates the path in some syscalls, so a name containing one can
	// address a different file than it appears to.
	if (blockFullId.includes('\0')) return false;
	// Both separators, on every platform: a `\` is literal on POSIX but a
	// separator on Windows, and this check should not depend on where it runs.
	if (blockFullId.includes('/') || blockFullId.includes('\\')) return false;
	if (blockFullId.includes('..')) return false;
	if (isAbsolute(blockFullId)) return false;
	return true;
}

/** `realpathSync` or `undefined` — a broken symlink is simply not a store. */
function tryRealpath(path: string): string | undefined {
	try {
		return realpathSync(path);
	} catch {
		return undefined;
	}
}

/**
 * Resolves `path` and returns it only when it really lives inside `realRoot`.
 *
 * The `realpathSync` call is the point: it collapses symlinks, so a store
 * directory (or a store FILE) that is a symlink out of the project fails the
 * containment check that a lexically-resolved path would pass. `realRoot` must
 * itself already be a real path, otherwise every check fails on platforms
 * where the temp or home directory is reached through a symlink.
 */
function resolveContained(realRoot: string, path: string): string | undefined {
	const real = tryRealpath(path);
	if (real === undefined) return undefined;
	// Strict containment: the root itself is not a store.
	if (!real.startsWith(realRoot + sep)) return undefined;
	return real;
}

/** Server-side view stripped to the wire contract — absolute paths stay here. */
function toPublicStore(store: LocalStore): DataStore {
	return { id: store.id, label: store.label, kind: store.kind, ancillary: store.ancillary };
}

/** JSON files in a store directory, alphabetical. Symlinked files included, and later contained. */
function listJsonFilenames(dir: string): string[] {
	try {
		return readdirSync(dir, { withFileTypes: true })
			.filter((entry) => (entry.isFile() || entry.isSymbolicLink()) && entry.name.toLowerCase().endsWith('.json'))
			.map((entry) => entry.name)
			.sort((left, right) => left.localeCompare(right));
	} catch {
		return [];
	}
}

/** Describes one candidate directory, or `undefined` when it is not a usable store. */
function describeStore(realRoot: string, name: string): LocalStore | undefined {
	const dir = resolveContained(realRoot, join(realRoot, name));
	if (dir === undefined) return undefined;

	let isDirectory = false;
	try {
		isDirectory = statSync(dir).isDirectory();
	} catch {
		return undefined;
	}
	if (!isDirectory) return undefined;

	const filenames = listJsonFilenames(dir);
	// A directory with no JSON in it is not a store — it is a stray directory.
	if (filenames.length === 0) return undefined;

	const chosen = PREFERRED_FILENAMES.find((candidate) => filenames.includes(candidate)) ?? filenames[0];
	// The file gets the same containment treatment as the directory: a
	// `data.json` symlinked at /etc/passwd is still readable JSON.
	const file = resolveContained(realRoot, join(dir, chosen));
	if (file === undefined) return undefined;

	return {
		id: name,
		// Which file was read is provenance a reader needs when a store
		// directory holds several candidates.
		label: `${name} (${chosen})`,
		kind: 'bb-data-file',
		ancillary: isAncillaryStoreName(name),
		dir,
		file,
	};
}

/**
 * Ancillary last, then shorter name, then lexicographic.
 *
 * Ancillary stores (`-codes`, `-sessions`, `-tokens`, `-challenges`, `-cache`)
 * are usually EMPTY at rest — a one-time code lives for minutes — so landing on
 * one first makes a perfectly populated block look broken to whoever opened the
 * browser. Shorter-name-next puts the block's own store (`<fullId>`) ahead of
 * its shards (`<fullId>-users`), which is the one a reader almost always wants.
 */
function sortStores(stores: LocalStore[]): LocalStore[] {
	return [...stores].sort((left, right) => {
		if (left.ancillary !== right.ancillary) return left.ancillary ? 1 : -1;
		if (left.id.length !== right.id.length) return left.id.length - right.id.length;
		return left.id.localeCompare(right.id);
	});
}

/**
 * Names in `.bb-data` that could be a store of this block.
 *
 * A block may SHARD across several directories: its own `<blockFullId>/` plus
 * any sibling whose name starts with `<blockFullId>-` (AuthBasic writes
 * `<fullId>-users` and `<fullId>-codes`). A symlinked entry is a candidate at
 * this stage; containment decides whether it survives.
 */
function readCandidateNames(realRoot: string, blockFullId: string): string[] {
	try {
		return readdirSync(realRoot, { withFileTypes: true })
			.filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
			.filter((entry) => entry.name === blockFullId || entry.name.startsWith(`${blockFullId}-`))
			.map((entry) => entry.name);
	} catch {
		return [];
	}
}

/**
 * Every store a block writes to, in reading order.
 *
 * Returns `[]` for a hostile id, a missing `.bb-data`, or a block that has
 * never written anything.
 */
export function listLocalStores(projectRoot: string, blockFullId: string): LocalStore[] {
	if (!isSafeBlockFullId(blockFullId)) return [];

	// Resolve the root through symlinks ONCE and compare candidates against
	// that, so a project reached via a symlinked path still matches.
	const realRoot = tryRealpath(resolve(projectRoot, BB_DATA_DIRNAME));
	if (realRoot === undefined) return [];

	const stores: LocalStore[] = [];
	for (const name of readCandidateNames(realRoot, blockFullId)) {
		const store = describeStore(realRoot, name);
		if (store !== undefined) stores.push(store);
	}
	return sortStores(stores);
}

/** A normalised record before redaction. `redacted` is deliberately absent here — see `readLocalData`. */
interface RawRecord {
	key: string;
	keyValues?: Record<string, string>;
	value: unknown;
	/** Set only when the display unwrap changed the value — see `unwrapForDisplay`. */
	valueAsStored?: unknown;
	/**
	 * True when `key` is a property NAME from the store's own shape rather than
	 * a data value.
	 *
	 * Only the object-map format qualifies. It matters because flattening an
	 * object into one record per property moves the field name out of the value,
	 * where the name-based half of redaction can no longer see it — so
	 * `{ sessionSecret: 's3cr3t' }` would come back in clear. The pair format's
	 * key is the opposite case: `'["u1","t9"]'` is user DATA, and masking on it
	 * would blank real records whose ids happen to contain a word like `token`.
	 */
	keyIsFieldName?: boolean;
}

interface ParsedStore {
	records: RawRecord[];
	keyFields: string[];
	/**
	 * True when `records` is the store's COMPLETE population.
	 *
	 * This is what `totalRecordsExact` is derived from, and the local path is
	 * the one path that can honestly set it: we `JSON.parse` the entire file
	 * and normalise every element before slicing a page, so `records.length`
	 * is the count itself and not a sample of it. The cloud paths cannot —
	 * a DynamoDB `Scan` returns one page plus a `LastEvaluatedKey`, so their
	 * total is a lower bound. Any future truncating read here must set this
	 * `false` rather than leave a `true` literal behind at the call site.
	 */
	scanComplete: boolean;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPairEntry(value: unknown): value is [string, unknown] {
	return Array.isArray(value) && value.length === 2 && typeof value[0] === 'string';
}

/** The `[serializedKey, item][]` format — every element must be a pair, or it is not this format. */
function isPairArray(value: unknown): value is [string, unknown][] {
	return Array.isArray(value) && value.length > 0 && value.every(isPairEntry);
}

/**
 * Unwraps ONE level of JSON-in-string.
 *
 * Blocks routinely persist a nested object as a serialized string, which
 * renders in the browser as an unreadable escaped blob. Parsing it back is a
 * DISPLAY CONVENIENCE only, and deliberately ONE LEVEL DEEP: the parsed result
 * is not re-scanned, so a doubly-encoded field stays a string. Recursing would
 * make the depth of the rendered tree depend on how many times a value happened
 * to be stringified, and would turn any string that merely looks like JSON into
 * a structure the store does not actually contain. Parse failure falls back to
 * the raw string.
 */
function unwrapJsonString(value: string): unknown {
	const trimmed = value.trim();
	if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return value;
	try {
		return JSON.parse(trimmed);
	} catch {
		return value;
	}
}

/**
 * Applies the display unwrap and reports whether it changed anything.
 *
 * The "changed" half is the point. The unwrap exists so a field Blocks persisted
 * as a serialized string renders as a tree, but the record editor seeds its
 * textarea from what it is shown and the writer persists what it is handed — so
 * without carrying the original, saving any edit to such a record rewrote that
 * field from a string to an object on disk. Returning both lets the display stay
 * readable while an edit still starts from what is actually stored.
 */
function unwrapForDisplay(item: unknown): { value: unknown; valueAsStored?: unknown } {
	const unwrapped = unwrapJsonStringFields(item);
	// Reference equality is enough: `unwrapJsonStringFields` returns the input
	// itself when it is not a plain object, and otherwise always a new object —
	// so compare the serialised forms to know whether a field actually moved.
	if (unwrapped === item) return { value: item };
	const changed = JSON.stringify(unwrapped) !== JSON.stringify(item);
	return changed ? { value: unwrapped, valueAsStored: item } : { value: unwrapped };
}

/** Applies the one-level unwrap to an object's own string fields. Returns a new object. */
function unwrapJsonStringFields(value: unknown): unknown {
	if (!isPlainObject(value)) return value;
	const result: Record<string, unknown> = {};
	for (const [field, entry] of Object.entries(value)) {
		result[field] = typeof entry === 'string' ? unwrapJsonString(entry) : entry;
	}
	return result;
}

/**
 * Normalises the three on-disk shapes into records.
 *
 * `keyFields` stays `[]` for the pair format: the key is a single serialized
 * string (`'["u1","t9"]'`) whose field NAMES live in the block's key schema,
 * which this module cannot see. Inventing `pk`/`sk` would put a fabricated
 * schema in front of a reader, and `keyValues` is likewise populated only where
 * it can be filled in truthfully.
 */
function normaliseStoreContent(parsed: unknown, keySchema?: BlockKeySchema): ParsedStore {
	// 1. Array of [serializedKey, item] pairs — DistributedTable / KVStore `data.json`.
	if (isPairArray(parsed)) {
		const keyFields = keySchemaFields(keySchema);
		return {
			records: parsed.map(([key, item]) => {
				const record: RawRecord = { key, ...unwrapForDisplay(item) };
				const keyValues = resolveSerializedKey(key, keyFields);
				if (keyValues !== undefined) record.keyValues = keyValues;
				return record;
			}),
			keyFields,
			scanComplete: true,
		};
	}

	// 2. Plain object map — Session/KV `store.json`, Auth `state.json`.
	if (isPlainObject(parsed)) {
		return {
			records: Object.entries(parsed).map(([key, item]) => ({
				key,
				keyValues: { [OBJECT_MAP_KEY_FIELD]: key },
				...unwrapForDisplay(item),
				keyIsFieldName: true,
			})),
			keyFields: [OBJECT_MAP_KEY_FIELD],
			scanComplete: true,
		};
	}

	// 3a. Any other array (elements that are not pairs) — keyed by index.
	if (Array.isArray(parsed)) {
		return {
			records: parsed.map((item, index) => ({ key: String(index), ...unwrapForDisplay(item) })),
			keyFields: [],
			scanComplete: true,
		};
	}

	// 3b. A scalar (or null) — one record so the value is at least visible.
	return { records: [{ key: 'value', value: parsed }], keyFields: [], scanComplete: true };
}

/**
 * An error page. `totalRecordsExact` is `false` here because we never got a
 * count: the `0` is a placeholder, and claiming it is exact would make the flag
 * mean "the number is a fact" in one branch and "the number is a guess" in
 * another.
 */
function unavailablePage(
	stores: DataStore[],
	activeStore: string | undefined,
	error: string,
	errorCode: LocalDataPage['errorCode'],
): LocalDataPage {
	return {
		stores,
		activeStore,
		keyFields: [],
		records: [],
		totalRecords: 0,
		totalRecordsExact: false,
		redacted: false,
		source: 'unavailable',
		error,
		errorCode,
	};
}

/**
 * No stores exist. This is the normal state of a project that has not run
 * locally yet, not a caller error, so it carries no `errorCode` — `STORE_NOT_FOUND`
 * is reserved for a caller asking for a store that is not in the list, which is
 * a genuinely different thing to report. `exact` distinguishes "we enumerated
 * and there is nothing" from "we refused to look".
 */
function emptyPage(error: string, exact: boolean): LocalDataPage {
	return {
		stores: [],
		keyFields: [],
		records: [],
		totalRecords: 0,
		totalRecordsExact: exact,
		redacted: false,
		source: 'unavailable',
		error,
	};
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * Reads one page of a block's local `.bb-data`.
 *
 * Never throws. Pagination is `{ kind: 'offset' }` cursors minted for the
 * active store, so a cursor presented after switching stores is rejected rather
 * than applied at a meaningless position.
 */
export function readLocalData(options: ReadLocalDataOptions): LocalDataPage {
	if (!isSafeBlockFullId(options.blockFullId)) {
		// The rejected value is NOT echoed back: it is unvalidated input that
		// may contain a NUL or a traversal, and repeating it into a message that
		// ends up in a UI or a log serves an attacker rather than a reader.
		return emptyPage('Block id is not a valid local store name.', false);
	}

	const stores = listLocalStores(options.projectRoot, options.blockFullId);
	if (stores.length === 0) {
		return emptyPage(`No local .bb-data store found for block "${options.blockFullId}".`, true);
	}
	const publicStores = stores.map(toPublicStore);

	// Store selection. An unknown requested store is an ERROR, never a silent
	// fallback: serving a different store's contents under the id the caller
	// asked for is worse than refusing, because the reader cannot tell.
	let active: LocalStore;
	if (options.store !== undefined && options.store !== '') {
		const requested = stores.find((store) => store.id === options.store);
		if (requested === undefined) {
			return unavailablePage(
				publicStores,
				undefined,
				`Store "${options.store}" is not a store of block "${options.blockFullId}".`,
				'STORE_NOT_FOUND',
			);
		}
		active = requested;
	} else {
		active = stores[0];
	}

	let offset = 0;
	if (options.cursor !== undefined && options.cursor !== '') {
		try {
			const cursor = decodeCursor(options.cursor, active.id);
			if (cursor.kind !== 'offset') {
				throw new InvalidCursorError(`A "${cursor.kind}" cursor cannot page a local .bb-data store.`);
			}
			offset = cursor.offset;
		} catch (error) {
			// Including a malformed cursor rather than restarting at 0: a silent
			// restart looks to the reader like the last page repeating forever.
			return unavailablePage(publicStores, active.id, messageOf(error), 'BAD_CURSOR');
		}
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(active.file, 'utf-8'));
	} catch (error) {
		return unavailablePage(
			publicStores,
			active.id,
			`Could not read ${active.label}: ${messageOf(error)}`,
			'UNPARSEABLE',
		);
	}

	const parsedStore = normaliseStoreContent(parsed, options.keySchema);
	const limit = resolvePageLimit(options.limit);
	const totalRecords = parsedStore.records.length;
	const slice = parsedStore.records.slice(offset, offset + limit);

	// Redaction: the flag on each record and on the page is what redaction
	// COMPUTED, never something set here. The reference hardcoded `redacted:
	// false` while applying no redaction at all, which made the flag a claim by
	// the caller instead of a fact about the data.
	//
	// The record KEY is fed in as well, but ONLY for the object-map format, where
	// it is a property name: flattening an object into one record per property
	// moves the field name out of the value, so `{ sessionSecret: 's3cr3t' }`
	// would otherwise come back in clear — its name no longer visible to the
	// name-based layer and its value too short for shape detection. A pair-format
	// key is user data, so it is deliberately NOT used this way.
	let redacted = false;
	const records: DataRecord[] = slice.map((raw) => {
		const outcome = raw.keyIsFieldName ? redactRecordValue(raw.key, raw.value) : redactValue(raw.value);
		if (outcome.redacted) redacted = true;
		const record: DataRecord = { key: raw.key, value: outcome.value, redacted: outcome.redacted };
		if (raw.keyValues !== undefined) record.keyValues = raw.keyValues;
		// Carried so an edit starts from what is on disk rather than from the
		// display form. Withheld when anything was masked: the as-stored value is
		// the UNREDACTED record, and handing it to the browser would undo the
		// redaction that had just been applied one line above.
		if (raw.valueAsStored !== undefined && !outcome.redacted) record.valueAsStored = raw.valueAsStored;
		return record;
	});

	// Advance by what was actually returned, so an offset past the end does not
	// mint a cursor pointing even further past it.
	const nextOffset = offset + slice.length;
	return {
		stores: publicStores,
		activeStore: active.id,
		keyFields: parsedStore.keyFields,
		records,
		nextCursor:
			nextOffset < totalRecords
				? encodeCursor({ kind: 'offset', store: active.id, offset: nextOffset })
				: undefined,
		totalRecords,
		totalRecordsExact: parsedStore.scanComplete,
		redacted,
		source: 'bb-data',
	};
}
