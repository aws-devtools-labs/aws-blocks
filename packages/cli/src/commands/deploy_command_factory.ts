// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import type { CommandModule } from 'yargs';
import { deploy } from '../lib/deploy.js';
import { requireBlocksApp } from '../paths.js';
import { verbose } from '../logger.js';

/** `blocks deploy` — deploy the production stack via CDK. */
export function createDeployCommand(): CommandModule {
	return {
		command: 'deploy',
		describe: 'Deploy the Blocks app to AWS (production stack)',
		builder: (yargs) => yargs,
		handler: async () => {
			const { cdkAppPath, projectRoot } = requireBlocksApp();
			verbose(`project root: ${projectRoot}`);
			verbose(`cdk app: ${cdkAppPath}`);
			await deploy({ cdkAppPath, projectRoot });
		},
	};
}
