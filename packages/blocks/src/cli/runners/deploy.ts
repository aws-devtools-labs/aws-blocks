// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Runs with the `tsx` loader, started by `cdk-blocks deploy`. Core reads `--wait-live`
 * and `--wait-live-timeout=N` from `process.argv` after the options. After a
 * successful deploy it records the outputs core read and the target it deployed
 * with; see `last-deploy.ts`. A deploy whose `--wait-live` wait failed is
 * recorded too, with `live: false`, and still exits 1.
 */

import * as core from '@aws-blocks/core/scripts';
import { exitWithError } from './fail.js';
import { type DeployedOutputs, recordLastDeploy } from './last-deploy.js';

const options = JSON.parse(process.argv[2]) as core.DeployOptions;
const projectRoot = options.projectRoot ?? process.cwd();
const waitLive = process.argv.includes('--wait-live');

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
	exitWithError(error);
}
// After onDeployed, core sets a failing exit code only when the liveness wait failed.
// A backend-only app has no frontend to wait for.
if (deployed) {
	const live = waitLive && deployed.url ? !process.exitCode : undefined;
	await recordLastDeploy(
		projectRoot,
		'production',
		{ ...deployed, ...(live === undefined ? {} : { live }) },
		'cdk-blocks deploy',
		core,
	).catch((error: unknown) => {
		console.error(`Could not record the deploy result: ${error instanceof Error ? error.message : error}`);
	});
}
