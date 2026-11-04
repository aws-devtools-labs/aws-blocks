#!/usr/bin/env node
// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * CLI wrapper that regenerates only the backend's declaration files
 * (`aws-blocks/.types/`). Exposed as the `blocks-generate-types` bin on
 * `@aws-blocks/blocks` so every app can wire it as its `prepare` hook:
 *
 *     "prepare": "blocks-generate-types"
 *
 * `prepare` is the hook that makes the declarations exist. npm runs it after a
 * bare `npm install` and after `npm ci` — so after scaffolding, after cloning a
 * scaffolded app, and in CI — but not after `npm install <pkg>`. Without it,
 * `.types/` is gitignored and absent until the first `npm run dev` or
 * `npm run build`, and `exports["."].types` pointing at a missing file does not
 * fail loudly: TypeScript falls through to the `default` condition and
 * typechecks the backend *source* with the frontend's tsconfig, which is the
 * problem generated types exist to avoid. An editor opened straight after
 * `git clone && npm install`, or a bare `tsc --noEmit`, would see exactly that.
 *
 * This is deliberately NOT a freshness gate, and deliberately exits 0 even when
 * generation fails. Its job is to make the types exist, as early as possible;
 * breaking `npm install` over a backend type error would be a worse trade, and
 * the authoritative gate is `prebuild`/`pretypecheck` running
 * `blocks-generate-client`, which does fail the build. The same split as
 * `svelte-kit sync` (wired into `prepare`) and `astro sync` (run as part of
 * `astro dev`/`build`/`check`).
 *
 * Usage:
 *   blocks-generate-types [awsBlocksDir]
 *
 * Default: ./aws-blocks
 */

import { existsSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { generateBackendTypes } from '@aws-blocks/core/scripts/generate-types';

const [dirArg] = process.argv.slice(2);
const awsBlocksDir = isAbsolute(dirArg ?? '') ? (dirArg as string) : resolve(process.cwd(), dirArg ?? './aws-blocks');

// No backend workspace here (e.g. `prepare` in a repo that has not scaffolded
// one): nothing to generate, and nothing worth saying about it.
if (!existsSync(awsBlocksDir)) process.exit(0);

const result = await generateBackendTypes(awsBlocksDir);

if (result.status === 'written') {
	console.log(`blocks-generate-types: wrote ${result.outFile}`);
} else if (result.status === 'failed') {
	console.warn(`⚠ blocks-generate-types: ${result.message}`);
	if (result.diagnostics) console.warn(result.diagnostics);
	console.warn('  The next `npm run dev` or `npm run build` will report this too.');
}
