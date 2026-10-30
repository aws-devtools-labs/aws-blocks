// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Runs under `tsx`, started by `blocks deploy`. Core reads `--wait-live` and
 * `--wait-live-timeout=N` from `process.argv` after the options. After a
 * successful deploy it records the target it deployed with; see `deploy-target.ts`.
 */

import * as core from '@aws-blocks/core/scripts';
import { recordDeployTarget } from './deploy-target.js';

const options = JSON.parse(process.argv[2]) as core.DeployOptions;

try {
	await core.deploy(options);
} catch (error) {
	console.error(error);
	process.exit(1);
}
if (!process.exitCode) {
	await recordDeployTarget(options.projectRoot ?? process.cwd(), 'blocks deploy', core).catch((error: unknown) => {
		console.error(`Could not record the deployment target: ${error instanceof Error ? error.message : error}`);
	});
}
