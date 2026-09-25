// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import type { CommandModule } from 'yargs';
import { cleanup } from '../lib/cleanup.js';

/** `blocks cleanup` — kill stray Blocks dev-server processes on common ports. */
export function createCleanupCommand(): CommandModule {
	return {
		command: 'cleanup',
		describe: 'Kill stray Blocks processes on common dev ports',
		builder: (yargs) => yargs,
		handler: async () => {
			await cleanup();
		},
	};
}
