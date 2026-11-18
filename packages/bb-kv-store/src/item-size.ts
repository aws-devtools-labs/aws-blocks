// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The mock's measure of an item, following DynamoDB's documented sizing rules.
 * On AWS, DynamoDB measures the item itself and the runtime re-maps its error.
 */

function utf8Bytes(value: string): number {
	return Buffer.byteLength(value, 'utf8');
}

/** DynamoDB's size of a number: about one byte per two significant digits, plus one, at most 21. */
function numberBytes(value: number): number {
	if (!Number.isFinite(value) || value === 0) return 2;
	const digits = value.toExponential().split('e')[0].replace(/[-.]/g, '').length;
	return Math.min(Math.ceil(digits / 2) + 1 + (value < 0 ? 1 : 0), 21);
}

function valueBytes(value: unknown): number {
	if (typeof value === 'string') return utf8Bytes(value);
	if (typeof value === 'number') return numberBytes(value);
	if (typeof value === 'boolean' || value === null) return 1;
	if (value instanceof Uint8Array) return value.byteLength;
	if (value instanceof Set) {
		let total = 0;
		for (const member of value) total += valueBytes(member);
		return total;
	}
	// A list or map costs 3 bytes of overhead plus 1 byte per element, on top of the elements.
	if (Array.isArray(value)) return value.reduce<number>((total, element) => total + valueBytes(element) + 1, 3);
	if (typeof value === 'object' && value !== null) {
		return Object.entries(value).reduce(
			(total, [name, member]) => total + utf8Bytes(name) + valueBytes(member) + 1,
			3,
		);
	}
	return 0;
}

/**
 * The size of an item the way DynamoDB counts it: attribute names in UTF-8 bytes
 * plus each value's size. Strings count their UTF-8 bytes, numbers about one byte
 * per two significant digits, booleans and nulls one byte, and lists and maps
 * three bytes of overhead plus one byte per element. Measuring the JSON text
 * instead over-counts quotes and escapes and under-counts a list of small elements.
 *
 * Pass a marshalled copy of the item: it has no `undefined` values and no types
 * the marshaller would convert.
 */
export function dynamoItemSize(item: Record<string, unknown>): number {
	return Object.entries(item).reduce((total, [name, value]) => total + utf8Bytes(name) + valueBytes(value), 0);
}
