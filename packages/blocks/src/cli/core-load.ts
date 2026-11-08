// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Loading `@aws-blocks/core` from the CLI. An installed core that does not match
 * the CLI (an upgrade of `@aws-blocks/blocks` that kept an older core in the
 * lockfile) lacks an entry or an export that the CLI imports: that fails with a
 * message that says so and how to fix it, instead of Node's raw error.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type * as CoreScriptsModule from '@aws-blocks/core/scripts';
import { CliError } from './errors.js';

const CORE = '@aws-blocks/core';

/** The Node error codes of a module that does not resolve. */
const RESOLVE_ERROR_CODES: Readonly<Record<string, true>> = {
	ERR_PACKAGE_PATH_NOT_EXPORTED: true,
	ERR_MODULE_NOT_FOUND: true,
	MODULE_NOT_FOUND: true,
};

/** The version and the core dependency range of this `@aws-blocks/blocks`. */
function blocksManifest(): { version: string; dependencies?: Record<string, string> } {
	return JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf-8')) as {
		version: string;
		dependencies?: Record<string, string>;
	};
}

/** The version of the `@aws-blocks/core` that Node resolves from this CLI, as it searches `node_modules`. */
function installedCoreVersion(): string | undefined {
	for (let dir = dirname(fileURLToPath(import.meta.url)); ; dir = dirname(dir)) {
		const manifest = join(dir, 'node_modules', '@aws-blocks', 'core', 'package.json');
		if (existsSync(manifest)) {
			try {
				const pkg: unknown = JSON.parse(readFileSync(manifest, 'utf-8'));
				return pkg && typeof pkg === 'object' && 'version' in pkg && typeof pkg.version === 'string'
					? pkg.version
					: undefined;
			} catch {
				return undefined;
			}
		}
		if (dirname(dir) === dir) return undefined;
	}
}

/**
 * A CLI error for `error`, when it is the failure to load `@aws-blocks/core` or a
 * part of it: an entry that its `exports` lack, an export that a module lacks,
 * or no core at all. `undefined` for any other error.
 */
export function coreMismatchError(error: unknown): CliError | undefined {
	// Node names the package by its path, which on Windows is `node_modules\@aws-blocks\core\package.json`.
	if (!(error instanceof Error) || !error.message.replaceAll('\\', '/').includes(CORE)) return undefined;
	const code = 'code' in error && typeof error.code === 'string' ? error.code : undefined;
	const missingExport = error instanceof SyntaxError && error.message.includes('does not provide an export named');
	if (!missingExport && !(code !== undefined && RESOLVE_ERROR_CODES[code])) return undefined;
	const { version, dependencies } = blocksManifest();
	const installed = installedCoreVersion();
	const range = dependencies?.[CORE];
	return new CliError(
		`@aws-blocks/blocks ${version} cannot load ${installed ? `${CORE} ${installed}` : CORE}, which does not match it: ${error.message.split('\n')[0]}`,
		{
			cause: error,
			hint: `reinstall ${CORE} to match @aws-blocks/blocks ${version}: npm install ${range ? `'${CORE}@${range}'` : CORE}`,
		},
	);
}

/** Load `@aws-blocks/core/scripts`; a core that does not match fails with {@link coreMismatchError}. */
export async function loadCoreScripts(): Promise<typeof CoreScriptsModule> {
	try {
		// Loaded on demand, not imported: `cdk-blocks --help` and usage errors never load core (about 0.6 s).
		return await import('@aws-blocks/core/scripts');
	} catch (error) {
		throw coreMismatchError(error) ?? error;
	}
}
