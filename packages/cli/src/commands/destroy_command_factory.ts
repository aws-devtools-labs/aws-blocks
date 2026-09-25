// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import type { CommandModule } from 'yargs';
import { destroy } from '../lib/destroy.js';
import { requireBlocksApp } from '../paths.js';
import { verbose } from '../logger.js';

/** `blocks destroy` — tear down the production stack via CDK. */
export function createDestroyCommand(): CommandModule {
	return {
		command: 'destroy',
		describe: 'Destroy the deployed Blocks app (production stack)',
		builder: (yargs) => yargs,
		handler: async () => {
			const { cdkAppPath, projectRoot } = requireBlocksApp();
			verbose(`project root: ${projectRoot}`);
			verbose(`cdk app: ${cdkAppPath}`);
			await destroy({ cdkAppPath, projectRoot });
		},
	};
}
