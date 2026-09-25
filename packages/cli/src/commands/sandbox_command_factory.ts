// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import type { CommandModule } from 'yargs';
import { startSandbox } from '../lib/sandbox.js';
import { requireBlocksApp } from '../paths.js';
import { verbose } from '../logger.js';

interface SandboxArgs {
	'deploy-only'?: boolean;
	'client-port'?: number;
}

/**
 * `blocks sandbox` — deploy a per-developer sandbox stack and watch for changes.
 * Passes `devCommand: 'blocks dev'` so the sandbox runner drives the frontend
 * through this CLI rather than a vendored script.
 */
export function createSandboxCommand(): CommandModule<object, SandboxArgs> {
	return {
		command: 'sandbox',
		describe: 'Deploy and watch a per-developer sandbox stack',
		builder: (yargs) =>
			yargs
				.option('deploy-only', {
					type: 'boolean',
					describe: 'Deploy once and exit (do not watch)',
					default: false,
				})
				.option('client-port', {
					type: 'number',
					describe: 'Port for the generated client dev server',
				}),
		handler: async (args) => {
			const { cdkAppPath } = requireBlocksApp();
			verbose(`cdk app: ${cdkAppPath}`);
			await startSandbox({
				backendPath: cdkAppPath,
				deployOnly: args['deploy-only'],
				clientPort: args['client-port'],
				devCommand: 'blocks dev',
			});
		},
	};
}
