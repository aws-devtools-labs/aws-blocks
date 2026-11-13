// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The local `.bb-data` WRITE path: create, edit and delete one record.
 *
 * This is the mirror of `bb-data.ts`, and it deliberately borrows that module's
 * machinery rather than growing its own:
 *
 * 1. PATH SAFETY IS THE READER'S, VERBATIM. `blockFullId` still arrives from a
 *    URL path segment, so it is still hostile input — but a write is the one
 *    place a traversal escape actually damages something, so the write path must
 *    be at least as strict as the read path and never less. The cheapest way to
 *    guarantee "at least as strict" is to not have a second implementation:
 *    `isSafeBlockFullId` is called before any filesystem access, and every path
 *    we touch is one `listLocalStores` already resolved through `realpathSync`
 *    and checked for containment inside `.bb-data`. We never join a path from a
 *    caller-supplied string ourselves.
 *
 * 2. ONE KEY FORMAT, ONE OWNER. The on-disk key is
 *    `JSON.stringify([pkValue, skValue?])` in key order, and `pair-key.ts` owns
 *    that format outright — the field order, the encoder and the decoder the
 *    reader uses, together in one module. This file produces no key of its own,
 *    and every on-disk key it compares against goes through the same
 *    canonicaliser, so a hand-edited `["u1", "t1"]` and a numeric `["u1",9]`
 *    both match the record the browser displayed. A `KVStore` data file
 *    (`store.json`) has no serialized key: each item carries its key
 *    attributes, and `kv-store-file.ts` owns that layout in the same way. A
 *    record there is addressed by the same named key values.
 *
 * 3. NEVER REJECTS. Every outcome — success, refusal, malformed input — comes
 *    back as a `LocalWriteResult`. A write surface that throws makes the caller
 *    invent its own error wording for cases this module already knows how to
 *    describe.
 *
 * Writes are ATOMIC (temp file + `renameSync`). The implementation we model on
 * rewrote the store in place, which means an interruption part-way through
 * `writeFileSync` leaves a truncated file — and a truncated `.bb-data` store is
 * indistinguishable from an empty one, so the failure mode of "editing one
 * record" was "silently losing all of them".
 */

import { readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { BlockKeySchema, WriteMode } from '../contract/v1.js';
import { isSafeBlockFullId, listLocalStores, type LocalStore } from './bb-data.js';
import {
	indexOfKvItem,
	isKvStoreFile,
	isStringKeyed,
	KV_RESERVED_PREFIX,
	kvStoreFileOf,
	replaceKvItem,
	reservedFieldOf,
} from './kv-store-file.js';
import { canonicalizePairKey, serializePairKey } from './pair-key.js';
import type { detectLocalDevServer } from './detect.js';
import { detectLocalDevServer as detectLocalDevServerImpl } from './detect.js';
import { keyFieldsOf, keyOf, validateRecord } from './record-validate.js';

/**
 * The filenames we write.
 *
 * A store directory can hold `data.json`, `store.json` or `state.json`, and the
 * reader is happy with all three. Writing is narrower on purpose: only a format
 * with a key model to address a record BY can be written, and two have one. The
 * pair format keeps a serialized key next to each item, and `data.json` is the
 * file that carries it. The `KVStore` data file (`store.json`) keeps the key
 * attributes in each item, so it has a key model when the block declares its
 * key fields. See `UNSUPPORTED_STORE`.
 */
const PAIR_FILENAME = 'data.json';
const KV_STORE_FILENAME = 'store.json';

/** `.bb-data` is written with 2-space indentation; a diff of it should stay readable. */
const STORE_INDENT = 2;

export interface LocalWriteResult {
	ok: boolean;
	message: string;
	refusalCode?:
		| 'LOCAL_SERVER_RUNNING'
		| 'ALREADY_EXISTS'
		| 'NOT_FOUND'
		| 'VALIDATION_FAILED'
		| 'STORE_NOT_FOUND'
		| 'UNSUPPORTED_STORE';
}

export interface LocalWriteContext {
	projectRoot: string;
	blockFullId: string;
	store?: string;
	keySchema?: BlockKeySchema;
	/** Test seam; defaults to the real probe. */
	detectDevServer?: typeof detectLocalDevServer;
}

/** One `[serializedKey, item]` element of the pair format. */
type PairEntry = [string, unknown];

/** A store file opened for writing, plus the bytes we must put back unchanged. */
interface OpenStoreBase {
	store: LocalStore;
	/** Whether the file on disk ended with a newline, so a write does not add or drop one. */
	trailingNewline: boolean;
}

/** A pair-format `data.json`. */
interface OpenPairStore extends OpenStoreBase {
	format: 'pairs';
	pairs: PairEntry[];
}

/** A `KVStore` data file (`store.json`) of a store with declared key fields. */
interface OpenKvStore extends OpenStoreBase {
	format: 'kv-store';
	items: unknown[];
}

type OpenStore = OpenPairStore | OpenKvStore;

function ok(message: string): LocalWriteResult {
	return { ok: true, message };
}

function refuse(refusalCode: NonNullable<LocalWriteResult['refusalCode']>, message: string): LocalWriteResult {
	return { ok: false, message, refusalCode };
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * The dev-server refusal.
 *
 * This is GUIDANCE, not a failure: the user has done nothing wrong. The local
 * mock loads a store into memory once at dev-server start and flushes its whole
 * map back over the file on every write, so an edit made underneath a running
 * server diverges from what the server believes and is clobbered wholesale on
 * the mock's next flush. Refusing and naming the two ways forward is strictly
 * more useful than accepting a write that will silently disappear.
 *
 * This probe is inherently TOCTOU: a dev server started between the probe and
 * the `renameSync` below still clobbers the edit. We accept that knowingly. The
 * alternative is file locking against a process that does not participate in
 * any locking protocol, which buys us almost nothing — the mock would ignore
 * the lock and flush anyway — in exchange for a lock file to leak and a new
 * class of "store is stuck locked" bug.
 */
async function refuseWhenDevServerUp(context: LocalWriteContext): Promise<LocalWriteResult | undefined> {
	const probe = context.detectDevServer ?? detectLocalDevServerImpl;
	let status: Awaited<ReturnType<typeof detectLocalDevServerImpl>> | undefined;
	let serverUp = false;
	try {
		status = await probe(context.projectRoot);
		serverUp = status.serverUp;
	} catch {
		// The real probe cannot throw — it reports a stopped server as data. A
		// throwing seam is a caller bug, and treating "could not tell" as "up"
		// would make a broken probe look like a running server, which is a worse
		// lie than the TOCTOU window we already accept.
		serverUp = false;
	}
	// A dev server whose port the probe could not determine answers "not
	// running" on the wrong port. Writing then races the running app's in-memory
	// store, which flushes over the edit on its next write — silently. So the
	// write is refused rather than the probe's answer being trusted.
	if (!serverUp && status?.portSource === 'indeterminate') {
		return refuse(
			'LOCAL_SERVER_RUNNING',
			`Could not determine the local dev server's port: aws-blocks/scripts/server.ts states no literal ` +
				`port, so a server on a computed port (for example \`Number(process.env.PORT) || 3001\`) cannot be ` +
				`ruled out. A write now could be overwritten by the running app. Stop the dev server, or make the ` +
				'change through the RPC playground, then retry.',
		);
	}
	if (!serverUp) return undefined;
	return refuse(
		'LOCAL_SERVER_RUNNING',
		'The local Blocks dev server is running and holds this store in memory, so an edit to the file ' +
			'would be overwritten on its next write. Stop the dev server, or make the change through the ' +
			'RPC playground, then retry.',
	);
}

/** Index of the record addressed by `target`, or `-1`. */
function indexOfKey(pairs: PairEntry[], target: string, keyFields: string[]): number {
	return pairs.findIndex(([key]) => canonicalizePairKey(key, keyFields) === target);
}

function isPairEntry(value: unknown): value is PairEntry {
	return Array.isArray(value) && value.length === 2 && typeof value[0] === 'string';
}

/** Index of the record addressed by `key` (pair format) or by `keyValues` (`KVStore` data file), or `-1`. */
function indexOfRecord(opened: OpenStore, key: string, keyValues: Record<string, string>, keyFields: string[]): number {
	return opened.format === 'pairs'
		? indexOfKey(opened.pairs, key, keyFields)
		: indexOfKvItem(opened.items, keyValues, keyFields);
}

/** What goes back on disk for an opened store. */
function contentOf(opened: OpenStore): unknown {
	return opened.format === 'pairs' ? opened.pairs : kvStoreFileOf(opened.items);
}

/**
 * Resolves and reads the store to write, or the refusal that stops us.
 *
 * Store selection mirrors the reader: a named store must exist (never a silent
 * fallback to a different one), and with no name the reader's first store wins,
 * so "the store the browser was showing" is the store that gets written.
 */
function openStore(context: LocalWriteContext): OpenStore | LocalWriteResult {
	const stores = listLocalStores(context.projectRoot, context.blockFullId);
	if (stores.length === 0) {
		return refuse('STORE_NOT_FOUND', `No local .bb-data store found for block "${context.blockFullId}".`);
	}

	let store: LocalStore;
	if (context.store !== undefined && context.store !== '') {
		const requested = stores.find((candidate) => candidate.id === context.store);
		if (requested === undefined) {
			return refuse(
				'STORE_NOT_FOUND',
				`Store "${context.store}" is not a store of block "${context.blockFullId}".`,
			);
		}
		store = requested;
	} else {
		// With no store named, write ONLY the block's own store. The candidate list
		// also holds siblings whose name starts with `<fullId>-`, which is how a
		// block's composed child stores are found (AuthBasic writes `<fullId>-users`).
		// A separately DECLARED block can carry that shape too: with tables `orders`
		// and `orders-archive`, the archive matches `orders-`, and while `orders` had
		// no data it became the first candidate, so a dashboard edit on `orders`
		// landed in the archive table's file. Taking `stores[0]` cannot tell a child
		// store from another block; the block's own id can.
		const own = stores.find((candidate) => candidate.id === context.blockFullId);
		if (own === undefined) {
			return refuse(
				'STORE_NOT_FOUND',
				`Block "${context.blockFullId}" has no store of its own in .bb-data yet, so there is nothing ` +
					`to write without naming a store. Name one of: ${stores.map((candidate) => `"${candidate.id}"`).join(', ')}.`,
			);
		}
		store = own;
	}

	// `store.file` is already realpath-resolved and containment-checked by the
	// reader, so this reports the file we would actually open rather than the
	// name we hoped it was.
	const filename = basename(store.file);
	if (filename !== PAIR_FILENAME && filename !== KV_STORE_FILENAME) {
		return refuse(
			'UNSUPPORTED_STORE',
			`Store "${store.id}" is backed by ${filename}, which has no key model to address a record by. ` +
				`Only a pair-format ${PAIR_FILENAME} store, or a KVStore ${KV_STORE_FILENAME} with declared key ` +
				'fields, can be written.',
		);
	}

	let raw: string;
	try {
		raw = readFileSync(store.file, 'utf-8');
	} catch (error) {
		return refuse('UNSUPPORTED_STORE', `Could not read ${store.id}/${filename}: ${messageOf(error)}`);
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		// Not a shape we recognise, so not a shape we may rewrite. Refusing is
		// the whole point: a write that "fixes" a file someone is mid-edit on
		// destroys the evidence of what was wrong with it.
		return refuse('UNSUPPORTED_STORE', `Could not parse ${store.id}/${filename} as JSON: ${messageOf(error)}`);
	}

	const trailingNewline = raw.endsWith('\n');

	if (filename === KV_STORE_FILENAME) {
		// A `store.json` in any other shape (the object map of an earlier
		// release) has no key attributes to address a record by.
		if (!isKvStoreFile(parsed)) {
			return refuse(
				'UNSUPPORTED_STORE',
				`Store "${store.id}" (${filename}) is not a KVStore data file with a version, so it has no key ` +
					'model to address a record by.',
			);
		}
		// A store with no declared key keys each item by one string that is not a
		// field of the value. The key fields the caller sent do not describe such
		// a file, and an item written by them is one the store does not read.
		if (isStringKeyed(parsed.items)) {
			return refuse(
				'UNSUPPORTED_STORE',
				`Store "${store.id}" (${filename}) keys its records by a string, not by declared key fields, ` +
					'so a record cannot be addressed by the key fields of the block.',
			);
		}
		return { format: 'kv-store', store, items: parsed.items, trailingNewline };
	}

	// An EMPTY array is a legitimate empty pair store — the reader cannot tell
	// it apart from any other empty array and does not need to, but a write path
	// must be able to create the first record in a store.
	if (!Array.isArray(parsed) || !parsed.every(isPairEntry)) {
		return refuse(
			'UNSUPPORTED_STORE',
			`Store "${store.id}" (${filename}) is not in the [key, item] pair format, so it has no key model ` +
				'to address a record by.',
		);
	}

	return { format: 'pairs', store, pairs: parsed, trailingNewline };
}

function isRefusal(value: OpenStore | LocalWriteResult): value is LocalWriteResult {
	return 'ok' in value;
}

/** Monotonic within a process, so two writes in the same millisecond cannot pick one temp name. */
let tempCounter = 0;

/**
 * Serialises `content` (the pairs, or the `KVStore` data file) over `file`
 * atomically.
 *
 * Temp file in the SAME directory, then `renameSync`: same directory means the
 * same filesystem, which is what makes the rename atomic, so a reader (or a
 * crash) sees either the whole old file or the whole new one and never a
 * half-written one. The temp name is dot-prefixed and does not end in `.json`,
 * so a concurrent `listLocalStores` cannot mistake it for a store file in the
 * window before the rename.
 */
function writeStoreAtomically(file: string, content: unknown, trailingNewline: boolean): void {
	const body = JSON.stringify(content, null, STORE_INDENT) + (trailingNewline ? '\n' : '');
	tempCounter += 1;
	const temp = join(dirname(file), `.${basename(file)}.${process.pid}.${Date.now()}.${tempCounter}.tmp`);
	try {
		writeFileSync(temp, body, 'utf-8');
		renameSync(temp, file);
	} catch (error) {
		// Best-effort cleanup: a failed rename must not leave the temp file
		// behind, and a failed unlink must not mask the real error.
		try {
			unlinkSync(temp);
		} catch {
			// Already gone, or never created.
		}
		throw error;
	}
}

/** Attaches `RecordValidationError.path` when the validator supplied one. */
function validationMessage(error: unknown): string {
	const message = messageOf(error);
	const path = (error as { path?: unknown }).path;
	return typeof path === 'string' && path !== '' ? `${message} (at ${path})` : message;
}

type ValidatedItem =
	| { ok: true; record: Record<string, unknown>; keyValues: Record<string, string> }
	| { ok: false; message: string };

/** Runs the concurrently-owned validator and key extractor as one step. */
function validateItem(item: unknown, keySchema: BlockKeySchema): ValidatedItem {
	try {
		validateRecord(item, keySchema);
		return { ok: true, record: item, keyValues: keyOf(item, keySchema) };
	} catch (error) {
		return { ok: false, message: validationMessage(error) };
	}
}

/**
 * The two checks that must happen before anything touches the filesystem, in
 * that order.
 *
 * The id guard is first because it is the one check whose whole value is being
 * ahead of a syscall. The rejected value is not echoed back: it is unvalidated
 * input that may carry a NUL or a traversal, and repeating it into a message
 * bound for a UI or a log serves an attacker rather than a reader.
 */
function refuseUnsafeContext(context: LocalWriteContext): LocalWriteResult | undefined {
	if (!isSafeBlockFullId(context.blockFullId)) {
		return refuse('VALIDATION_FAILED', 'Block id is not a valid local store name.');
	}
	return undefined;
}

/**
 * A block with no discovered key schema cannot be written to.
 *
 * Without it the serialized key cannot be constructed, and guessing `pk`/`sk`
 * would write a record under a key the dev server will never look for — a
 * record that exists on disk and does not exist to the application is worse
 * than a refusal.
 */
function requireKeySchema(context: LocalWriteContext): BlockKeySchema | LocalWriteResult {
	if (context.keySchema === undefined) {
		return refuse(
			'VALIDATION_FAILED',
			`No key schema was discovered for block "${context.blockFullId}", so a record key cannot be built. ` +
				'Writes need the declared key fields of the block.',
		);
	}
	return context.keySchema;
}

function isKeySchemaRefusal(value: BlockKeySchema | LocalWriteResult): value is LocalWriteResult {
	return 'ok' in value;
}

/**
 * Creates or replaces one record in a block's local pair store or `KVStore`
 * data file.
 *
 * `create` on an existing key is `ALREADY_EXISTS` and `edit` on a missing key is
 * `NOT_FOUND`, so neither mode can quietly do the other one's job — the caller
 * asked for a specific outcome and gets it or gets told why not.
 */
export async function putLocalRecord(
	context: LocalWriteContext,
	item: unknown,
	mode: WriteMode,
): Promise<LocalWriteResult> {
	const unsafe = refuseUnsafeContext(context);
	if (unsafe !== undefined) return unsafe;

	const devServer = await refuseWhenDevServerUp(context);
	if (devServer !== undefined) return devServer;

	const keySchema = requireKeySchema(context);
	if (isKeySchemaRefusal(keySchema)) return keySchema;

	const validated = validateItem(item, keySchema);
	if (!validated.ok) return refuse('VALIDATION_FAILED', validated.message);

	const keyFields = keyFieldsOf(keySchema);
	const key = serializePairKey(validated.keyValues, keyFields);
	if (key === undefined) {
		return refuse('VALIDATION_FAILED', `Record is missing a value for every key field (${keyFields.join(', ')}).`);
	}

	const opened = openStore(context);
	if (isRefusal(opened)) return opened;

	if (opened.format === 'kv-store') {
		// The store owns every top-level attribute with this prefix (its key and
		// its expiry are there), and its own `put` refuses a value that has one.
		const reserved = reservedFieldOf(validated.record);
		if (reserved !== undefined) {
			return refuse(
				'VALIDATION_FAILED',
				`Field '${reserved}' starts with ${KV_RESERVED_PREFIX}, the prefix the store keeps for its own ` +
					'attributes. Rename the field.',
			);
		}
	}

	const { store, trailingNewline } = opened;
	const existing = indexOfRecord(opened, key, validated.keyValues, keyFields);

	if (mode === 'create') {
		if (existing !== -1) {
			return refuse('ALREADY_EXISTS', `A record with key ${key} already exists in store "${store.id}".`);
		}
		if (opened.format === 'pairs') opened.pairs.push([key, validated.record]);
		else opened.items.push(validated.record);
	} else {
		if (existing === -1) {
			return refuse('NOT_FOUND', `No record with key ${key} in store "${store.id}".`);
		}
		if (opened.format === 'pairs') {
			// Replace the ITEM and keep the key string exactly as it was on disk. A
			// re-encode would rewrite a numeric sort key (`["u1",9]`) into its string
			// form, which is a change to the key nobody asked for; keeping the
			// original also holds the record at its existing position, so an edit
			// diffs as one record rather than as a reordering.
			opened.pairs[existing] = [opened.pairs[existing][0], validated.record];
		} else {
			// The same rule for a `KVStore` item, whose key is in the item itself:
			// the key attributes stay as they were on disk. So does the expiry, which
			// is not part of the value the editor showed.
			opened.items[existing] = replaceKvItem(opened.items[existing], validated.record, keyFields);
		}
	}

	try {
		writeStoreAtomically(store.file, contentOf(opened), trailingNewline);
	} catch (error) {
		return refuse('UNSUPPORTED_STORE', `Could not write store "${store.id}": ${messageOf(error)}`);
	}

	const verb = mode === 'create' ? 'Created' : 'Updated';
	return ok(`${verb} record ${key} in store "${store.id}".`);
}

/** Removes exactly one record, addressed by its key fields. */
export async function deleteLocalRecord(
	context: LocalWriteContext,
	keyValues: Record<string, string>,
): Promise<LocalWriteResult> {
	const unsafe = refuseUnsafeContext(context);
	if (unsafe !== undefined) return unsafe;

	const devServer = await refuseWhenDevServerUp(context);
	if (devServer !== undefined) return devServer;

	const keySchema = requireKeySchema(context);
	if (isKeySchemaRefusal(keySchema)) return keySchema;

	const keyFields = keyFieldsOf(keySchema);
	const key = serializePairKey(keyValues ?? {}, keyFields);
	if (key === undefined) {
		return refuse('VALIDATION_FAILED', `A value is required for every key field (${keyFields.join(', ')}).`);
	}

	const opened = openStore(context);
	if (isRefusal(opened)) return opened;

	const { store, trailingNewline } = opened;
	const existing = indexOfRecord(opened, key, keyValues, keyFields);
	if (existing === -1) {
		return refuse('NOT_FOUND', `No record with key ${key} in store "${store.id}".`);
	}
	// Exactly one: `splice` at a found index, never a filter over a predicate
	// that could match twice.
	if (opened.format === 'pairs') opened.pairs.splice(existing, 1);
	else opened.items.splice(existing, 1);

	try {
		writeStoreAtomically(store.file, contentOf(opened), trailingNewline);
	} catch (error) {
		return refuse('UNSUPPORTED_STORE', `Could not write store "${store.id}": ${messageOf(error)}`);
	}

	return ok(`Deleted record ${key} from store "${store.id}".`);
}
