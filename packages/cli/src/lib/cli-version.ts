// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';

/**
 * The `@aws-blocks/cli` package's own version, read from its `package.json`.
 *
 * This is the single source of truth for the version `blocks` reports: both
 * `blocks --version` and the CDK telemetry user-agent use it, so the CLI
 * attributes work under its own identity rather than borrowing the version of
 * any library it bundles.
 *
 * The lookup walks UP from this module toward the filesystem root and returns
 * the first `package.json` named `@aws-blocks/cli`. Walking (rather than a
 * fixed `../package.json`) keeps it correct whether this code runs from the
 * per-file `tsc` layout (`dist/lib/cli-version.js`) or inlined into the bundled
 * bin at a different depth (`dist/blocks.js`) — in both cases the CLI's own
 * `package.json` is the nearest one so named.
 *
 * @returns The CLI version string, or `'0.0.0'` if the lookup fails.
 */
export function cliVersion(): string {
	try {
		let dir = dirname(fileURLToPath(import.meta.url));
		// Bounded walk toward the root; the CLI package.json is a few levels up.
		for (let i = 0; i < 10; i++) {
			const candidate = join(dir, 'package.json');
			if (existsSync(candidate)) {
				const pkg = JSON.parse(readFileSync(candidate, 'utf8')) as {
					name?: string;
					version?: string;
				};
				if (pkg.name === '@aws-blocks/cli') {
					return pkg.version ?? '0.0.0';
				}
			}
			const parent = dirname(dir);
			if (parent === dir) break; // reached filesystem root
			dir = parent;
		}
		// Fallback: a plain require relative to this module (per-file layout).
		const require = createRequire(import.meta.url);
		const pkg = require('../../package.json') as { version?: string };
		return pkg.version ?? '0.0.0';
	} catch {
		return '0.0.0';
	}
}
