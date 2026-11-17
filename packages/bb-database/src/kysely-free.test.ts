// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

// Imports the entry and prints the first module that resolved a file of the kysely package, if any.
const TRACE = `
import { registerHooks } from 'node:module';
const importers = [];
registerHooks({
	resolve(specifier, context, nextResolve) {
		const resolved = nextResolve(specifier, context);
		if (resolved.url.includes('/node_modules/kysely/')) importers.push(context.parentURL);
		return resolved;
	},
});
await import(process.argv[1]);
console.log(JSON.stringify(importers.slice(0, 1)));
process.exit(0);
`;

for (const entry of ['index.mock.js', 'index.aws.js', 'index.cdk.js']) {
	test(`${entry} does not load Kysely`, () => {
		const out = execFileSync(
			process.execPath,
			['--input-type=module', '-e', TRACE, pathToFileURL(join(here, entry)).href],
			{ encoding: 'utf8', timeout: 60_000 },
		);
		assert.deepStrictEqual(JSON.parse(out.trim().split('\n').pop() ?? 'null'), []);
	});
}
