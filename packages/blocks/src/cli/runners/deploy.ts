// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Runs with the `tsx` loader, started by `blocks deploy`. Core reads `--wait-live`
 * and `--wait-live-timeout=N` from `process.argv` after the options. After a
 * successful deploy it records the outputs core read and the target it deployed
 * with; see `last-deploy.ts`.
 */

import * as core from '@aws-blocks/core/scripts';
import { type DeployedOutputs, recordLastDeploy } from './last-deploy.js';

const options = JSON.parse(process.argv[2]) as core.DeployOptions;
const projectRoot = options.projectRoot ?? process.cwd();

// Core reads the outputs before its `--wait-live` wait, during which a sandbox
// deploy of the same app can rewrite outputs.json.
let deployed: DeployedOutputs | undefined;
try {
	await core.deploy({
		...options,
		onDeployed: ({ stack, apiUrl, hostingUrl }) => {
			deployed = { stack, apiUrl, url: hostingUrl ?? null };
		},
	});
} catch (error) {
	console.error(error);
	process.exit(1);
}
if (!process.exitCode && deployed) {
	await recordLastDeploy(projectRoot, 'production', deployed, 'blocks deploy', core).catch((error: unknown) => {
		console.error(`Could not record the deploy result: ${error instanceof Error ? error.message : error}`);
	});
}
