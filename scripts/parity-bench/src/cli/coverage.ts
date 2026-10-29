// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * coverage — functional coverage per Building Block: public methods, the AWS operations and
 * error types behind them, and how much of that the e2e app and the parity cases reach.
 *
 *   tsx src/cli/coverage.ts [--app <test app dir>] [--recordings <dir>]… [--out .parity/coverage]
 *
 * The surface is read from `packages/bb-*` source; `--app` adds which methods the app's
 * backend (`<app>/aws-blocks`) calls; each `--recordings` directory (a `parity:local` or
 * `parity:sandbox` run) adds which methods the parity cases called and which AWS errors
 * the deployed cases hit. Writes `coverage.json` and `coverage.md`.
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { computeCoverage, exercisedEvidence, renderCoverageMarkdown } from '../core/coverage.js';
import { backendSources, blockPackages, extractAppCalls, extractSurfaces, findRepoRoot } from '../surface/extract.js';
import { loadRecordings } from './report.js';

function main(): void {
	const { values } = parseArgs({
		options: {
			app: { type: 'string' },
			recordings: { type: 'string', multiple: true, default: [] },
			out: { type: 'string', default: '.parity/coverage' },
		},
	});
	const repo = findRepoRoot(fileURLToPath(new URL('.', import.meta.url)));
	const surfaces = extractSurfaces(blockPackages(repo));

	const backend = values.app ? join(resolve(values.app), 'aws-blocks') : undefined;
	const appCalls =
		backend && existsSync(backend)
			? extractAppCalls(backendSources(backend), surfaces, join(repo, 'packages'))
			: new Set<string>();

	const recordings = values.recordings.filter((dir) => {
		if (existsSync(dir)) return true;
		console.error(`skipping missing recordings directory ${dir}`);
		return false;
	});
	const evidence = exercisedEvidence(recordings.flatMap(loadRecordings));
	const rows = computeCoverage(surfaces, appCalls, evidence);

	mkdirSync(values.out, { recursive: true });
	writeFileSync(join(values.out, 'coverage.json'), `${JSON.stringify({ surfaces, coverage: rows }, null, '\t')}\n`);
	const md = renderCoverageMarkdown(rows, {
		repo: relative(process.cwd(), repo) || '.',
		app: values.app ?? '(none)',
		recordings,
	});
	writeFileSync(join(values.out, 'coverage.md'), md);
	console.log(md);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
