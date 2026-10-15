// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import type { CommandModule } from 'yargs';
import { resolveBlockBin } from '../lib/block-cli.js';
import { runSync } from '../lib/run-command.js';
import { verbose } from '../logger.js';

/**
 * The data block's bin and the verbs it exposes today (`bb-data <verb>`).
 * These are declared here only to produce helpful `blocks db --help` output and
 * command recommendations; the actual argument parsing is owned by the block's
 * own bin, to which every verb is forwarded verbatim. The CLI does NOT import
 * the block — it discovers and delegates (see lib/block-cli.ts).
 */
const DATA_BLOCK_BIN = 'bb-data';
const DATA_BLOCK_VERBS = ['migrate', 'status', 'generate-types', 'pull'] as const;

/** Raised when `blocks db` is run in an app that has not installed the data block. */
class DataBlockNotInstalledError extends Error {
	constructor() {
		super(
			`The data block is not installed in this app, so \`blocks db\` has nothing to run.\n` +
				`Add it with \`npm install @aws-blocks/bb-data\`, then re-run your command.`,
		);
		this.name = 'DataBlockNotInstalledError';
	}
}

/**
 * `blocks db <verb> [args...]` — a delegating facade over the data block's own
 * `bb-data` bin. Every argument after `db` is forwarded unchanged to the bin
 * resolved from the app's `node_modules/.bin`, so `blocks db migrate --url …`
 * is exactly `bb-data migrate --url …` with the CLI's discovery and errors
 * wrapped around it. The verbosity level propagates to the child via
 * `runSync` (BLOCKS_LOG_LEVEL), the same as every other shell-out.
 */
export function createDbCommand(): CommandModule {
	return {
		command: 'db <verb>',
		describe: "Run the data block's schema/data commands (migrate, status, generate-types, pull)",
		builder: (yargs) =>
			yargs
				.positional('verb', {
					type: 'string',
					describe: 'The data-block verb to run',
					choices: DATA_BLOCK_VERBS as unknown as string[],
				})
				// Forward every remaining token (flags and values) to the bin untouched.
				.strict(false)
				.example('$0 db migrate', 'Apply pending schema migrations')
				.example('$0 db status', 'Show applied and pending migrations')
				.example('$0 db pull', 'Introspect the live database and regenerate local types'),
		handler: async (args) => {
			const bin = resolveBlockBin(DATA_BLOCK_BIN);
			if (!bin) {
				throw new DataBlockNotInstalledError();
			}

			// Reconstruct the argv to forward: the verb plus everything after it.
			// yargs puts positionals + unparsed tokens in `_`; drop the leading
			// `db` command token and pass the rest straight through.
			const forwarded = (args._ as (string | number)[])
				.slice(1)
				.map(String);

			verbose(`Delegating to ${DATA_BLOCK_BIN}: ${forwarded.join(' ')}`);
			runSync(bin, forwarded);
		},
	};
}
