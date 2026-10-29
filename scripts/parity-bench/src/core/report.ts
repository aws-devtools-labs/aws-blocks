// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The differ: aligns a local recording with a deployed one and classifies every
 * call, probe and sweep; then renders the per-Building-Block scorecard. Pure —
 * the CLI (`../cli/report.ts`) does the file I/O.
 */

import type { CallRecord, ParityRecord, ProbeRecord, SweepRecord } from './types.js';

export type Verdict =
	| 'same'
	| 'breaks-deployed-only'
	| 'breaks-local-only'
	| 'differs-value'
	| 'differs-error'
	| 'noisy'
	| 'unmatched';

export interface Finding {
	block: string;
	key: string;
	kind: ParityRecord['kind'];
	verdict: Verdict;
	local?: string;
	deployed?: string;
}

/** Normalized, comparable form of one observation. */
interface Observed {
	ok: boolean;
	/** Normalized value (ok) or `{ name, status }` (error). */
	shape: unknown;
	/** Human-readable summary for the report. */
	detail: string;
}

/** Map an e2e suite's top-level describe() name to the Building Block it covers. Unknown suites land in 'other'. */
export type SuiteMapper = (testFullName: string) => string;

export function suiteMapper(table: ReadonlyArray<readonly [RegExp, string]>): SuiteMapper {
	return (test) => table.find(([re]) => re.test(test))?.[1] ?? 'other';
}

function keyOf(r: ParityRecord): string {
	if (r.kind === 'call') return `${r.process} | ${r.test} | #${r.seq} ${r.method}`;
	return `${r.kind} ${r.caseId}`;
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const ISO_TIME = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})?/g;
const URL_RE = /\bhttps?:\/\/[^\s"']+/g;
const LONG_HEX = /\b[0-9a-f]{16,}\b/gi;
const JWT = /\beyJ[\w-]+\.[\w-]+\.[\w-]+/g;

/**
 * Replace values that legitimately differ between two runs — ids, timestamps,
 * URLs, and the call's own generated inputs echoed back — with placeholders.
 */
export function normalize(value: unknown, args: readonly string[]): unknown {
	if (typeof value === 'string') {
		let s = value;
		args.forEach((a, i) => {
			s = s.split(a).join(`<arg${i}>`);
		});
		return s
			.replace(JWT, '<jwt>')
			.replace(URL_RE, '<url>')
			.replace(UUID, '<uuid>')
			.replace(ISO_TIME, '<time>')
			.replace(LONG_HEX, '<hex>');
	}
	if (typeof value === 'number' && value > 1e12 && value < 1e13) return '<epoch-ms>';
	if (Array.isArray(value)) return value.map((v) => normalize(v, args));
	if (value && typeof value === 'object') {
		return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, normalize(v, args)]));
	}
	return value;
}

/** String args long enough to be generated test data (short literals like 'a' would over-match). */
function argStrings(args: readonly unknown[]): string[] {
	return args.filter((a): a is string => typeof a === 'string' && a.length >= 6);
}

function truncate(text: string, n: number): string {
	return text.length > n ? `${text.slice(0, n)}…` : text;
}

function observeCall(r: CallRecord): Observed {
	const outcome = r.outcome;
	if (outcome.ok) {
		const shape = normalize(outcome.value, argStrings(r.args));
		return { ok: true, shape, detail: `ok ${truncate(JSON.stringify(shape) ?? 'undefined', 160)}` };
	}
	const { name, status, message } = outcome.error;
	return {
		ok: false,
		shape: { name, status },
		detail: `error ${name}${status ? ` (${status})` : ''}${message ? `: ${message.slice(0, 120)}` : ''}`,
	};
}

function observeProbe(r: ProbeRecord): Observed {
	const o = r.outcome;
	if (o.status === 'ok') return { ok: true, shape: o.value, detail: `ok ${truncate(JSON.stringify(o.value) ?? '', 160)}` };
	const e = o.error;
	return {
		ok: false,
		shape: { status: o.status, name: e.name, httpStatus: e.httpStatus },
		detail: `${o.status} ${e.name}${e.httpStatus ? ` (${e.httpStatus})` : ''}${e.causeCode ? ` [${e.causeCode}]` : ''}`,
	};
}

/** A sweep "succeeds" when the block never broke inside the range; its shape is the breakpoint plus how it broke. */
function observeSweep(r: SweepRecord): Observed {
	if (r.aborted) return { ok: false, shape: { aborted: true }, detail: `aborted: ${r.aborted}` };
	const how = r.errorAtBreakpoint
		? `${r.errorAtBreakpoint.name}${r.errorAtBreakpoint.causeCode ? ` [${r.errorAtBreakpoint.causeCode}]` : ''}`
		: '';
	const detail =
		r.breakpoint === null
			? `no break up to ${r.max} ${r.unit}`
			: `breaks at ${r.breakpoint} ${r.unit}: ${how}${r.monotonic ? '' : ' (non-monotonic)'}`;
	return {
		ok: r.breakpoint === null,
		shape: { breakpoint: r.breakpoint, name: r.errorAtBreakpoint?.name, httpStatus: r.errorAtBreakpoint?.httpStatus },
		detail,
	};
}

function observe(r: ParityRecord): Observed {
	if (r.kind === 'call') return observeCall(r);
	if (r.kind === 'probe') return observeProbe(r);
	return observeSweep(r);
}

function same(a: Observed, b: Observed): boolean {
	return a.ok === b.ok && JSON.stringify(a.shape) === JSON.stringify(b.shape);
}

function classifySweep(local: SweepRecord, deployed: SweepRecord): Verdict {
	const l = observeSweep(local);
	const d = observeSweep(deployed);
	if (same(l, d)) return 'same';
	if (local.breakpoint === deployed.breakpoint) return 'differs-error';
	// Local keeps succeeding past the point where deployed breaks: code tuned locally fails in production.
	if (deployed.breakpoint !== null && (local.breakpoint === null || local.breakpoint > deployed.breakpoint)) {
		return 'breaks-deployed-only';
	}
	return 'breaks-local-only';
}

function classify(local: ParityRecord, deployed: ParityRecord): Verdict {
	if (local.kind === 'sweep' && deployed.kind === 'sweep') return classifySweep(local, deployed);
	const l = observe(local);
	const d = observe(deployed);
	if (same(l, d)) return 'same';
	if (l.ok && !d.ok) return 'breaks-deployed-only';
	if (!l.ok && d.ok) return 'breaks-local-only';
	return l.ok ? 'differs-value' : 'differs-error';
}

export function diff(
	localRecords: readonly ParityRecord[],
	deployedRecords: readonly ParityRecord[],
	options: { baseline?: readonly ParityRecord[]; blockOfTest?: SuiteMapper } = {},
): Finding[] {
	const byKey = (rs: readonly ParityRecord[]) => new Map(rs.map((r) => [keyOf(r), r]));
	const local = byKey(localRecords);
	const deployed = byKey(deployedRecords);
	const baseline = options.baseline ? byKey(options.baseline) : undefined;
	const blockOf = (r: ParityRecord) => (r.kind === 'call' ? (options.blockOfTest?.(r.test) ?? 'other') : r.block);
	const findings: Finding[] = [];
	for (const key of new Set([...local.keys(), ...deployed.keys()])) {
		const l = local.get(key);
		const d = deployed.get(key);
		const any = (l ?? d) as ParityRecord;
		const base = { block: blockOf(any), key, kind: any.kind };
		if (!l || !d) {
			findings.push({ ...base, verdict: 'unmatched', local: l && observe(l).detail, deployed: d && observe(d).detail });
			continue;
		}
		const b = baseline?.get(key);
		const verdict = b && !same(observe(d), observe(b)) ? 'noisy' : classify(l, d);
		findings.push({ ...base, verdict, local: observe(l).detail, deployed: observe(d).detail });
	}
	return findings;
}

const VERDICT_ORDER: Verdict[] = [
	'breaks-deployed-only',
	'differs-error',
	'differs-value',
	'breaks-local-only',
	'noisy',
	'unmatched',
	'same',
];

const VERDICT_LABEL: Record<Verdict, string> = {
	'breaks-deployed-only': 'SILENT (works locally, fails deployed)',
	'differs-error': 'error shape differs',
	'differs-value': 'value differs',
	'breaks-local-only': 'fails locally only',
	noisy: 'noisy (deployed runs disagree)',
	unmatched: 'unmatched (ran in one env only)',
	same: 'same',
};

/** One markdown table cell: escape backslashes first so `\|` can't be forged, then pipes; fold newlines. */
export const cell = (s?: string) =>
	(s ?? '—').replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');

export function renderMarkdown(
	findings: readonly Finding[],
	meta: { local: string; deployed: string; baseline?: string },
	sweeps: { local: readonly SweepRecord[]; deployed: readonly SweepRecord[] } = { local: [], deployed: [] },
): string {
	const blocks = [...new Set(findings.map((f) => f.block))].sort();
	const count = (fs: readonly Finding[], v: Verdict) => fs.filter((f) => f.verdict === v).length;
	const lines: string[] = [
		'# Parity report — local vs deployed',
		'',
		`local: \`${meta.local}\` · deployed: \`${meta.deployed}\`${meta.baseline ? ` · noise baseline: \`${meta.baseline}\`` : ''}`,
		'',
		'| Block | Compared | Same | Fidelity | Silent | Error shape | Value | Local-only fail | Noisy | Unmatched |',
		'|---|---|---|---|---|---|---|---|---|---|',
	];
	for (const block of blocks) {
		const fs = findings.filter((f) => f.block === block);
		const compared = fs.filter((f) => f.verdict !== 'unmatched' && f.verdict !== 'noisy').length;
		const sameCount = count(fs, 'same');
		const fidelity = compared ? `${Math.round((sameCount / compared) * 100)}%` : '—';
		lines.push(
			`| ${block} | ${compared} | ${sameCount} | ${fidelity} | ${count(fs, 'breaks-deployed-only')} | ${count(fs, 'differs-error')} | ${count(fs, 'differs-value')} | ${count(fs, 'breaks-local-only')} | ${count(fs, 'noisy')} | ${count(fs, 'unmatched')} |`,
		);
	}

	const deployedSweeps = new Map(sweeps.deployed.map((s) => [s.caseId, s]));
	const sweepIds = [...new Set([...sweeps.local.map((s) => s.caseId), ...deployedSweeps.keys()])].sort();
	if (sweepIds.length) {
		const localSweeps = new Map(sweeps.local.map((s) => [s.caseId, s]));
		const point = (s?: SweepRecord) => (!s ? '—' : s.aborted ? 'aborted' : s.breakpoint === null ? `none ≤ ${s.max}` : String(s.breakpoint));
		lines.push('', '## Breakpoints', '', '| Case | Unit | Documented limit | Local breaks at | Deployed breaks at |', '|---|---|---|---|---|');
		for (const id of sweepIds) {
			const l = localSweeps.get(id);
			const d = deployedSweeps.get(id);
			const any = (l ?? d) as SweepRecord;
			lines.push(`| ${cell(id)} | ${any.unit} | ${any.documented ?? '—'} | ${point(l)} | ${point(d)} |`);
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
