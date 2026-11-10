// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Structural guard: the AWS runtime entry has no static import path to the
 * stub IdP engine (`engines/stub-idp.js`).
 *
 * The AWS runtime loads the engine only from the sandbox-only stub routes,
 * through a dynamic `import()` (see `stub-routes.ts`). A static import added
 * anywhere on the path from `index.aws.js` — for example, `utils.js` pulling a
 * helper from `engines/stub-idp.js` again — would make every deployed bundle
 * evaluate the engine at load time. These tests catch that.
 *
 * The import graph comes from an esbuild metafile over the compiled `dist/`
 * output, which records each edge's kind (`import-statement` vs
 * `dynamic-import`). Only static edges are followed. Third-party and
 * `@aws-blocks/*` packages are left external: this guard is about this
 * package's own modules.
 */

import assert from 'node:assert';
import { dirname } from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { build, type Metafile } from 'esbuild';

/** The compiled `dist/` directory this test runs from. */
const DIST_DIR = dirname(fileURLToPath(import.meta.url));

const ENGINE = 'engines/stub-idp.js';

/** Bundle `entry` (relative to `dist/`) without writing output and return its metafile. */
async function metafileFor(entry: string): Promise<Metafile> {
	const result = await build({
		absWorkingDir: DIST_DIR,
		entryPoints: [entry],
		bundle: true,
		write: false,
		metafile: true,
		platform: 'node',
		format: 'esm',
		conditions: ['aws-runtime'],
		packages: 'external',
		logLevel: 'silent',
	});
	return result.metafile;
}

/**
 * Every module reachable from `entry`. With `staticOnly`, only
 * `import`/`export ... from` edges are followed, never `import()`.
 */
function reachable(metafile: Metafile, entry: string, staticOnly: boolean): Set<string> {
	const seen = new Set<string>([entry]);
	const queue = [entry];
	while (queue.length > 0) {
		const current = queue.shift() as string;
		for (const edge of metafile.inputs[current]?.imports ?? []) {
			if (edge.external) continue;
			if (staticOnly && edge.kind !== 'import-statement') continue;
			if (!seen.has(edge.path)) {
				seen.add(edge.path);
				queue.push(edge.path);
			}
		}
	}
	return seen;
}

describe('stub IdP engine is not statically imported by the AWS runtime path', () => {
	for (const entry of ['index.aws.js', 'utils.js', 'routes.js', 'stub-routes.js']) {
		test(`${entry} has no static import path to ${ENGINE}`, async () => {
			const metafile = await metafileFor(entry);
			const statics = reachable(metafile, entry, true);
			assert.ok(!statics.has(ENGINE), `${entry} statically reaches ${ENGINE}: ${[...statics].join(', ')}`);
		});
	}

	test(`index.aws.js reaches ${ENGINE} only through a dynamic import from stub-routes.js`, async () => {
		// Keeps the guard above from passing vacuously (e.g. if the metafile
		// stopped recording local edges): the engine IS in the graph, behind
		// the lazy loader in `stub-routes.js`.
		const metafile = await metafileFor('index.aws.js');
		assert.ok(reachable(metafile, 'index.aws.js', false).has(ENGINE), `expected ${ENGINE} in the full graph`);
		const dynamicEdges = (metafile.inputs['stub-routes.js']?.imports ?? []).filter(
			(edge) => edge.path === ENGINE && edge.kind === 'dynamic-import',
		);
		assert.strictEqual(dynamicEdges.length, 1, 'expected one dynamic import of the engine in stub-routes.js');
	});
});
