// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// KVStore + DistributedTable parity runner for kv.cases.ts.

import { randomUUID } from 'node:crypto';
import { DistributedTable, KVStore } from '@aws-blocks/blocks';
import type { Scope } from '@aws-blocks/blocks';
import { z } from 'zod';
import { DDB_ITEM_LIMIT } from './kv.cases.js';
import { describeError, param, runCase } from '../server/helpers.js';
import { trackBlock } from '../server/track.js';
import type { ParityCase, ProbeError, ProbeRun, ProbeRunner } from '../core/types.js';

/** Attribute-name bytes of a KVStore item: `pk` + `value` (bb-kv-store/src/index.aws.ts). */
const KV_NAME_BYTES = 'pk'.length + 'value'.length;

// Every field but the keys is optional, so each case writes only what it probes.
const ptySchema = z.object({
	pk: z.string(),
	sk: z.string(),
	/** Partition key of the `byTag` GSI. */
	tag: z.string().optional(),
	blob: z.string().optional(),
	num: z.number().optional(),
	when: z.date().optional(),
	data: z.unknown().optional(),
});
type PtyItem = z.infer<typeof ptySchema>;
type PtyKey = Pick<PtyItem, 'pk' | 'sk'>;

/** A per-run partition key, so concurrent or repeated runs never share items. */
function runId(): string {
	return `pty-${randomUUID().slice(0, 8)}`;
}

/** Pad an ASCII string with `x` to exactly `bytes` bytes. */
function padTo(prefix: string, bytes: number): string {
	return bytes <= prefix.length ? prefix.slice(0, bytes) : prefix + 'x'.repeat(bytes - prefix.length);
}

/** `depth` nested maps: 1 → `{}`, 2 → `{ n: {} }`. */
function nest(depth: number): unknown {
	let v: Record<string, unknown> = {};
	for (let i = 1; i < depth; i++) v = { n: v };
	return v;
}

/** Map depth of a value built by `nest`, 0 when it is not a map. */
function depthOf(v: unknown): number {
	let d = 0;
	for (let cur = v; cur !== null && typeof cur === 'object' && !Array.isArray(cur); cur = (cur as Record<string, unknown>).n) d++;
	return d;
}

/**
 * An item exactly `ddbBytes` large by DynamoDB's sizing rule
 * (CapacityUnitCalculations.html), all ASCII so bytes == characters.
 * - `string`: `blob` is a string; size = Σ(name + value bytes).
 * - `nested-list`: `data` is a list of empty lists; each element costs 3 (empty
 *   List) + 1 (element overhead) and the outer List adds 3. Its JSON is ~3/4 of
 *   that, so it lands well under the mock's JSON-byte check.
 * The sort key absorbs the remainder so the total is exact.
 */
function sizedItem(pk: string, shape: string, ddbBytes: number): PtyItem {
	const keyBytes = 'pk'.length + pk.length + 'sk'.length;
	if (shape === 'string') {
		const sk = 's';
		return { pk, sk, blob: 'a'.repeat(ddbBytes - keyBytes - sk.length - 'blob'.length) };
	}
	if (shape === 'nested-list') {
		const rest = ddbBytes - keyBytes - 1 - 'data'.length - 3;
		const n = Math.floor(rest / 4);
		const sk = padTo('s', 1 + (rest % 4));
		return { pk, sk, data: Array.from({ length: n }, () => []) };
	}
	throw new Error(`unknown item shape ${shape}`);
}

function keyOf(item: PtyItem): PtyKey {
	return { pk: item.pk, sk: item.sk };
}

/** Count items from an AsyncIterable without collecting them. */
async function count(it: AsyncIterable<unknown>): Promise<number> {
	let n = 0;
	for await (const _ of it) n++;
	return n;
}

/**
 * Builds the pack's own KVStore and DistributedTable (one each, plus one GSI so
 * a case can probe an index key). Call once, at module load.
 */
export function kvProbe(scope: Scope): ProbeRunner {
	const store = trackBlock(new KVStore(scope, 'pty-kv', {}));
	const table = trackBlock(new DistributedTable(scope, 'pty-dt', {
		schema: ptySchema,
		key: { partitionKey: 'pk', sortKey: 'sk' },
		indexes: { byTag: { partitionKey: 'tag', sortKey: 'sk' } },
		// Report what was stored, not a schema-coerced view of it.
		readValidation: 'off',
	}));

	/** Write `items` through the cheapest path the block offers, in the case's setup. */
	async function seed(items: PtyItem[]): Promise<void> {
		await table.putBatch(items);
	}

	async function removeAll(keys: PtyKey[]): Promise<void> {
		if (keys.length > 0) await table.deleteBatch(keys);
	}

	// Cases whose write can be rejected by AWS (oversized or empty keys) remove
	// only what they wrote: a delete with the same bad key would fail too and
	// misreport cleanup.
	interface Written {
		written: boolean;
	}

	function storeItemSize(c: ParityCase): Promise<ProbeRun> {
		const key = runId();
		const jsonBytes = typeof c.params.jsonBytes === 'number'
			? c.params.jsonBytes
			: param(c.params, 'ddbBytes', 'number') - KV_NAME_BYTES - key.length;
		// JSON.stringify of an all-`a` string adds the two quotes.
		const valueLength = jsonBytes - 2;
		return runCase<Written>({
			setup: async () => ({ written: false }),
			act: async (s) => {
				await store.put(key, 'a'.repeat(valueLength));
				s.written = true;
				const back = await store.get(key);
				return { jsonBytes, ddbBytes: KV_NAME_BYTES + key.length + jsonBytes, readBackLength: back?.length ?? null };
			},
			cleanup: async (s) => {
				if (s?.written) await store.delete(key);
			},
		});
	}

	function storeKey(c: ParityCase): Promise<ProbeRun> {
		const op = param(c.params, 'op', 'string');
		const key = padTo(runId(), param(c.params, 'keyBytes', 'number'));
		return runCase<Written>({
			setup: async () => ({ written: false }),
			act: async (s) => {
				if (op === 'get') return { found: (await store.get(key)) !== null };
				await store.put(key, 'v');
				s.written = true;
				return { readBack: await store.get(key) };
			},
			cleanup: async (s) => {
				if (s?.written) await store.delete(key);
			},
		});
	}

	function tableItemSize(c: ParityCase): Promise<ProbeRun> {
		const entry = param(c.params, 'entry', 'string');
		const ddbBytes = param(c.params, 'ddbBytes', 'number');
		const item = sizedItem(runId(), param(c.params, 'shape', 'string'), ddbBytes);
		return runCase({
			setup: async () => undefined,
			act: async () => {
				if (entry === 'putBatch') await table.putBatch([item]);
				else await table.put(item);
				const back = await table.get(keyOf(item));
				return {
					ddbBytes,
					jsonBytes: Buffer.byteLength(JSON.stringify(item), 'utf8'),
					stored: back !== null,
				};
			},
			cleanup: () => removeAll([keyOf(item)]),
		});
	}

	function tableBatchAtomicity(c: ParityCase): Promise<ProbeRun> {
		const pk = runId();
		const oversizedIndex = param(c.params, 'oversizedIndex', 'number');
		const items: PtyItem[] = Array.from({ length: param(c.params, 'items', 'number') }, (_, i) => ({
			pk,
			sk: String(i).padStart(3, '0'),
			// Over 400 KB by both the JSON and the DynamoDB measure.
			...(i === oversizedIndex ? { blob: 'a'.repeat(DDB_ITEM_LIMIT + 1024) } : {}),
		}));
		const keys = items.map(keyOf);
		return runCase({
			setup: async () => undefined,
			act: async () => {
				let error: ProbeError | null = null;
				try {
					await table.putBatch(items);
				} catch (e) {
					error = describeError(e);
				}
				const persisted = (await table.getBatch(keys)).filter((x) => x !== null).length;
				return { error, persisted, of: items.length };
			},
			cleanup: () => removeAll(keys),
		});
	}

	function tableBatchDuplicates(c: ParityCase): Promise<ProbeRun> {
		const entry = param(c.params, 'entry', 'string');
		const key: PtyKey = { pk: runId(), sk: 's' };
		return runCase({
			setup: async () => {
				if (entry === 'getBatch') await table.put({ ...key, num: 1 });
			},
			act: async () => {
				if (entry === 'getBatch') {
					const got = await table.getBatch([key, key]);
					return { length: got.length, found: got.filter((x) => x !== null).length };
				}
				await table.putBatch([{ ...key, num: 1 }, { ...key, num: 2 }]);
				return { storedNum: (await table.get(key))?.num ?? null };
			},
			cleanup: () => removeAll([key]),
		});
	}

	function tableMarshal(c: ParityCase): Promise<ProbeRun> {
		const value = param(c.params, 'value', 'string');
		const key: PtyKey = { pk: runId(), sk: 's' };
		const unsafe = Number.MAX_SAFE_INTEGER + 3; // 2^53 + 2, exactly representable
		return runCase({
			setup: async () => undefined,
			act: async () => {
				switch (value) {
					case 'undefined-attribute': {
						// An optional field explicitly set to undefined, e.g. `{ ...item, blob: maybe }`.
						await table.put({ ...key, blob: undefined });
						const back = await table.get(key);
						return { stored: back !== null, hasBlobKey: back !== null && 'blob' in back };
					}
					case 'date-attribute': {
						await table.put({ ...key, when: new Date(0) });
						const back = await table.get(key);
						return { stored: back !== null, readBackType: back?.when instanceof Date ? 'Date' : typeof back?.when };
					}
					case 'unsafe-integer': {
						await table.put({ ...key, num: unsafe });
						const back = await table.get(key);
						return { stored: back !== null, roundTrips: back?.num === unsafe };
					}
					default:
						throw new Error(`unknown marshal value ${value}`);
				}
			},
			cleanup: () => removeAll([key]),
		});
	}

	function tableNesting(c: ParityCase): Promise<ProbeRun> {
		const depth = param(c.params, 'depth', 'number');
		const key: PtyKey = { pk: runId(), sk: 's' };
		return runCase({
			setup: async () => undefined,
			act: async () => {
				await table.put({ ...key, data: nest(depth) });
				const back = await table.get(key);
				return { readBackDepth: back === null ? null : depthOf(back.data) };
			},
			cleanup: () => removeAll([key]),
		});
	}

	function tableKey(c: ParityCase): Promise<ProbeRun> {
		const variant = param(c.params, 'key', 'string');
		const pk = runId();
		const item: PtyItem = variant === 'sort-key-1025'
			? { pk, sk: padTo('s', 1025) }
			: { pk, sk: 's', tag: '' };
		return runCase<Written>({
			setup: async () => ({ written: false }),
			act: async (s) => {
				await table.put(item);
				s.written = true;
				return { stored: (await table.get(keyOf(item))) !== null };
			},
			cleanup: async (s) => {
				if (s?.written) await removeAll([keyOf(item)]);
			},
		});
	}

	function tableQuery(c: ParityCase): Promise<ProbeRun> {
		const variant = param(c.params, 'variant', 'string');
		const pk = runId();
		// U+FF61 sorts after U+1F600 by UTF-16 code unit (0xFF61 > 0xD83D), before it by UTF-8 byte (0xEF < 0xF0).
		const labels: Record<string, string> = { z: 'z', '\uFF61': 'U+FF61', '\u{1F600}': 'U+1F600' };
		const sortKeys = variant === 'utf8-order' ? Object.keys(labels) : ['a', 'b', 'c'];
		const items: PtyItem[] = sortKeys.map((sk) => ({ pk, sk }));
		return runCase({
			setup: () => seed(items),
			act: async () => {
				switch (variant) {
					case 'limit-0':
						return { count: await count(table.query({ where: { pk: { equals: pk } }, limit: 0 })) };
					case 'scan-limit-0': {
						// Stop at the first item: an unbounded scan of a shared table is not the point.
						for await (const _ of table.scan({ limit: 0 })) return { yieldedAny: true };
						return { yieldedAny: false };
					}
					case 'between-reversed':
						return { count: await count(table.query({ where: { pk: { equals: pk }, sk: { between: ['c', 'a'] } } })) };
					case 'utf8-order': {
						const order: string[] = [];
						for await (const it of table.query({ where: { pk: { equals: pk } } })) order.push(labels[it.sk] ?? '?');
						return { order };
					}
					default:
						throw new Error(`unknown query variant ${variant}`);
				}
			},
			cleanup: () => removeAll(items.map(keyOf)),
		});
	}

	const scenarios: Readonly<Record<string, (c: ParityCase) => Promise<ProbeRun>>> = {
		'store-item-size': storeItemSize,
		'store-key': storeKey,
		'table-item-size': tableItemSize,
		'table-batch-atomicity': tableBatchAtomicity,
		'table-batch-duplicates': tableBatchDuplicates,
		'table-marshal': tableMarshal,
		'table-nesting': tableNesting,
		'table-key': tableKey,
		'table-query': tableQuery,
	};

	return (c) => {
		const scenario = scenarios[param(c.params, 'scenario', 'string')];
		if (!scenario) throw new Error(`unknown kv scenario in case ${c.id}`);
		return scenario(c);
	};
}
