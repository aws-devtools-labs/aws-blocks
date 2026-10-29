// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// AsyncJob (bb-async-job) and CronJob (bb-cron-job) parity runner for job.cases.ts.

import { randomUUID } from 'node:crypto';
import { CronJob, KVStore } from '@aws-blocks/blocks';
import type { Scope } from '@aws-blocks/blocks';
import { AsyncJob } from '@aws-blocks/bb-async-job';
import type { AsyncJobStatus } from '@aws-blocks/bb-async-job';
import { param, pollFor, runCase } from '../server/helpers.js';
import type { ProbeRunner } from '../core/types.js';

/** The job's maxRetries (the block default), so cleanup knows how many attempt records can exist. */
const MAX_RETRIES = 3;
/** Backstop expiry for handler records, in case a cleanup is missed. */
const RECORD_TTL_SECONDS = 3600;
/**
 * Expiry for a stop marker. It must outlive every late delivery a case can leave
 * behind: a 900 s delay, or a retry once SQS's ~905 s visibility timeout lapses
 * (up to MAX_RETRIES of them).
 */
const STOP_TTL_SECONDS = 7200;
const CRON_KEY = 'cron:last';
const ISO_MS_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Values JSON cannot carry faithfully. The mock hands the handler the caller's object; SQS carries a string. */
interface RichValues {
	date: Date;
	undef: undefined;
	nan: number;
	inf: number;
	map: Map<string, number>;
	set: Set<number>;
	nested: { deep: { list: Array<number | undefined> } };
}

interface JobPayload {
	/** Unique per case run; prefixes every record key. */
	run: string;
	/** Distinguishes the jobs of a multi-job case. */
	slot: number;
	/** The handler throws while `receiveCount <= failTimes`. */
	failTimes: number;
	/** Probe clock at submit, so the handler can report how long delivery took. */
	t0: number;
	mark?: string;
	pad?: string;
	rich?: RichValues;
}

/** What the handler records per delivery. Small and id-free, apart from `jobId` for a same-id check. */
interface HandlerRecord {
	receiveCount: number;
	jobId: string;
	sentAtIso: boolean;
	at: number;
	elapsedMs: number;
	mark: string | null;
	padBytes: number | null;
	rich: Record<string, string | number | boolean> | null;
}

interface CronRecord {
	scheduledTimeIso: boolean;
	scheduledTimeHasMillis: boolean;
	scheduledTimeOnMinute: boolean;
	jobNameMatches: boolean;
	inputTag: string;
	inputWhen: string;
}

const recordKey = (run: string, slot: number, attempt: number) => `${run}:${slot}:${attempt}`;
const stopKey = (run: string) => `${run}:stop`;

function typeOf(v: unknown): string {
	if (v === null) return 'null';
	if (v instanceof Date) return 'Date';
	if (v instanceof Map) return 'Map';
	if (v instanceof Set) return 'Set';
	if (Array.isArray(v)) return 'array';
	if (typeof v === 'number' && Number.isNaN(v)) return 'NaN';
	if (v === Number.POSITIVE_INFINITY) return 'Infinity';
	return typeof v;
}

/** Read a nested field without trusting the declared payload type (the AWS handler gets parsed JSON). */
function at(v: unknown, ...path: string[]): unknown {
	let cur = v;
	for (const k of path) {
		if (typeof cur !== 'object' || cur === null) return undefined;
		cur = Reflect.get(cur, k);
	}
	return cur;
}

function describeRich(r: unknown): Record<string, string | number | boolean> {
	const list = at(r, 'nested', 'deep', 'list');
	return {
		date: typeOf(at(r, 'date')),
		undefKeyPresent: typeof r === 'object' && r !== null && 'undef' in r,
		nan: typeOf(at(r, 'nan')),
		inf: typeOf(at(r, 'inf')),
		map: typeOf(at(r, 'map')),
		set: typeOf(at(r, 'set')),
		listHole: Array.isArray(list) ? typeOf(list[1]) : 'missing',
	};
}

function richValues(): RichValues {
	return {
		date: new Date(0),
		undef: undefined,
		nan: Number.NaN,
		inf: Number.POSITIVE_INFINITY,
		map: new Map([['a', 1]]),
		set: new Set([1]),
		nested: { deep: { list: [1, undefined, 3] } },
	};
}

/** A payload whose `JSON.stringify` (the exact SQS MessageBody the block sends) is `bodyBytes` UTF-8 bytes. */
function sizedPayload(base: JobPayload, bodyBytes: number): JobPayload {
	const overhead = Buffer.byteLength(JSON.stringify({ ...base, pad: '' }), 'utf8');
	return { ...base, pad: 'x'.repeat(bodyBytes - overhead) };
}

const isTerminal = (s: AsyncJobStatus | null): boolean => s?.state === 'complete' || s?.state === 'failed';

interface CaseState {
	run: string;
	slots: number;
	/** True while a submitted job may still deliver after the case returns. */
	pending: boolean;
}

/**
 * Constructs its own AsyncJob (`pty-job`, with `trackStatus`), a KVStore its
 * handler records into (`pty-jres`), and a rate(1 minute) CronJob (`pty-cron`).
 * `maxBatchingWindowSeconds: 0` keeps deployed delivery inside the poll budget.
 */
export function jobProbe(scope: Scope): ProbeRunner {
	const results = new KVStore<string>(scope, 'pty-jres', { ttl: true });

	const job = new AsyncJob<JobPayload>(scope, 'pty-job', {
		trackStatus: true,
		maxRetries: MAX_RETRIES,
		maxBatchingWindowSeconds: 0,
		handler: async (p, ctx) => {
			// A case that ended before its job settled leaves a stop marker: a late delivery
			// (a long delay, or a retry after the visibility timeout) then succeeds silently,
			// so nothing is recorded after cleanup and nothing lands in the DLQ.
			if ((await results.get(stopKey(p.run))) !== null) return;
			const now = Date.now();
			const rec: HandlerRecord = {
				receiveCount: ctx.receiveCount,
				jobId: ctx.jobId,
				sentAtIso: ISO_RE.test(ctx.sentAt),
				at: now,
				elapsedMs: now - p.t0,
				mark: p.mark ?? null,
				padBytes: typeof p.pad === 'string' ? Buffer.byteLength(p.pad, 'utf8') : null,
				rich: p.rich === undefined ? null : describeRich(p.rich),
			};
			await results.put(recordKey(p.run, p.slot, ctx.receiveCount), JSON.stringify(rec), {
				ttlSeconds: RECORD_TTL_SECONDS,
			});
			if (ctx.receiveCount <= p.failTimes) throw new Error('parity probe: planned handler failure');
		},
	});

	const cronInput = { tag: 'pty', when: new Date(0) };
	const cron: CronJob<typeof cronInput> = new CronJob(scope, 'pty-cron', {
		schedule: 'rate(1 minute)',
		input: cronInput,
		handler: async (event) => {
			const rec: CronRecord = {
				scheduledTimeIso: ISO_RE.test(event.scheduledTime),
				scheduledTimeHasMillis: ISO_MS_RE.test(event.scheduledTime),
				scheduledTimeOnMinute: /:00(\.0+)?Z$/.test(event.scheduledTime),
				jobNameMatches: event.jobName === cron.fullId,
				inputTag: typeOf(at(event.input, 'tag')),
				inputWhen: typeOf(at(event.input, 'when')),
			};
			await results.put(CRON_KEY, JSON.stringify(rec), { ttlSeconds: 600 });
		},
	});

	async function record(run: string, slot: number, attempt: number): Promise<HandlerRecord | null> {
		const raw = await results.get(recordKey(run, slot, attempt));
		return raw === null ? null : (JSON.parse(raw) as HandlerRecord);
	}

	async function attempts(run: string, slot: number): Promise<HandlerRecord[]> {
		const recs = await Promise.all(Array.from({ length: MAX_RETRIES }, (_, i) => record(run, slot, i + 1)));
		return recs.filter((r): r is HandlerRecord => r !== null);
	}

	/** Submit one job and wait (bounded) for its status to settle; summarize what was observed. */
	async function single(
		state: CaseState,
		payload: JobPayload,
		waitMs: number,
		delaySeconds?: number,
		afterSubmit?: () => void,
	) {
		const { jobId } = await job.submit(payload, delaySeconds === undefined ? undefined : { delaySeconds });
		afterSubmit?.();
		state.pending = true;
		const settled =
			waitMs > 0
				? await pollFor(async () => {
						const s = await job.getStatus(jobId);
						return isTerminal(s) ? s : undefined;
					}, waitMs)
				: undefined;
		const status = settled ?? (await job.getStatus(jobId));
		state.pending = !isTerminal(status);
		const recs = await attempts(state.run, 0);
		const first = recs[0];
		return {
			jobIdIsUuid: UUID_RE.test(jobId),
			settled: settled !== undefined,
			states: status?.transitions.map((t) => t.state) ?? null,
			statusAttempts: status?.attempts ?? null,
			receiveCounts: recs.map((r) => r.receiveCount),
			handler:
				first === undefined
					? `not observed within ${waitMs / 1000} s`
					: {
							ctxJobIdMatches: first.jobId === jobId,
							sentAtIso: first.sentAtIso,
							mark: first.mark,
							padBytes: first.padBytes,
							rich: first.rich,
							ranNotBeforeDelay: delaySeconds === undefined ? null : first.elapsedMs >= delaySeconds * 1000 - 100,
						},
		};
	}

	/** Wait (bounded) until every slot's first delivery is recorded. */
	async function firstDeliveries(state: CaseState, waitMs: number): Promise<HandlerRecord[]> {
		const all = await pollFor(async () => {
			const recs = await Promise.all(Array.from({ length: state.slots }, (_, slot) => record(state.run, slot, 1)));
			return recs.every((r) => r !== null) ? recs.filter((r): r is HandlerRecord => r !== null) : undefined;
		}, waitMs);
		if (all !== undefined) {
			state.pending = false;
			return all;
		}
		const partial = await Promise.all(Array.from({ length: state.slots }, (_, slot) => record(state.run, slot, 1)));
		return partial.filter((r): r is HandlerRecord => r !== null);
	}

	return (c) => {
		const kind = param(c.params, 'kind', 'string');
		const run = `pty-${randomUUID()}`;
		const base = (slot: number): JobPayload => ({ run, slot, failTimes: 0, t0: Date.now() });

		return runCase<CaseState>({
			setup: async () => ({ run, slots: kind === 'order' || kind === 'batch' ? param(c.params, 'count', 'number') : 1, pending: false }),
			act: async (state) => {
				switch (kind) {
					case 'basic': {
						const summary = await single(state, base(0), param(c.params, 'waitMs', 'number'));
						return { ...summary, unknownJobStatusIsNull: (await job.getStatus(randomUUID())) === null };
					}
					case 'size':
						return await single(
							state,
							sizedPayload(base(0), param(c.params, 'bodyBytes', 'number')),
							param(c.params, 'waitMs', 'number'),
						);
					case 'chars':
						return await single(
							state,
							{ ...base(0), pad: `a${String.fromCodePoint(param(c.params, 'codePoint', 'number'))}b` },
							param(c.params, 'waitMs', 'number'),
						);
					case 'types':
						return await single(state, { ...base(0), rich: richValues() }, param(c.params, 'waitMs', 'number'));
					case 'mutate': {
						const payload: JobPayload = { ...base(0), mark: 'at-submit' };
						return await single(state, payload, param(c.params, 'waitMs', 'number'), undefined, () => {
							payload.mark = 'mutated-after-submit';
						});
					}
					case 'delay':
						return await single(
							state,
							base(0),
							param(c.params, 'waitMs', 'number'),
							param(c.params, 'delaySeconds', 'number'),
						);
					case 'retry':
						return await single(
							state,
							{ ...base(0), failTimes: param(c.params, 'failTimes', 'number') },
							param(c.params, 'waitMs', 'number'),
						);
					case 'order': {
						state.pending = true;
						for (let slot = 0; slot < state.slots; slot++) await job.submit(base(slot));
						const recs = await firstDeliveries(state, param(c.params, 'waitMs', 'number'));
						const order = recs
							.map((r, i) => ({ at: r.at, slot: i }))
							.sort((a, b) => a.at - b.at || a.slot - b.slot)
							.map((r) => r.slot);
						return {
							ran: recs.length,
							of: state.slots,
							startOrder: recs.length === state.slots ? order.join('') : null,
							inOrder: recs.length === state.slots ? order.every((s, i) => s === i) : null,
						};
					}
					case 'batch': {
						const padBytes = param(c.params, 'padBytes', 'number');
						const payloads = Array.from({ length: state.slots }, (_, slot) => ({ ...base(slot), pad: 'x'.repeat(padBytes) }));
						state.pending = true;
						const result = await job.submitBatch(payloads);
						const recs = await firstDeliveries(state, param(c.params, 'waitMs', 'number'));
						const ids = result.jobIds.filter((id): id is string => id !== null);
						return {
							jobIds: ids.length,
							distinctJobIds: new Set(ids).size,
							failed: result.failed.length,
							ran: recs.length,
							allPadsIntact: recs.every((r) => r.padBytes === padBytes),
						};
					}
					case 'cron': {
						const raw = await results.get(CRON_KEY);
						return raw === null ? { ticked: false } : { ticked: true, ...(JSON.parse(raw) as CronRecord) };
					}
					default:
						throw new Error(`unknown job case kind ${kind}`);
				}
			},
			cleanup: async (state) => {
				if (state === undefined) return;
				// Stop any delivery that can still arrive before deleting what has been recorded.
				if (state.pending) await results.put(stopKey(state.run), '1', { ttlSeconds: STOP_TTL_SECONDS });
				const keys = Array.from({ length: state.slots }, (_, slot) =>
					Array.from({ length: MAX_RETRIES }, (_, i) => recordKey(state.run, slot, i + 1)),
				).flat();
				await Promise.all(keys.map((k) => results.delete(k)));
			},
		});
	};
}
