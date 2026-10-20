// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Shared package-discovery for the catalog + docs generators (sync-catalog.mjs,
 * gen-block-docs.mjs). Both need the SAME set of Building Blocks, so the
 * inclusion rule + exclusion list live here to prevent the two from drifting.
 *
 * Dependency-free (Node stdlib only) and side-effect-free, so each generator
 * stays independently runnable with no build step.
 */

import { existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Packages under `packages/` that are NOT catalog-listed Building Blocks: the
 * umbrella + internal/support packages, and the scaffolding CLIs
 * (`create-blocks-app`, `create-block`) which ship a README but aren't `bb-*`.
 */
export const EXCLUDED = new Set(['blocks', 'data-common', 'foundations', 'create-blocks-app', 'create-block', 'bb-lambda-compute']);

/** Absolute path to the monorepo's `packages/` directory. */
export const packagesDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'packages');

/** Every package under `packages/` that has a `README.md` and is not EXCLUDED. */
export function getBlockPackages() {
	return readdirSync(packagesDir).filter(
		(name) => !name.startsWith('.') && !EXCLUDED.has(name) && existsSync(join(packagesDir, name, 'README.md')),
	);
}
