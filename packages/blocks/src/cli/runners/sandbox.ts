// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Runs with the `tsx` loader, started by `blocks sandbox` and `blocks sandbox deploy`.
 * After the first deploy, in both modes, it records the outputs and the target it
 * deployed with (see `last-deploy.ts`): watch mode then keeps running, and a
 * production deploy can rewrite `outputs.json` meanwhile, so `blocks sandbox
 * console` reads the record.
 */

import * as core from '@aws-blocks/core/scripts';
import { exitWithError } from './fail.js';
import { recordLastDeploy } from './last-deploy.js';

const options = JSON.parse(process.argv[2]) as core.SandboxOptions;
const projectRoot = process.cwd();
const invocation = options.deployOnly ? 'blocks sandbox deploy' : 'blocks sandbox';

try {
	await core.startSandbox({
		...options,
		onDeployed: async ({ stack, apiUrl, hostingUrl }) => {
			await recordLastDeploy(projectRoot, 'sandbox', { stack, apiUrl, url: hostingUrl ?? null }, invocation, core).catch(
				(error: unknown) => {
					console.error(`Could not record the deploy result: ${error instanceof Error ? error.message : error}`);
				},
			);
		},
	});
} catch (error) {
	exitWithError(error);
}
