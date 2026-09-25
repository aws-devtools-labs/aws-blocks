// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import type { CommandModule } from 'yargs';
import { runTypegenCli } from '../lib/typegen.js';

interface TypegenArgs {
	check?: boolean;
}

/**
 * `blocks typegen [--check]` — generate the type-safe key augmentation for
 * `getSecret` / `getConfig`. `runTypegenCli` returns a process exit code, which
 * we propagate via `process.exitCode` (0 = ok, non-zero = stale in `--check`).
 */
export function createTypegenCommand(): CommandModule<object, TypegenArgs> {
	return {
		command: 'typegen',
		describe: 'Generate type-safe getSecret/getConfig key augmentation',
		builder: (yargs) =>
			yargs.option('check', {
				type: 'boolean',
				describe: 'Fail (non-zero exit) if the generated types are stale',
				default: false,
			}),
		handler: async (args) => {
			const argv = args.check ? ['--check'] : [];
			const code = await runTypegenCli(argv);
			if (code !== 0) {
				process.exitCode = code;
			}
		},
	};
}
