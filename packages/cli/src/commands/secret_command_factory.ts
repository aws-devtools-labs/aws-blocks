// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import type { CommandModule } from 'yargs';
import { runSecretCli } from '../lib/secret.js';

/**
 * `blocks secret <action> [args...]` — manage app secrets (set/list/remove).
 * The whole sub-argv is passed through to `runSecretCli`, which owns parsing.
 */
export function createSecretCommand(): CommandModule {
	return {
		command: 'secret [args..]',
		describe: 'Manage app secrets (set | list | remove)',
		builder: (yargs) =>
			yargs.positional('args', {
				describe: 'Arguments forwarded to the secret CLI (e.g. set KEY value)',
				type: 'string',
				array: true,
			}),
		handler: async (args) => {
			const passthrough = (args.args as string[] | undefined) ?? [];
			await runSecretCli(passthrough);
		},
	};
}
