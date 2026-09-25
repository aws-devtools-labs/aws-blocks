// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import type { CommandModule } from 'yargs';
import { runConfigCli } from '../lib/config.js';

/**
 * `blocks config <action> [args...]` — manage app configuration values
 * (set/list/remove). The sub-argv is passed through to `runConfigCli`.
 */
export function createConfigCommand(): CommandModule {
	return {
		command: 'config [args..]',
		describe: 'Manage app configuration (set | list | remove)',
		builder: (yargs) =>
			yargs.positional('args', {
				describe: 'Arguments forwarded to the config CLI (e.g. set KEY value)',
				type: 'string',
				array: true,
			}),
		handler: async (args) => {
			const passthrough = (args.args as string[] | undefined) ?? [];
			await runConfigCli(passthrough);
		},
	};
}
