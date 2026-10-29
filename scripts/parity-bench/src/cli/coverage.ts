// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * coverage — functional coverage per Building Block: public methods, the AWS operations and
 * error types behind them, and how much of that the e2e app and the parity cases reach.
 *
 *   tsx src/cli/coverage.ts [--app <test app dir>] [--recordings <dir>]… [--findings <findings.json>] [--out .parity/coverage]
 *
 * The surface is read from `packages/bb-*` source; `--app` adds which methods the app's
 * backend (`<app>/aws-blocks`) calls; each `--recordings` directory (a `parity:local` or
 * `parity:sandbox` run) adds which methods the parity cases called and which AWS errors
 * the deployed cases hit. `--findings` (the differ's `findings.json` from `parity:report`) adds
 * method fidelity: each method rated Full / Partial / None from the comparisons that reached it.
 * Writes `coverage.json` and `coverage.md`.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { attributeFindings, computeCoverage, exercisedEvidence, renderCoverageMarkdown } from '../core/coverage.js';
import type { Finding } from '../core/report.js';
import {
	backendSources,
	blockPackages,
	extractApiMethods,
	extractAppCalls,
	extractSurfaces,
	findRepoRoot,
} from '../surface/extract.js';
import { loadRecordings } from './report.js';

function main(): void {
	const { values } = parseArgs({
		options: {
			app: { type: 'string' },
			recordings: { type: 'string', multiple: true, default: [] },
			findings: { type: 'string' },
			out: { type: 'string', default: '.parity/coverage' },
		},
	});
	const repo = findRepoRoot(fileURLToPath(new URL('.', import.meta.url)));
	const surfaces = extractSurfaces(blockPackages(repo));

	const backend = values.app ? join(resolve(values.app), 'aws-blocks') : undefined;
	const sources = backend && existsSync(backend) ? backendSources(backend) : [];
	const appCalls = extractAppCalls(sources, surfaces, join(repo, 'packages'));

	const recordings = values.recordings.filter((dir) => {
		if (existsSync(dir)) return true;
		console.error(`skipping missing recordings directory ${dir}`);
		return false;
	});
	const evidence = exercisedEvidence(recordings.flatMap(loadRecordings));

	const findingsFile = values.findings && existsSync(values.findings) ? values.findings : undefined;
	if (values.findings && !findingsFile) console.error(`skipping missing findings file ${values.findings}`);
	const comparisons = findingsFile
		? attributeFindings(
				// e2e calls only: the edge cases are adversarial by design and reported separately.
				(JSON.parse(readFileSync(findingsFile, 'utf8')) as Finding[]).filter((f) => f.kind === 'call'),
				extractApiMethods(sources, surfaces, join(repo, 'packages')),
				evidence.casesByMethod,
			)
		: undefined;
	const rows = computeCoverage(surfaces, appCalls, evidence, comparisons);

	mkdirSync(values.out, { recursive: true });
	writeFileSync(join(values.out, 'coverage.json'), `${JSON.stringify({ surfaces, coverage: rows }, null, '\t')}\n`);
	const md = renderCoverageMarkdown(rows, {
		repo: relative(process.cwd(), repo) || '.',
		app: values.app ?? '(none)',
		recordings,
		findings: findingsFile,
	});
	writeFileSync(join(values.out, 'coverage.md'), md);
	console.log(md);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
