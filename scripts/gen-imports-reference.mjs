#!/usr/bin/env node
// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Writes (default) or checks (`--check`) packages/blocks/IMPORTS.md, the
 * generated "what to import from where" reference. It reads the built
 * declaration files, so run `npm run build` first. The same comparison runs in
 * packages/blocks' `npm test` (imports-reference.test.ts).
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const generator = new URL('../packages/blocks/dist/test-support/imports-reference.js', import.meta.url);
if (!existsSync(generator)) {
	console.error('packages/blocks is not built: run `npm run build` first.');
	process.exit(1);
}
const { IMPORTS_MD, renderImportsReference } = await import(generator.href);
const content = renderImportsReference();

if (process.argv.includes('--check')) {
	if (!existsSync(IMPORTS_MD) || readFileSync(IMPORTS_MD, 'utf8') !== content) {
		console.error('packages/blocks/IMPORTS.md is out of date: run `npm run update:imports` and commit it.');
		process.exit(1);
	}
	console.log('packages/blocks/IMPORTS.md is up to date.');
} else {
	writeFileSync(IMPORTS_MD, content);
	console.log('Wrote packages/blocks/IMPORTS.md');
}
