// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The process that the generate-client task helper (`generate-client-cli.ts`) starts
 * to generate the client: it runs the client-generation worker of
 * `@aws-cdk-blocks/core`, which reads the same arguments
 * (`<foundationPath> <outputPath>`) and imports the backend.
 *
 * At `BLOCKS_LOG_LEVEL=quiet` (`npm run generate-client -- -q`) the warnings that importing the
 * backend prints are hidden: a Building Block's runtime warning, such as
 * Realtime's `BLOCKS_RT_WS_URL not set`, says nothing about the generated client.
 *
 * A failure (a backend that does not load) prints one line and exits 1, with
 * the stack only at `BLOCKS_LOG_LEVEL=debug`, as `npm run spec` does.
 */

import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);

if (process.env.BLOCKS_LOG_LEVEL?.toLowerCase() === 'quiet') console.warn = () => {};

try {
	// Dynamic: a static import would evaluate the worker, and import the backend, before the line above runs.
	await import(pathToFileURL(require.resolve('@aws-cdk-blocks/core/scripts/generate-client-worker')).href);
} catch (error) {
	// One line, as `npm run spec` prints; the stack only at debug (`--debug`).
	console.error('❌ Client generation failed:', error instanceof Error ? error.message : String(error));
	if (process.env.BLOCKS_LOG_LEVEL?.toLowerCase() === 'debug') {
		console.error(error instanceof Error && error.stack ? error.stack : String(error));
	}
	process.exit(1);
}
