// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Every Building Block re-export in src/index.ts names its package and points at
 * that block's bundled docs through `npm run docs <package>`. The pointer is plain
 * JSDoc text, so a renamed or newly EXCLUDED package (scripts/block-packages.mjs) would
 * otherwise leave a dead `Full docs:` name without any build failing.
 *
 * Run: node --test dist/docs-pointers.test.js
 */
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Compiled to dist/, so the package root is one level up and the repo root three.
const pkgRoot = fileURLToPath(new URL('..', import.meta.url));
const repoRoot = join(pkgRoot, '..', '..');

test('each Package: entry in src/index.ts points at its own bundled docs', async () => {
	const source = readFileSync(join(pkgRoot, 'src', 'index.ts'), 'utf-8');
	const { getBlockPackages } = await import(pathToFileURL(join(repoRoot, 'scripts', 'block-packages.mjs')).href);
	const bundled = new Set<string>(getBlockPackages());

	const packageLines = [...source.matchAll(/^ \* Package: `@aws-cdk-blocks\/([a-z0-9-]+)`$/gm)];
	const docsLines = [...source.matchAll(/^ \* Full docs: (.*)$/gm)];
	assert.ok(packageLines.length > 0, 'expected src/index.ts to contain Package: lines');
	assert.strictEqual(docsLines.length, packageLines.length, 'every Package: line needs exactly one Full docs: line');

	for (const [i, pkg] of packageLines.entries()) {
		const name = pkg[1];
		const docs = docsLines[i];
		assert.ok((docs.index ?? 0) > (pkg.index ?? 0), `Full docs: for ${name} must follow its Package: line`);
		assert.strictEqual(
			docs[1],
			`\`npm run docs ${name}\`.`,
			`Full docs: for @aws-cdk-blocks/${name} must name its bundled docs`,
		);
		assert.ok(bundled.has(name), `@aws-cdk-blocks/${name} is not bundled by gen-block-docs (see getBlockPackages)`);
	}
});
