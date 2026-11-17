// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import type { BlockKeySchema } from '../contract/v1.js';
import { keySchemaFields } from './pair-key.js';

/**
 * Validation of a single record before it is written to a table.
 *
 * Every rejection here is a caller error reported as an actionable message with
 * the offending path, so the editor can point at the field rather than
 * surrendering a 500. Two hazards the reference implementation gets wrong:
 *
 * - Its JSON-safety walk has no depth limit. 100 KB of `[[[[…]]]]` passes the
 *   byte cap, then recurses far enough to throw `RangeError: Maximum call stack
 *   size exceeded` — a validation problem escaping as a crash. `MAX_DEPTH` turns
 *   that back into an ordinary validation error.
 * - It accepts `Set`, `Map`, `Buffer`/`Uint8Array` and `Date` instances, which
 *   JSON cannot express. Those are real DynamoDB attribute types (`SS`/`NS`/`BS`
 *   sets, `B` binary) and a timestamp convention on top of them; a record read
 *   from a table that already holds a set cannot be round-tripped through a JSON
 *   editor. Refusing loudly, naming the type, is the documented non-goal — the
 *   alternative is silently mangling the item on write.
 */

/** A record the caller must fix, with the path of the offending value when known. */
export class RecordValidationError extends Error {
	/** Dotted/bracketed path of the offending value, e.g. `record.items[3].qty`. */
	readonly path?: string;

	constructor(message: string, path?: string) {
		super(message);
		this.name = 'RecordValidationError';
		this.path = path;
	}
}

/**
 * Largest serialized record accepted.
 *
 * Well under DynamoDB's own 400 KB item limit: this cap exists to keep the
 * editor, the request body and the local JSON file tractable, so it is
 * deliberately the stricter of the two and a record that passes here can never
 * be rejected by DynamoDB for size.
 */
export const MAX_RECORD_BYTES = 100 * 1024;

/** Longest key-field value accepted. DynamoDB's own partition-key cap is 2048 bytes. */
export const MAX_KEY_CHARS = 1024;

/** Deepest nesting accepted, counting the record itself as depth 0. */
export const MAX_DEPTH = 64;

/** Own property names refused anywhere in a record, at any depth. */
const FORBIDDEN_KEYS = ['__proto__', 'constructor'];

/**
 * The key fields of a schema, partition key first. Composite schemas have two.
 *
 * Delegates to `pair-key.ts`, which owns the ordering: the same order decides
 * how a local record's key is serialized on disk, so a second implementation
 * here could silently disagree with the one the reader and writer use.
 */
export function keyFieldsOf(keySchema: BlockKeySchema): string[] {
	return keySchemaFields(keySchema);
}

/** True for `{}` and `JSON.parse` output; false for arrays, `null` and class instances. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		return false;
	}
	const proto = Object.getPrototypeOf(value);
	return proto === Object.prototype || proto === null;
}

/**
 * Names the type of a non-plain object, and says whether it is one of the
 * DynamoDB attribute types this editor deliberately refuses.
 *
 * Returns `undefined` for a plain object, which is walkable.
 *
 * `Buffer` is checked before `Uint8Array` because a Buffer *is* a Uint8Array and
 * the more specific name is the more useful one in the message.
 */
function classifyObject(value: object): { name: string; dynamoAttribute: boolean } | undefined {
	if (value instanceof Date) {
		return { name: 'Date', dynamoAttribute: true };
	}
	if (value instanceof Set) {
		return { name: 'Set', dynamoAttribute: true };
	}
	if (value instanceof Map) {
		return { name: 'Map', dynamoAttribute: true };
	}
	if (Buffer.isBuffer(value)) {
		return { name: 'Buffer', dynamoAttribute: true };
	}
	if (value instanceof Uint8Array) {
		return { name: 'Uint8Array', dynamoAttribute: true };
	}
	if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) {
		return { name: value.constructor?.name ?? 'binary', dynamoAttribute: true };
	}
	if (isPlainObject(value)) {
		return undefined;
	}
	return { name: value.constructor?.name ?? 'class instance', dynamoAttribute: false };
}

/**
 * Why a `Date`/`Set`/`Map`/binary value is refused rather than coerced.
 *
 * These are genuine DynamoDB attribute types (`SS`/`NS`/`BS` sets, `B` binary) and
 * a `Date` is how a timestamp reaches them. JSON cannot express any of them, so a
 * record holding one cannot be round-tripped through a JSON editor. Refusing
 * loudly and naming the type is the documented non-goal; the alternative is
 * silently mangling the item on write.
 */
function unsupportedMessage(path: string, typeName: string, dynamoAttribute: boolean): string {
	if (dynamoAttribute) {
		return (
			`${path} is a ${typeName}, which JSON cannot represent. ${typeName} is a DynamoDB attribute ` +
			'type (set SS/NS/BS, or binary B) that cannot be round-tripped through this editor, so it is ' +
			'refused rather than silently converted. Represent the value as a string, number, boolean, ' +
			'array or plain object.'
		);
	}
	return (
		`${path} is a ${typeName} instance, not a plain JSON object. Only null, strings, booleans, ` +
		'finite numbers, arrays and plain objects can be stored.'
	);
}

/** Recursive JSON-safety walk. `depth` is the nesting level of `value`, root being 0. */
function walk(value: unknown, path: string, depth: number): void {
	if (depth > MAX_DEPTH) {
		throw new RecordValidationError(
			`${path} is nested more than ${MAX_DEPTH} levels deep. Flatten the record: deeper nesting ` +
				'cannot be validated safely.',
			path,
		);
	}

	if (value === null) {
		return;
	}

	switch (typeof value) {
		case 'string':
		case 'boolean':
			return;
		case 'number':
			if (!Number.isFinite(value)) {
				throw new RecordValidationError(
					`${path} is ${String(value)}, which JSON cannot represent. Use a finite number.`,
					path,
				);
			}
			return;
		case 'undefined':
			throw new RecordValidationError(
				`${path} is undefined. Omit the field, or set it to null if the absence is meaningful.`,
				path,
			);
		case 'bigint':
			throw new RecordValidationError(
				`${path} is a bigint, which JSON cannot represent. Use a number, or a string if the ` +
					'value exceeds the safe integer range.',
				path,
			);
		case 'function':
			throw new RecordValidationError(`${path} is a function, which is not a storable value.`, path);
		case 'symbol':
			throw new RecordValidationError(`${path} is a symbol, which is not a storable value.`, path);
		default:
			break;
	}

	if (Array.isArray(value)) {
		for (const [index, element] of value.entries()) {
			walk(element, `${path}[${index}]`, depth + 1);
		}
		return;
	}

	const classification = classifyObject(value as object);
	if (classification !== undefined) {
		throw new RecordValidationError(
			unsupportedMessage(path, classification.name, classification.dynamoAttribute),
			path,
		);
	}

	walkPlainObject(value as Record<string, unknown>, path, depth);
}

/** Walks a plain object's own enumerable properties, refusing prototype-poisoning names. */
function walkPlainObject(value: Record<string, unknown>, path: string, depth: number): void {
	for (const key of Object.keys(value)) {
		const childPath = `${path}.${key}`;
		if (FORBIDDEN_KEYS.includes(key)) {
			throw new RecordValidationError(
				`${childPath} uses the reserved property name '${key}'. This record is also written to a ` +
					'local JSON file and re-parsed, where that name corrupts the parsed object. Rename the field.',
				childPath,
			);
		}
		walk(value[key], childPath, depth + 1);
	}
}

/**
 * Validates a record for writing, narrowing it to a string-keyed object.
 *
 * Checks run in a fixed order — shape, key fields, size, then the JSON-safety
 * walk — so the first message a caller sees is the most fundamental problem
 * rather than an incidental one.
 *
 * @throws RecordValidationError with an actionable message, and `path` set for
 *         any failure inside the record's value tree.
 */
export function validateRecord(item: unknown, keySchema: BlockKeySchema): asserts item is Record<string, unknown> {
	// 1. A plain JSON object.
	if (item === null) {
		throw new RecordValidationError('The record is null. Provide a JSON object.', 'record');
	}
	if (Array.isArray(item)) {
		throw new RecordValidationError('The record is an array. Provide a single JSON object.', 'record');
	}
	if (typeof item !== 'object') {
		throw new RecordValidationError(`The record is a ${typeof item}. Provide a JSON object.`, 'record');
	}
	if (!isPlainObject(item)) {
		const typeName = classifyObject(item)?.name ?? 'class instance';
		throw new RecordValidationError(
			`The record is a ${typeName}, not a plain JSON object. Provide a plain object literal.`,
			'record',
		);
	}

	// 2. Key fields.
	const record = item as Record<string, unknown>;
	for (const field of keyFieldsOf(keySchema)) {
		const path = `record.${field}`;
		const value = record[field];
		if (value === undefined || !(field in record)) {
			throw new RecordValidationError(`Key field '${field}' is missing. Every record must carry it.`, path);
		}
		if (typeof value !== 'string') {
			throw new RecordValidationError(
				`Key field '${field}' is a ${value === null ? 'null' : typeof value}, but key fields must be strings.`,
				path,
			);
		}
		if (value.length === 0) {
			throw new RecordValidationError(`Key field '${field}' is empty. Key fields must be non-empty.`, path);
		}
		if (value.length > MAX_KEY_CHARS) {
			throw new RecordValidationError(
				`Key field '${field}' is ${value.length} characters, over the ${MAX_KEY_CHARS}-character limit.`,
				path,
			);
		}
	}

	// 3. Serialized size, measured in BYTES. `.length` would under-count a
	//    multi-byte record and let an over-cap item through.
	let serialized: string | undefined;
	try {
		serialized = JSON.stringify(record);
	} catch {
		// Unserializable (a bigint, or a cycle). Leave it to the walk below, which
		// names the offending path instead of reporting an opaque TypeError.
		serialized = undefined;
	}
	if (serialized !== undefined) {
		const bytes = Buffer.byteLength(serialized, 'utf-8');
		if (bytes > MAX_RECORD_BYTES) {
			throw new RecordValidationError(
				`The record is ${bytes} bytes serialized, over the ${MAX_RECORD_BYTES}-byte limit ` +
					"(well under DynamoDB's own 400 KB item limit, so this cap is the editor's, not the table's). " +
					'Split the record or move the bulk of the data elsewhere.',
				'record',
			);
		}
	}

	// 4. JSON-safety walk, depth-limited.
	walkPlainObject(record, 'record', 0);
}

/**
 * The key fields of a validated record, as strings, for addressing it.
 *
 * Re-checks the fields rather than trusting the caller to have validated: this
 * is used on read paths too, where the record came from the table.
 */
export function keyOf(record: Record<string, unknown>, keySchema: BlockKeySchema): Record<string, string> {
	const key: Record<string, string> = {};
	for (const field of keyFieldsOf(keySchema)) {
		const value = record[field];
		if (typeof value !== 'string' || value.length === 0) {
			throw new RecordValidationError(
				`Key field '${field}' is missing or not a non-empty string, so the record cannot be addressed.`,
				`record.${field}`,
			);
		}
		key[field] = value;
	}
	return key;
}
