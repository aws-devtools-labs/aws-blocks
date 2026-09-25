// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import type { CommandModule } from 'yargs';
import { deploy } from '../lib/deploy.js';
import { requireBlocksApp } from '../paths.js';

/** `blocks deploy` — deploy the production stack via CDK. */
export function createDeployCommand(): CommandModule {
	return {
		command: 'deploy',
		describe: 'Deploy the Blocks app to AWS (production stack)',
		builder: (yargs) => yargs,
		handler: async () => {
			const { cdkAppPath, projectRoot } = requireBlocksApp();
			await deploy({ cdkAppPath, projectRoot });
		},
	};
}
