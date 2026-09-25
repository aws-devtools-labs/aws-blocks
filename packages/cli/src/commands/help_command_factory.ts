// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from 'node:child_process';
import type { CommandModule } from 'yargs';

interface HelpArgs {
	command?: string;
}

/**
 * `blocks help [command]` — an explicit help subcommand, in addition to the
 * `--help` flag yargs provides. `blocks help` prints top-level help; `blocks
 * help <command>` prints that command's help (equivalent to
 * `blocks <command> --help`). This mirrors the `git help` / `npm help` / `ampx`
 * convention users expect from a mature CLI.
 *
 * It delegates by re-invoking the same bin with `--help`, so the help text is
 * always yargs' own canonical output for that command — no drift, no second
 * copy of the descriptions to maintain.
 */
export function createHelpCommand(): CommandModule<object, HelpArgs> {
	return {
		command: 'help [command]',
		describe: 'Show help for the CLI or a specific command',
		builder: (yargs) =>
			yargs.positional('command', {
				type: 'string',
				describe: 'The command to show help for',
			}),
		handler: (args) => {
			const bin = process.argv[1];
			const forwardArgs = args.command ? [args.command, '--help'] : ['--help'];
			const result = spawnSync(process.execPath, [bin, ...forwardArgs], { stdio: 'inherit' });
			if (typeof result.status === 'number' && result.status !== 0) {
				process.exitCode = result.status;
			}
		},
	};
}
