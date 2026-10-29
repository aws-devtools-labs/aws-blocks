// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Structural comparison for the differ. A passing e2e test asserts two or three
 * fields of a result; the shape is what its other consumers see: which fields
 * exist, and the type each one has. Two results with the same shape but
 * different values are usually data (ids, names, counts); two with different
 * shapes are code that works in one environment and breaks in the other
 * (a `Date` locally and an ISO string deployed, a field the mock never returns).
 *
 * Pure. Works on recorder snapshots (`../client/recorder.ts`), so the snapshot
 * placeholders (`<date>`, `<bytes:12>`, `<Channel>`) count as their own types.
 */

export interface Shape {
	/** Sorted type tags; more than one when array elements disagree. */
	readonly types: readonly string[];
	/** Field shapes, when one of `types` is `object`. */
	readonly keys?: Readonly<Record<string, Shape>>;
	/** Merged element shape, when one of `types` is `array` and an element was seen. */
	readonly items?: Shape;
}

export interface ShapeDifference {
	/** JSONPath-like location: `$`, `$.items[].when`. */
	readonly path: string;
	readonly local: string;
	readonly deployed: string;
}

// Placeholders the recorder writes in place of values JSON cannot carry (see `snapshot`).
const SNAPSHOT_TAGS: Readonly<Record<string, string>> = {
	undefined: 'undefined',
	date: 'date',
	bytes: 'bytes',
	bigint: 'bigint',
	function: 'function',
	'cycle-or-deep': 'cycle-or-deep',
	string: 'string',
	redacted: 'string',
};
const PLACEHOLDER = /^<([A-Za-z$][\w$-]*)(?::[^>]*)?>$/;

function typeTag(value: unknown): string {
	if (value === null) return 'null';
	if (Array.isArray(value)) return 'array';
	if (typeof value === 'string') {
		const m = PLACEHOLDER.exec(value);
		if (!m) return 'string';
		const tag = m[1];
		if (Object.hasOwn(SNAPSHOT_TAGS, tag)) return SNAPSHOT_TAGS[tag];
		// `<Channel>`: a live object the recorder kept only the class name of.
		return /^[A-Z]/.test(tag) ? `object:${tag}` : 'string';
	}
	return typeof value;
}

export function shapeOf(value: unknown): Shape {
	const tag = typeTag(value);
	if (tag === 'array') {
		const items = (value as unknown[]).map(shapeOf).reduce<Shape | undefined>((acc, s) => (acc ? mergeShapes(acc, s) : s), undefined);
		return items ? { types: [tag], items } : { types: [tag] };
	}
	if (tag === 'object') {
		const keys: Record<string, Shape> = {};
		for (const [k, v] of Object.entries(value as Record<string, unknown>)) keys[k] = shapeOf(v);
		return { types: [tag], keys };
	}
	return { types: [tag] };
}

function mergeShapes(a: Shape, b: Shape): Shape {
	const types = [...new Set([...a.types, ...b.types])].sort();
	let keys: Record<string, Shape> | undefined;
	if (a.keys || b.keys) {
		keys = { ...a.keys };
		for (const [k, s] of Object.entries(b.keys ?? {})) keys[k] = keys[k] ? mergeShapes(keys[k], s) : s;
	}
	const items = a.items && b.items ? mergeShapes(a.items, b.items) : (a.items ?? b.items);
	return { types, ...(keys ? { keys } : {}), ...(items ? { items } : {}) };
}

/**
 * Every place where the two shapes disagree, outermost first. A type mismatch
 * stops the descent at that path. An empty array matches any element shape:
 * no elements is a value difference, not a structural one.
 */
export function shapeDiff(local: Shape, deployed: Shape, path = '$'): ShapeDifference[] {
	const lt = local.types.join('|');
	const dt = deployed.types.join('|');
	if (lt !== dt) return [{ path, local: lt, deployed: dt }];
	const out: ShapeDifference[] = [];
	if (local.keys && deployed.keys) {
		for (const k of [...new Set([...Object.keys(local.keys), ...Object.keys(deployed.keys)])].sort()) {
			const l = local.keys[k];
			const d = deployed.keys[k];
			if (!l || !d) out.push({ path: `${path}.${k}`, local: l ? l.types.join('|') : 'absent', deployed: d ? d.types.join('|') : 'absent' });
			else out.push(...shapeDiff(l, d, `${path}.${k}`));
		}
	}
	if (local.items && deployed.items) out.push(...shapeDiff(local.items, deployed.items, `${path}[]`));
	return out;
}

/** `value` with every array sorted and every object's keys sorted, so element order no longer counts. */
function canonical(value: unknown): unknown {
	if (Array.isArray(value)) {
		return value
			.map(canonical)
			.map((v) => [JSON.stringify(v) ?? '', v] as const)
			.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
			.map(([, v]) => v);
	}
	if (value && typeof value === 'object') {
		return Object.fromEntries(
			Object.keys(value)
				.sort()
				.map((k) => [k, canonical((value as Record<string, unknown>)[k])]),
		);
	}
	return value;
}

/** True when `a` and `b` hold the same elements, in any array order. */
export function sameIgnoringOrder(a: unknown, b: unknown): boolean {
	return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
}
