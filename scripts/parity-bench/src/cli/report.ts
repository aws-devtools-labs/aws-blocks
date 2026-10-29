// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * parity report — diff a local recording against a deployed one and write the scorecard.
 *
 *   parity-report --local .parity/local --deployed .parity/sandbox \
 *     [--baseline .parity/sandbox-2] [--out .parity/report] [--suites <module exporting SUITE_BLOCKS>]
 *
 * `--baseline` is a second deployed recording: anything whose two deployed runs
 * disagree is noise (eventual consistency, timing) and is excluded from the diff.
 * `--suites` maps the stack's e2e describe() names to blocks (default: the
 * comprehensive app's mapping in ../suites.ts).
 */

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { diff, renderMarkdown, suiteMapper } from '../core/report.js';
import type { ParityRecord, SweepRecord } from '../core/types.js';
import { COMPREHENSIVE_SUITE_BLOCKS } from '../suites.js';

export function loadRecordings(dir: string): ParityRecord[] {
	return readdirSync(dir)
		.filter((f) => f.endsWith('.jsonl'))
		.flatMap((f) =>
			readFileSync(join(dir, f), 'utf8')
				.split('\n')
				.filter(Boolean)
				.map((line) => JSON.parse(line) as ParityRecord),
		);
}

async function main(): Promise<void> {
	const { values } = parseArgs({
		options: {
			local: { type: 'string' },
			deployed: { type: 'string' },
			baseline: { type: 'string' },
			out: { type: 'string', default: '.parity/report' },
			suites: { type: 'string' },
		},
	});
	if (!values.local || !values.deployed) {
		console.error('usage: parity-report --local <dir> --deployed <dir> [--baseline <dir>] [--out <dir>] [--suites <module>]');
		process.exit(2);
	}
	let table = COMPREHENSIVE_SUITE_BLOCKS;
	if (values.suites) {
		const path = isAbsolute(values.suites) ? values.suites : resolve(values.suites);
		table = (await import(pathToFileURL(path).href)).SUITE_BLOCKS;
	}
	const local = loadRecordings(values.local);
	const deployed = loadRecordings(values.deployed);
	const findings = diff(local, deployed, {
		baseline: values.baseline ? loadRecordings(values.baseline) : undefined,
		blockOfTest: suiteMapper(table),
	});
	const sweeps = (rs: ParityRecord[]) => rs.filter((r): r is SweepRecord => r.kind === 'sweep');
	mkdirSync(values.out, { recursive: true });
	writeFileSync(join(values.out, 'findings.json'), `${JSON.stringify(findings, null, 2)}\n`);
	const md = renderMarkdown(
		findings,
		{ local: values.local, deployed: values.deployed, baseline: values.baseline },
		{ local: sweeps(local), deployed: sweeps(deployed) },
	);
	writeFileSync(join(values.out, 'report.md'), md);
	console.log(md);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
