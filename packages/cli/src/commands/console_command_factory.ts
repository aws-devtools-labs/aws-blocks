// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import type { CommandModule } from 'yargs';
import { openConsole } from '../lib/console.js';
import { resolveAppPaths } from '../paths.js';

/**
 * `blocks console` (alias `blocks sandbox:console`) — open the AWS console for
 * the sandbox stack, using the deployed outputs file to target the right stack.
 */
export function createConsoleCommand(): CommandModule {
	return {
		command: 'console',
		aliases: ['sandbox:console'],
		describe: 'Open the AWS console for the sandbox stack',
		builder: (yargs) => yargs,
		handler: async () => {
			const { outputsFile } = resolveAppPaths();
			await openConsole({ outputsFile });
		},
	};
}
