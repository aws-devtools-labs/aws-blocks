#!/usr/bin/env node
// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * `hosting-typegen` — generate the type-safe key augmentation for `getSecret` /
 * `getConfig`. Scans your `secret('...')` / `config('...')` calls and writes a
 * `.d.ts` so the getters narrow to your declared keys (autocomplete + typo errors)
 * with no call-site change. Runs statically — no app import, no AWS credentials.
 *
 *   npx hosting-typegen                 # scan + write .blocks/hosting-values.d.ts
 *   npx hosting-typegen --check         # CI: fail if the generated file is stale
 *   npx hosting-typegen --watch         # regenerate on every save (Ctrl+C to stop)
 *   npx hosting-typegen --out <path> --include <glob> --module <spec> --cwd <dir>
 */

import { runTypegenCli } from './secret-typegen.js';

// Ctrl+C cleanly stops --watch (and is a no-op for one-shot runs).
const controller = new AbortController();
process.once('SIGINT', () => controller.abort());
process.once('SIGTERM', () => controller.abort());

runTypegenCli(process.argv.slice(2), { signal: controller.signal })
	.then((code) => process.exit(code))
	.catch((error: unknown) => {
		console.error(error instanceof Error ? error.message : error);
		process.exit(1);
	});
