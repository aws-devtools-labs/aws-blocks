// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Runs with the `tsx` loader, started by `blocks sandbox` and `blocks sandbox deploy`.
 * After a deploy-only run it records the outputs and the target it deployed
 * with; see `last-deploy.ts`. (Watch mode never returns.)
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as core from '@aws-blocks/core/scripts';
import { type DeployedOutputs, recordLastDeploy } from './last-deploy.js';

const options = JSON.parse(process.argv[2]) as core.SandboxOptions;
const projectRoot = process.cwd();

let apiUrl: string | undefined;
try {
	apiUrl = await core.startSandbox(options);
} catch (error) {
	console.error(error);
	process.exit(1);
}
if (options.deployOnly && apiUrl && !process.exitCode) {
	try {
		// Core read outputs.json just before it returned the URL; read the stack's
		// other outputs now, before a production deploy can rewrite the file.
		const stack = core.getStackName({ sandbox: true, projectRoot });
		let values: Record<string, string> | undefined;
		try {
			const outputs = JSON.parse(readFileSync(join(projectRoot, '.blocks-sandbox', 'outputs.json'), 'utf-8'));
			values = (outputs as Record<string, Record<string, string> | undefined>)[stack];
		} catch {
			// No readable outputs.json: no frontend URL to report.
		}
		const urlKey = values && Object.keys(values).find((key) => key.includes('HostingUrl'));
		const deployed: DeployedOutputs = { stack, apiUrl, url: values && urlKey ? values[urlKey] : null };
		await recordLastDeploy(projectRoot, 'sandbox', deployed, 'blocks sandbox deploy', core);
	} catch (error) {
		console.error(`Could not record the deploy result: ${error instanceof Error ? error.message : error}`);
	}
}
