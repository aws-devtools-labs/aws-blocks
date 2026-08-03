// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * In the Next-native model, blocks live in ordinary app-code modules rather than
 * behind a package boundary — so nothing structural stops a Client Component from
 * importing them. `lib/backend.ts` starts with `import 'server-only'`, which turns
 * that mistake into a build error.
 *
 * This asserts the *outcome* rather than the mechanism: after a production build, no
 * browser chunk may contain server-only code. If someone removes the `server-only`
 * guard and imports the backend from client code, an AWS SDK and a Postgres WASM
 * binary end up in the browser bundle, and this fails.
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const APP_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const STATIC_DIR = join(APP_DIR, '.next/static');

/** Strings that should only ever exist in server code. */
const SERVER_ONLY_MARKERS = [
	'@electric-sql/pglite',
	'postgres.wasm',
	'@aws-sdk/client-dynamodb',
	'@aws-sdk/client-rds-data',
];

describe('no server-side code reaches the browser bundle', () => {
	before(() => {
		// `output: 'standalone'` means `next build` also traces server deps, so a leak
		// would show up in the client chunks scanned below.
		execFileSync('npm', ['exec', 'next', '--', 'build'], { cwd: APP_DIR, stdio: 'inherit' });
	});

	it('produced client chunks', () => {
		assert.ok(existsSync(STATIC_DIR), `no ${STATIC_DIR} — did the build run?`);
		const files = readdirSync(STATIC_DIR, { recursive: true, encoding: 'utf-8' }).filter((f) => f.endsWith('.js'));
		assert.ok(files.length > 0, 'build produced no client chunks');
	});

	it('contains no server-only markers in any client chunk', () => {
		const files = readdirSync(STATIC_DIR, { recursive: true, encoding: 'utf-8' }).filter((f) => f.endsWith('.js'));

		const leaks = [];
		for (const file of files) {
			const body = readFileSync(join(STATIC_DIR, file), 'utf-8');
			for (const marker of SERVER_ONLY_MARKERS) {
				if (body.includes(marker)) leaks.push(`${file} contains "${marker}"`);
			}
		}
		assert.deepEqual(leaks, [], `server code leaked into the browser bundle:\n${leaks.join('\n')}`);
	});
});
