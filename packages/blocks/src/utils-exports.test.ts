// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * `@aws-blocks/blocks/utils` is the Node.js test-and-script toolkit
 * (`installCookieJar`, `isServerRunning`, `totpCodeFor`). It deliberately has
 * no `browser` condition: Node e2e suites run with the browser condition on
 * (`tsx -C browser`, so `aws-blocks` resolves to the generated client) and
 * import these helpers in the same process, so a throwing browser stub would
 * break exactly the callers the subpath exists for. Like the other Node-only
 * subpaths (`./server`, `./scripts`, `./lambda-handler`), it is never imported
 * by the browser entries (`.` and `./ui` resolve without it), and a real
 * browser bundle that imports it fails at build time on `node:crypto`.
 */

import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const packageDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'));

test('./utils is Node-only: no browser condition, so Node suites under -C browser get the real helpers', () => {
	assert.deepStrictEqual(manifest.exports['./utils'], { types: './dist/utils.d.ts', default: './dist/utils.js' });
	const out = execFileSync(
		process.execPath,
		[
			'--conditions=browser',
			'--input-type=module',
			'-e',
			"const { totpCodeFor } = await import('@aws-blocks/blocks/utils'); console.log(totpCodeFor('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', 59_000));",
		],
		{ cwd: packageDir, encoding: 'utf8' },
	);
	assert.strictEqual(out.trim(), '287082');
});

test('the browser entries never reach ./utils (node:crypto stays out of browser bundles)', () => {
	for (const entry of ['dist/index.browser.js', 'dist/ui.js', 'dist/client.js']) {
		const source = readFileSync(join(packageDir, entry), 'utf8');
		assert.doesNotMatch(source, /utils\.js|blocks\/utils|node:crypto/, entry);
	}
});
