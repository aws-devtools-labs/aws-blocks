// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import type { CommandModule } from 'yargs';
import { startDevServer } from '../lib/dev-server.js';
import { resolveAppPaths } from '../paths.js';

interface DevArgs {
	port?: number;
	'frontend-command'?: string;
	'frontend-port'?: number;
}

/**
 * `blocks dev` — run the local development server against the backend
 * foundation (`aws-blocks/index.ts`), optionally proxying a frontend dev server.
 */
export function createDevCommand(): CommandModule<object, DevArgs> {
	return {
		command: 'dev',
		describe: 'Run the local Blocks development server',
		builder: (yargs) =>
			yargs
				.option('port', {
					type: 'number',
					describe: 'Customer-facing port (default 3000)',
				})
				.option('frontend-command', {
					type: 'string',
					describe: "Command to start the frontend dev server (e.g. 'npx vite --port 3100')",
				})
				.option('frontend-port', {
					type: 'number',
					describe: 'Port the frontend dev server listens on (default 3100)',
				}),
		handler: async (args) => {
			const { backendPath } = resolveAppPaths();
			await startDevServer({
				backendPath,
				port: args.port,
				frontendCommand: args['frontend-command'],
				frontendPort: args['frontend-port'],
			});
		},
	};
}
