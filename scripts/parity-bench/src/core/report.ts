// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The differ: aligns a local recording with a deployed one and classifies every
 * call, HTTP exchange, probe and sweep; then renders the per-Building-Block
 * scorecard. Pure — the CLI (`../cli/report.ts`) does the file I/O.
 *
 * Two successful results are compared in three steps, most severe first:
 * their shape (fields and types, see `./shape.ts`), then their elements in any
 * order, then their normalized values. An HTTP exchange is compared on its edge
 * first: status, app-level headers and cookie attributes.
 */

import { sameIgnoringOrder, shapeDiff, shapeOf } from './shape.js';
import type { CallRecord, HttpRecord, ParityRecord, ProbeRecord, SweepRecord } from './types.js';

export type Verdict =
	| 'same'
	| 'breaks-deployed-only'
	| 'breaks-local-only'
	| 'differs-error'
	| 'differs-http'
	| 'differs-shape'
	| 'differs-order'
	| 'differs-value'
	| 'noisy'
	| 'unmatched';

export interface Finding {
	block: string;
	key: string;
	kind: ParityRecord['kind'];
	verdict: Verdict;
	local?: string;
	deployed?: string;
	/** For `differs-http`: each differing facet as `<facet>: <local> → <deployed>`, for the report's facet summary. */
	facets?: string[];
}

/** Map an e2e suite's top-level describe() name to the Building Block it covers. Unknown suites land in 'other'. */
export type SuiteMapper = (testFullName: string) => string;

export function suiteMapper(table: ReadonlyArray<readonly [RegExp, string]>): SuiteMapper {
	return (test) => table.find(([re]) => re.test(test))?.[1] ?? 'other';
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const ISO_TIME = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})?/g;
const URL_RE = /\b(?:https?|wss?):\/\/[^\s"']+/g;
const LONG_HEX = /\b[0-9a-f]{16,}\b/gi;
const JWT = /\beyJ[\w-]+\.[\w-]+\.[\w-]+/g;
// The recorder keeps a redacted credential's length; tokens differ in length per environment.
const REDACTED_LENGTH = /^<redacted:\d+>$/;
// Crockford base32, as ULIDs (message ids) use it.
const ULID = /\b[0-9A-HJKMNP-TV-Z]{26}\b/g;
// A truncated UUID, as short generated ids use it (`a3e24b3a-295e`).
const UUID_PREFIX = /\b[0-9a-f]{8}(?:-[0-9a-f]{4}){1,3}\b/gi;

/**
 * Replace values that legitimately differ between two runs — ids, timestamps,
 * URLs, and the call's own generated inputs echoed back — with placeholders.
 * `testTokens` are the generated inputs of every call in the same test (an id
 * one call writes comes back from a later call's read); they become `<gen>`.
 * `envPrefixes` are removed outright: the stack-name prefix a deployed resource
 * name carries and the local one doesn't (see `learnEnvPrefixes`).
 */
export function normalize(
	value: unknown,
	args: readonly string[],
	testTokens: readonly string[] = [],
	envPrefixes: readonly string[] = [],
): unknown {
	if (typeof value === 'string') {
		let s = value;
		for (const p of envPrefixes) s = s.split(p).join('');
		args.forEach((a, i) => {
			s = s.split(a).join(`<arg${i}>`);
		});
		for (const t of testTokens) s = s.split(t).join('<gen>');
		return s
			.replace(REDACTED_LENGTH, '<redacted>')
			.replace(JWT, '<jwt>')
			.replace(URL_RE, '<url>')
			.replace(UUID, '<uuid>')
			.replace(UUID_PREFIX, '<uuid>')
			.replace(ISO_TIME, '<time>')
			.replace(ULID, '<ulid>')
			.replace(LONG_HEX, '<hex>');
	}
	if (typeof value === 'number' && value > 1e12 && value < 1e13) return '<epoch-ms>';
	if (Array.isArray(value)) return value.map((v) => normalize(v, args, testTokens, envPrefixes));
	if (value && typeof value === 'object') {
		return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, normalize(v, args, testTokens, envPrefixes)]));
	}
	return value;
}

/** Strings long enough to be generated test data (short literals like 'a' would over-match). */
const isToken = (a: unknown): a is string => typeof a === 'string' && a.length >= 6;

function argStrings(args: readonly unknown[]): string[] {
	return args.filter(isToken);
}

/** Every token-like string anywhere in `args`, nested objects included. */
function collectTokens(value: unknown, into: Set<string>): void {
	if (isToken(value)) into.add(value);
	else if (Array.isArray(value)) for (const v of value) collectTokens(v, into);
	else if (value && typeof value === 'object') for (const v of Object.values(value)) collectTokens(v, into);
}

function truncate(text: string, n: number): string {
	return text.length > n ? `${text.slice(0, n)}…` : text;
}

const json = (v: unknown) => JSON.stringify(v) ?? 'undefined';

/** `json` with object keys sorted: key order carries no meaning in a JSON result (array order does). */
function stableJson(value: unknown): string {
	const sortKeys = (v: unknown): unknown => {
		if (Array.isArray(v)) return v.map(sortKeys);
		if (v && typeof v === 'object') {
			return Object.fromEntries(
				Object.keys(v)
					.sort()
					.map((k) => [k, sortKeys((v as Record<string, unknown>)[k])]),
			);
		}
		return v;
	};
	return json(sortKeys(value));
}

// ── Alignment ────────────────────────────────────────────────────────────────

/** One aligned observation: the record compared, and how many identical requests of one poll loop it stands for. */
interface Aligned {
	record: ParityRecord;
	count: number;
	/** Generated inputs of the record's whole test, for `normalize`. */
	tokens: readonly string[];
	/** Environment prefixes to strip, for `normalize`; set on the deployed side by `diff`. */
	prefixes: readonly string[];
}

/**
 * Index records by a key both environments produce for the same observation.
 *
 * Calls and HTTP exchanges are keyed per test by what was called and its
 * ordinal among calls of the same thing — not by the test's global call
 * counter, so one extra call no longer shifts every later call.
 *
 * Poll loops collapse into one observation that keeps the last outcome, so a
 * deployed run that polls twelve times where the local one polls once still
 * lines up. A poll loop is a run of calls to one method with nothing else in
 * between; inside it, repeats of the same arguments join their first call, so
 * a loop polling several jobs in turn (`get(a)`, `get(b)`, `get(a)`, …) still
 * yields one observation per job. A call to anything else ends the loop: in
 * `get(x)`, `delete(x)`, `get(x)` both reads are compared.
 */
function align(records: readonly ParityRecord[]): Map<string, Aligned> {
	const out = new Map<string, Aligned>();
	const streams = new Map<string, (CallRecord | HttpRecord)[]>();
	const testTokens = new Map<string, Set<string>>();
	const testOf = (r: CallRecord | HttpRecord) => `${r.process}\u0000${r.test}`;
	for (const r of records) {
		if (r.kind === 'call' || r.kind === 'http') {
			const stream = `${r.kind}\u0000${testOf(r)}`;
			const list = streams.get(stream);
			if (list) list.push(r);
			else streams.set(stream, [r]);
			const tokens = testTokens.get(testOf(r)) ?? new Set<string>();
			collectTokens(r.kind === 'call' ? r.args : r.params, tokens);
			testTokens.set(testOf(r), tokens);
		} else {
			out.set(`${r.kind} ${r.caseId}`, { record: r, count: 1, tokens: [], prefixes: [] });
		}
	}
	for (const list of streams.values()) {
		list.sort((a, b) => a.seq - b.seq);
		// Longest first, so a token that contains another is replaced whole.
		const tokens = [...(testTokens.get(testOf(list[0])) ?? [])].sort((a, b) => b.length - a.length);
		const ordinals = new Map<string, number>();
		let loopLabel: string | undefined;
		let loop = new Map<string, Aligned>();
		for (const r of list) {
			const label = r.kind === 'call' ? r.method : `http ${r.method} ${r.route}`;
			const identity = r.kind === 'call' ? json(r.args) : r.requestKey;
			if (label !== loopLabel) {
				loopLabel = label;
				loop = new Map();
			}
			const seen = loop.get(identity);
			if (seen) {
				seen.record = r;
				seen.count++;
				continue;
			}
			const n = (ordinals.get(label) ?? 0) + 1;
			ordinals.set(label, n);
			const aligned: Aligned = { record: r, count: 1, tokens, prefixes: [] };
			loop.set(identity, aligned);
			out.set(`${r.process} | ${r.test} | ${label}${n > 1 ? ` #${n}` : ''}`, aligned);
		}
	}
	return out;
}

/** A learned prefix must end at a separator (`bb-test-x1y2-`), so `ab` + `c` never counts. */
const PREFIX_SHAPE = /^[\w.-]{4,}[-_./:]$/;
/** How many value pairs must agree on a prefix before it is treated as the environment's. */
const PREFIX_MIN_EVIDENCE = 2;

/**
 * Learn the strings a deployed environment puts in front of names the local
 * one returns bare — the stack-name prefix of deployed resource names
 * (`bb-test-alice-k8g-test-app-cron` vs `test-app-cron`). Walks aligned value
 * pairs in parallel, after normalizing generated inputs (so the per-run part of
 * a name doesn't hide the shared suffix); a prefix counts once it explains at
 * least two pairs.
 */
function learnEnvPrefixes(pairs: ReadonlyArray<readonly [Aligned, Aligned]>): string[] {
	const evidence = new Map<string, number>();
	const walk = (l: unknown, d: unknown) => {
		if (typeof l === 'string' && typeof d === 'string') {
			if (l.length >= 4 && d.length > l.length && d.endsWith(l)) {
				const prefix = d.slice(0, d.length - l.length);
				if (PREFIX_SHAPE.test(prefix)) evidence.set(prefix, (evidence.get(prefix) ?? 0) + 1);
			}
		} else if (Array.isArray(l) && Array.isArray(d)) {
			for (let i = 0; i < Math.min(l.length, d.length); i++) walk(l[i], d[i]);
		} else if (l && d && typeof l === 'object' && typeof d === 'object') {
			for (const k of Object.keys(l)) if (k in d) walk((l as Record<string, unknown>)[k], (d as Record<string, unknown>)[k]);
		}
	};
	for (const [l, d] of pairs) walk(observe(l).value?.normalized, observe(d).value?.normalized);
	return [...evidence]
		.filter(([, n]) => n >= PREFIX_MIN_EVIDENCE)
		.map(([p]) => p)
		.sort((a, b) => b.length - a.length);
}

// ── Observation and comparison ───────────────────────────────────────────────

/** Normalized, comparable form of one observation. */
interface Observed {
	ok: boolean;
	/** Comparable form: two observations are the same when these serialize identically. */
	cmp: unknown;
	/** The successful value as recorded (for the shape check) and normalized (for the order check). */
	value?: { raw: unknown; normalized: unknown };
	/** Human-readable summary for the report. */
	detail: string;
}

function observeCall(r: CallRecord, tokens: readonly string[], prefixes: readonly string[]): Observed {
	const outcome = r.outcome;
	if (outcome.ok) {
		const normalized = normalize(outcome.value, argStrings(r.args), tokens, prefixes);
		return {
			ok: true,
			cmp: normalized,
			value: { raw: outcome.value, normalized },
			detail: `ok ${truncate(json(normalized), 160)}`,
		};
	}
	const { name, status, message } = outcome.error;
	return {
		ok: false,
		cmp: { name, status },
		detail: `error ${name}${status ? ` (${status})` : ''}${message ? `: ${message.slice(0, 120)}` : ''}`,
	};
}

function observeProbe(r: ProbeRecord): Observed {
	const o = r.outcome;
	if (o.status === 'ok') {
		const normalized = normalize(o.value, []);
		return { ok: true, cmp: normalized, value: { raw: o.value, normalized }, detail: `ok ${truncate(json(normalized), 160)}` };
	}
	const e = o.error;
	return {
		ok: false,
		cmp: { status: o.status, name: e.name, httpStatus: e.httpStatus },
		detail: `${o.status} ${e.name}${e.httpStatus ? ` (${e.httpStatus})` : ''}${e.causeCode ? ` [${e.causeCode}]` : ''}`,
	};
}

/** A sweep "succeeds" when the block never broke inside the range; its shape is the breakpoint plus how it broke. */
function observeSweep(r: SweepRecord): Observed {
	if (r.aborted) return { ok: false, cmp: { aborted: true }, detail: `aborted: ${r.aborted}` };
	const how = r.errorAtBreakpoint
		? `${r.errorAtBreakpoint.name}${r.errorAtBreakpoint.causeCode ? ` [${r.errorAtBreakpoint.causeCode}]` : ''}`
		: '';
	const detail =
		r.breakpoint === null
			? `no break up to ${r.max} ${r.unit}`
			: `breaks at ${r.breakpoint} ${r.unit}: ${how}${r.monotonic ? '' : ' (non-monotonic)'}`;
	return {
		ok: r.breakpoint === null,
		cmp: { breakpoint: r.breakpoint, name: r.errorAtBreakpoint?.name, httpStatus: r.errorAtBreakpoint?.httpStatus },
		detail,
	};
}

/**
 * The edge of an exchange as named facets: `status`, `header <name>`, `cookie <name>`.
 * Cookie names carry the auth block's resource id or a name the test generated, so the
 * deployed stack prefix and the test's generated inputs are normalized in them too.
 */
function httpFacets(r: HttpRecord, prefixes: readonly string[], tokens: readonly string[]): Record<string, string> {
	const strip = (s: string) =>
		tokens.reduce((acc, t) => acc.split(t).join('<gen>'), prefixes.reduce((acc, p) => acc.split(p).join(''), s));
	const facets: Record<string, string> = { status: r.status === null ? `failed ${r.error ?? ''}`.trim() : String(r.status) };
	for (const [k, v] of Object.entries(r.headers)) facets[`header ${k}`] = strip(v);
	for (const [k, v] of Object.entries(r.cookies)) facets[`cookie ${strip(k)}`] = v;
	return facets;
}

const httpOk = (r: HttpRecord) => r.status !== null && r.status < 400;

function observeHttp(r: HttpRecord, tokens: readonly string[], prefixes: readonly string[]): Observed {
	const normalized = normalize(r.body, [], tokens, prefixes);
	return {
		ok: httpOk(r),
		cmp: { facets: httpFacets(r, prefixes, tokens), body: normalized },
		...(r.body === undefined ? {} : { value: { raw: r.body, normalized } }),
		detail:
			(r.status === null ? `failed ${r.error ?? ''}`.trim() : String(r.status)) +
			(r.body === undefined ? '' : ` ${truncate(json(normalized), 160)}`),
	};
}

function observe({ record: r, tokens, prefixes }: Aligned): Observed {
	if (r.kind === 'call') return observeCall(r, tokens, prefixes);
	if (r.kind === 'probe') return observeProbe(r);
	if (r.kind === 'http') return observeHttp(r, tokens, prefixes);
	return observeSweep(r);
}

interface Comparison {
	verdict: Verdict;
	local: string;
	deployed: string;
	facets?: string[];
}

const SHAPE_PATHS_SHOWN = 4;

/** Two successful values: same, or differing in shape, element order, or value (most severe first). */
function compareValues(l: Observed, d: Observed): Comparison {
	const lv = l.value;
	const dv = d.value;
	if (lv && dv) {
		const paths = shapeDiff(shapeOf(lv.raw), shapeOf(dv.raw));
		if (paths.length) {
			const shown = paths.slice(0, SHAPE_PATHS_SHOWN);
			const more = paths.length > SHAPE_PATHS_SHOWN ? ` (+${paths.length - SHAPE_PATHS_SHOWN} more)` : '';
			return {
				verdict: 'differs-shape',
				local: shown.map((p) => `${p.path}: ${p.local}`).join('; ') + more,
				deployed: shown.map((p) => `${p.path}: ${p.deployed}`).join('; ') + more,
			};
		}
		if (sameIgnoringOrder(lv.normalized, dv.normalized)) return { verdict: 'differs-order', local: l.detail, deployed: d.detail };
	}
	return { verdict: 'differs-value', local: l.detail, deployed: d.detail };
}

function compareSweep(local: SweepRecord, deployed: SweepRecord): Verdict {
	const l = observeSweep(local);
	const d = observeSweep(deployed);
	if (stableJson(l.cmp) === stableJson(d.cmp)) return 'same';
	if (local.breakpoint === deployed.breakpoint) return 'differs-error';
	// Local keeps succeeding past the point where deployed breaks: code tuned locally fails in production.
	if (deployed.breakpoint !== null && (local.breakpoint === null || local.breakpoint > deployed.breakpoint)) {
		return 'breaks-deployed-only';
	}
	return 'breaks-local-only';
}

/** An exchange's edge first (status, headers, cookies), then its JSON body like any other value. */
function compareHttp(la: Aligned, local: HttpRecord, da: Aligned, deployed: HttpRecord): Comparison {
	const l = observe(la);
	const d = observe(da);
	const lf = httpFacets(local, la.prefixes, la.tokens);
	const df = httpFacets(deployed, da.prefixes, da.tokens);
	const differing = [...new Set([...Object.keys(lf), ...Object.keys(df)])].filter((k) => lf[k] !== df[k]).sort();
	if (l.ok !== d.ok) return { verdict: l.ok ? 'breaks-deployed-only' : 'breaks-local-only', local: l.detail, deployed: d.detail };
	if (differing.length) {
		const side = (f: Record<string, string>) => differing.map((k) => `${k}: ${f[k] ?? '—'}`).join('; ');
		return {
			verdict: !l.ok && differing.includes('status') ? 'differs-error' : 'differs-http',
			local: side(lf),
			deployed: side(df),
			facets: differing.map((k) => `${k}: ${lf[k] ?? '—'} → ${df[k] ?? '—'}`),
		};
	}
	if (stableJson(l.cmp) === stableJson(d.cmp)) return { verdict: 'same', local: l.detail, deployed: d.detail };
	return compareValues(l, d);
}

function compare(la: Aligned, da: Aligned): Comparison {
	const local = la.record;
	const deployed = da.record;
	if (local.kind === 'sweep' && deployed.kind === 'sweep') {
		return { verdict: compareSweep(local, deployed), local: observeSweep(local).detail, deployed: observeSweep(deployed).detail };
	}
	if (local.kind === 'http' && deployed.kind === 'http') return compareHttp(la, local, da, deployed);
	const l = observe(la);
	const d = observe(da);
	if (l.ok === d.ok && stableJson(l.cmp) === stableJson(d.cmp)) return { verdict: 'same', local: l.detail, deployed: d.detail };
	if (l.ok && !d.ok) return { verdict: 'breaks-deployed-only', local: l.detail, deployed: d.detail };
	if (!l.ok && d.ok) return { verdict: 'breaks-local-only', local: l.detail, deployed: d.detail };
	if (!l.ok) return { verdict: 'differs-error', local: l.detail, deployed: d.detail };
	return compareValues(l, d);
}

/**
 * Classify every observation of a local recording against a deployed one.
 *
 * Noise baselines: `baseline` is a second deployed recording, `localBaseline` a
 * second local one (cheap: no deploy). An observation whose two runs in either
 * environment disagree is `noisy` and doesn't count — it varies run to run
 * (server-generated secrets, model output, timing), so a difference across
 * environments says nothing about parity.
 */
export function diff(
	localRecords: readonly ParityRecord[],
	deployedRecords: readonly ParityRecord[],
	options: { baseline?: readonly ParityRecord[]; localBaseline?: readonly ParityRecord[]; blockOfTest?: SuiteMapper } = {},
): Finding[] {
	const local = align(localRecords);
	const deployed = align(deployedRecords);
	const deployedAgain = options.baseline ? align(options.baseline) : undefined;
	const prefixes = learnEnvPrefixes(
		[...local].flatMap(([key, l]) => {
			const d = deployed.get(key);
			return d ? [[l, d] as const] : [];
		}),
	);
	for (const run of [deployed, deployedAgain]) for (const a of run?.values() ?? []) a.prefixes = prefixes;
	const baselines = [
		[deployed, deployedAgain],
		[local, options.localBaseline ? align(options.localBaseline) : undefined],
	] as const;
	const noisy = (key: string) =>
		baselines.some(([run, again]) => {
			const a = run.get(key);
			const b = again?.get(key);
			return a && b && compare(a, b).verdict !== 'same';
		});
	const blockOf = (r: ParityRecord) =>
		r.kind === 'call' || r.kind === 'http' ? (options.blockOfTest?.(r.test) ?? 'other') : r.block;
	// A collapsed poll loop says how many requests it stood for when the two environments needed different numbers.
	const times = (a: Aligned, other: Aligned) => (a.count !== other.count ? ` [×${a.count}]` : '');
	const findings: Finding[] = [];
	for (const key of new Set([...local.keys(), ...deployed.keys()])) {
		const l = local.get(key);
		const d = deployed.get(key);
		const any = (l ?? d) as Aligned;
		const base = { block: blockOf(any.record), key, kind: any.record.kind };
		if (!l || !d) {
			findings.push({
				...base,
				verdict: 'unmatched',
				local: l && observe(l).detail,
				deployed: d && observe(d).detail,
			});
			continue;
		}
		const c = compare(l, d);
		const verdict = noisy(key) ? 'noisy' : c.verdict;
		findings.push({
			...base,
			verdict,
			local: c.local + times(l, d),
			deployed: c.deployed + times(d, l),
			...(verdict === 'differs-http' && c.facets ? { facets: c.facets } : {}),
		});
	}
	return findings;
}

// ── Rendering ────────────────────────────────────────────────────────────────

const VERDICT_ORDER: Verdict[] = [
	'breaks-deployed-only',
	'differs-error',
	'differs-http',
	'differs-shape',
	'differs-order',
	'differs-value',
	'breaks-local-only',
	'noisy',
	'unmatched',
	'same',
];

const VERDICT_LABEL: Record<Verdict, string> = {
	'breaks-deployed-only': 'SILENT (works locally, fails deployed)',
	'differs-error': 'error shape differs',
	'differs-http': 'HTTP edge differs (status, headers, cookies)',
	'differs-shape': 'result shape differs (fields, types)',
	'differs-order': 'order differs (same elements)',
	'differs-value': 'value differs',
	'breaks-local-only': 'fails locally only',
	noisy: 'noisy (deployed runs disagree)',
	unmatched: 'unmatched (ran in one env only)',
	same: 'same',
};

/** Scorecard columns after Compared/Same/Fidelity, in report order. */
const COUNTED: ReadonlyArray<readonly [Verdict, string]> = [
	['breaks-deployed-only', 'Silent'],
	['differs-error', 'Error shape'],
	['differs-http', 'HTTP edge'],
	['differs-shape', 'Shape'],
	['differs-order', 'Order'],
	['differs-value', 'Value'],
	['breaks-local-only', 'Local-only fail'],
	['noisy', 'Noisy'],
	['unmatched', 'Unmatched'],
];

/** One markdown table cell: escape backslashes first so `\|` can't be forged, then pipes; fold newlines. */
export const cell = (s?: string) =>
	(s ?? '—').replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');

function scorecardRow(label: string, fs: readonly Finding[]): string {
	const compared = fs.filter((f) => f.verdict !== 'unmatched' && f.verdict !== 'noisy').length;
	const same = fs.filter((f) => f.verdict === 'same').length;
	const fidelity = compared ? `${Math.round((same / compared) * 100)}%` : '—';
	const counts = COUNTED.map(([v]) => fs.filter((f) => f.verdict === v).length);
	return `| ${cell(label)} | ${compared} | ${same} | ${fidelity} | ${counts.join(' | ')} |`;
}

function scorecardHeader(first: string): string[] {
	const names = [first, 'Compared', 'Same', 'Fidelity', ...COUNTED.map(([, name]) => name)];
	return [`| ${names.join(' | ')} |`, `|${names.map(() => '---|').join('')}`];
}

export function renderMarkdown(
	findings: readonly Finding[],
	meta: { local: string; deployed: string; baseline?: string; localBaseline?: string },
	sweeps: { local: readonly SweepRecord[]; deployed: readonly SweepRecord[] } = { local: [], deployed: [] },
): string {
	const blocks = [...new Set(findings.map((f) => f.block))].sort();
	const baselines = [
		meta.baseline ? ` · deployed noise baseline: \`${meta.baseline}\`` : '',
		meta.localBaseline ? ` · local noise baseline: \`${meta.localBaseline}\`` : '',
	].join('');
	const lines: string[] = [
		'# Parity report — local vs deployed',
		'',
		`local: \`${meta.local}\` · deployed: \`${meta.deployed}\`${baselines}`,
		'',
		...scorecardHeader('Block'),
	];
	for (const block of blocks) lines.push(scorecardRow(block, findings.filter((f) => f.block === block)));

	const kinds = [...new Set(findings.map((f) => f.kind))].sort();
	lines.push('', '## By source', '', ...scorecardHeader('Source'));
	for (const kind of kinds) lines.push(scorecardRow(kind, findings.filter((f) => f.kind === kind)));

	const deployedSweeps = new Map(sweeps.deployed.map((s) => [s.caseId, s]));
	const sweepIds = [...new Set([...sweeps.local.map((s) => s.caseId), ...deployedSweeps.keys()])].sort();
	if (sweepIds.length) {
		const localSweeps = new Map(sweeps.local.map((s) => [s.caseId, s]));
		const point = (s?: SweepRecord) =>
			!s ? '—' : s.aborted ? 'aborted' : s.breakpoint === null ? `none ≤ ${s.max}` : String(s.breakpoint);
		lines.push('', '## Breakpoints', '', '| Case | Unit | Documented limit | Local breaks at | Deployed breaks at |', '|---|---|---|---|---|');
		for (const id of sweepIds) {
			const l = localSweeps.get(id);
			const d = deployedSweeps.get(id);
			const any = (l ?? d) as SweepRecord;
			lines.push(`| ${cell(id)} | ${any.unit} | ${any.documented ?? '—'} | ${point(l)} | ${point(d)} |`);
		}
	}

	// The same header or cookie difference usually repeats on every request of a route kind; count it once.
	const facetCounts = new Map<string, { count: number; example: string }>();
	for (const f of findings) {
		for (const facet of f.facets ?? []) {
			const seen = facetCounts.get(facet);
			if (seen) seen.count++;
			else facetCounts.set(facet, { count: 1, example: f.key });
		}
	}
	if (facetCounts.size) {
		lines.push('', '## HTTP edge differences by facet', '', '| Facet: local → deployed | Exchanges | Example |', '|---|---|---|');
		for (const [facet, { count, example }] of [...facetCounts].sort((a, b) => b[1].count - a[1].count)) {
			lines.push(`| ${cell(facet)} | ${count} | ${cell(example)} |`);
		}
	}

	for (const block of blocks) {
		const fs = findings
			.filter((f) => f.block === block && f.verdict !== 'same' && f.verdict !== 'unmatched')
			.sort((a, b) => VERDICT_ORDER.indexOf(a.verdict) - VERDICT_ORDER.indexOf(b.verdict));
		if (!fs.length) continue;
		lines.push('', `## ${block}`, '', '| Verdict | Case / call | Local | Deployed |', '|---|---|---|---|');
		for (const f of fs) lines.push(`| ${VERDICT_LABEL[f.verdict]} | ${cell(f.key)} | ${cell(f.local)} | ${cell(f.deployed)} |`);
	}
	return `${lines.join('\n')}\n`;
}
