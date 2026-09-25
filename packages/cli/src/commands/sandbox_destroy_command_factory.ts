// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import type { CommandModule } from 'yargs';
import { destroySandbox } from '../lib/sandbox.js';
import { requireBlocksApp } from '../paths.js';

/** `blocks sandbox:destroy` — tear down the per-developer sandbox stack. */
export function createSandboxDestroyCommand(): CommandModule {
	return {
		command: 'sandbox:destroy',
		describe: 'Destroy the per-developer sandbox stack',
		builder: (yargs) => yargs,
		handler: async () => {
			const { cdkAppPath } = requireBlocksApp();
			await destroySandbox(cdkAppPath);
		},
	};
}
