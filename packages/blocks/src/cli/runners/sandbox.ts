// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Runs under `tsx`, started by `blocks sandbox` and `blocks sandbox deploy`.
 * After a deploy-only run it records the target it deployed with; see
 * `deploy-target.ts`. (Watch mode never returns.)
 */

import * as core from '@aws-blocks/core/scripts';
import { recordDeployTarget } from './deploy-target.js';

const options = JSON.parse(process.argv[2]) as core.SandboxOptions;

try {
	await core.startSandbox(options);
} catch (error) {
	console.error(error);
	process.exit(1);
}
if (options.deployOnly && !process.exitCode) {
	await recordDeployTarget(process.cwd(), 'blocks sandbox deploy', core).catch((error: unknown) => {
		console.error(`Could not record the deployment target: ${error instanceof Error ? error.message : error}`);
	});
}
