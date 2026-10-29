// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Functional coverage per Building Block: how much of what a block exposes, and of the AWS
 * surface behind it, the e2e app and the parity bench actually reach. Pure, no I/O: the
 * surface comes from `../surface/extract.ts`, the exercised methods from recordings.
 */

import type { ParityRecord } from './types.js';
import { cell } from './report.js';

/** One AWS API operation a block can send, with the error types the SDK declares for it. */
export interface AwsOperation {
	/** `<service>:<Operation>`, e.g. `dynamodb:PutItem`. */
	id: string;
	service: string;
	operation: string;
	errors: string[];
}

export interface BlockMethod {
	/** `<BB_NAME>.<method>`, e.g. `KVStore.put` — the key `trackBlock` records. */
	name: string;
	/** Ids of the AWS operations reachable from the method body. */
	operations: string[];
}

export interface BlockSurface {
	/** Package directory name, e.g. `bb-kv-store`. */
	block: string;
	/** The package's `BB_NAME`, the prefix of every method key. */
	bbName: string;
	/** The exported constructors the methods come from. */
	classes: string[];
	methods: BlockMethod[];
	operations: Record<string, AwsOperation>;
}

export interface MethodCoverage {
	name: string;
	operations: string[];
	calledByApp: boolean;
	/** Ids of the parity cases that called the method. */
	cases: string[];
}

export interface BlockCoverage {
	block: string;
	methods: MethodCoverage[];
	operations: string[];
	/** Every error type the SDK declares across the block's operations. */
	errorTypes: string[];
	/** Those error types a deployed parity case actually hit. */
	errorsSeen: string[];
}

/** Which parity cases called which block methods, and which error names they hit, from recordings. */
export interface ExercisedEvidence {
	casesByMethod: ReadonlyMap<string, readonly string[]>;
	/** Error names per block, from deployed probe and slider records only (local errors are the mock's). */
	deployedErrorsByBlock: ReadonlyMap<string, ReadonlySet<string>>;
}

/** Collect the evidence from recordings (any mix of environments). */
export function exercisedEvidence(records: Iterable<ParityRecord>): ExercisedEvidence {
	const casesByMethod = new Map<string, Set<string>>();
	const deployedErrorsByBlock = new Map<string, Set<string>>();
	for (const r of records) {
		if (r.kind !== 'probe' && r.kind !== 'sweep') continue;
		for (const m of r.methods ?? []) {
			if (!casesByMethod.has(m)) casesByMethod.set(m, new Set());
			casesByMethod.get(m)?.add(r.caseId);
		}
		if (r.env === 'local') continue;
		const name =
			r.kind === 'probe' ? (r.outcome.status === 'error' ? r.outcome.error.name : undefined) : r.errorAtBreakpoint?.name;
		if (name) {
			if (!deployedErrorsByBlock.has(r.block)) deployedErrorsByBlock.set(r.block, new Set());
			deployedErrorsByBlock.get(r.block)?.add(name);
		}
	}
	return {
		casesByMethod: new Map([...casesByMethod].map(([m, cases]) => [m, [...cases].sort()])),
		deployedErrorsByBlock,
	};
}

export function computeCoverage(
	surfaces: readonly BlockSurface[],
	appCalls: ReadonlySet<string>,
	evidence: ExercisedEvidence,
): BlockCoverage[] {
	return surfaces.map((s) => {
		const errorTypes = [...new Set(Object.values(s.operations).flatMap((op) => op.errors))].sort();
		const seen = evidence.deployedErrorsByBlock.get(s.block) ?? new Set<string>();
		return {
			block: s.block,
			methods: s.methods.map((m) => ({
				name: m.name,
				operations: m.operations,
				calledByApp: appCalls.has(m.name),
				cases: [...(evidence.casesByMethod.get(m.name) ?? [])],
			})),
			operations: Object.keys(s.operations).sort(),
			errorTypes,
			errorsSeen: errorTypes.filter((e) => seen.has(e)),
		};
	});
}

/** `n (p%)` of `total`, or `—` when there is nothing to cover. */
function share(n: number, total: number): string {
	if (!total) return '—';
	const pct = (100 * n) / total;
	return `${n} (${pct > 0 && pct < 1 ? '<1' : Math.round(pct)}%)`;
}

export function renderCoverageMarkdown(rows: readonly BlockCoverage[], meta: { repo: string; app: string; recordings: readonly string[] }): string {
	const sum = (f: (r: BlockCoverage) => number) => rows.reduce((n, r) => n + f(r), 0);
	const inApp = (r: BlockCoverage) => r.methods.filter((m) => m.calledByApp).length;
	const inCases = (r: BlockCoverage) => r.methods.filter((m) => m.cases.length).length;
	const lines: string[] = [
		'# Functional coverage — per Building Block',
		'',
		`repo: \`${meta.repo}\` · app: \`${meta.app}\` · recordings: ${meta.recordings.length ? meta.recordings.map((r) => `\`${r}\``).join(', ') : 'none (edge-case columns are empty)'}`,
		'',
		'| Block | Public methods | Called by the e2e app | Hit by edge cases | AWS operations | AWS error types | Hit on AWS |',
		'|---|---|---|---|---|---|---|',
	];
	for (const r of rows) {
		const n = r.methods.length;
		lines.push(
			`| ${r.block} | ${n} | ${share(inApp(r), n)} | ${share(inCases(r), n)} | ${r.operations.length || '—'} | ${r.errorTypes.length || '—'} | ${share(r.errorsSeen.length, r.errorTypes.length)} |`,
		);
	}
	const n = sum((r) => r.methods.length);
	const errs = sum((r) => r.errorTypes.length);
	lines.push(
		`| **All blocks** | **${n}** | **${share(sum(inApp), n)}** | **${share(sum(inCases), n)}** | **${sum((r) => r.operations.length)}** | **${errs}** | **${share(sum((r) => r.errorsSeen.length), errs)}** |`,
		'',
		'**Public methods**: public instance methods of the classes each block exports from its AWS runtime entry.',
		'**Called by the e2e app**: a call site in the app backend. **Hit by edge cases**: a parity case called it, from the recordings.',
		'**AWS operations / error types**: the SDK commands reachable from those methods and the errors the SDK declares for them;',
		'**Hit on AWS** counts the ones a deployed edge case actually raised (a block that rebrands an AWS error is not counted).',
		'',
		'## Gaps',
		'',
	);
	for (const r of rows) {
		const untested = r.methods.filter((m) => !m.calledByApp && !m.cases.length).map((m) => m.name);
		const noCases = r.methods.filter((m) => m.calledByApp && !m.cases.length).map((m) => m.name);
		if (!untested.length && !noCases.length) continue;
		lines.push(`### ${r.block}`, '');
		if (untested.length) lines.push(`- **Not exercised at all:** ${untested.map((m) => `\`${m}\``).join(', ')}`);
		if (noCases.length) lines.push(`- **No edge case yet:** ${noCases.map((m) => `\`${m}\``).join(', ')}`);
		lines.push('');
	}
	lines.push('## Methods', '');
	for (const r of rows) {
		if (!r.methods.length) continue;
		lines.push(`### ${r.block}`, '', '| Method | e2e app | Edge cases | AWS operations |', '|---|---|---|---|');
		for (const m of r.methods) {
			lines.push(
				`| \`${m.name}\` | ${m.calledByApp ? '✓' : '—'} | ${m.cases.length || '—'} | ${cell(m.operations.join(', ') || '—')} |`,
			);
		}
		lines.push('');
	}
	return `${lines.join('\n')}\n`;
}
