// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * `@aws-blocks/hosting/scripts` — **build-time tooling**: the CLI core
 * (`secret`/`config` set/list/remove) and the typegen engine (scan/watch,
 * `hosting-typegen`). Kept off the package's `.` entry so the value API there
 * imports no `fast-glob` / `node:fs` and stays safe to bundle for any runtime
 * (including the Next.js edge runtime). Consumed only from build contexts —
 * `@aws-blocks/core`'s scripts and the Blocks dev server — never an SSR route.
 *
 * @module
 */

export { listValues, removeValue, runValueCli, setValue, type ValueCliOptions } from './secret-cli.js';
export { runTypegenCli, scanValueKeys, watchHostingValues } from './secret-typegen.js';
