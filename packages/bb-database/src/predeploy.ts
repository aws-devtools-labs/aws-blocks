// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The block's pre-deploy hook. `package.json` declares it under
 * `aws-blocks.predeploy`, and core's deploy script discovers and runs it before
 * `cdk deploy`. The CLI's `predeploy` command runs the same function by hand.
 *
 * Production: synthesize, then run the deploy guard on every stack. Sandbox:
 * nothing; a sandbox stack and its clusters are destroyed anyway, so the
 * manifest lists `production` only and this branch is for a direct call.
 */
import type { PredeployContext, PredeployResult } from '@aws-blocks/core/scripts';
import { type GuardClients, guardDeploy } from './deploy-guard.js';

export async function predeploy(context: PredeployContext, clients: GuardClients = {}): Promise<PredeployResult> {
	if (context.stage !== 'production') {
		return {
			notes: ['The sandbox stage skips the deploy guard: a sandbox stack and its clusters are destroyed anyway.'],
		};
	}
	const stops: string[] = [];
	const notes: string[] = [];
	for (const stack of await context.synth()) {
		const result = await guardDeploy({ stackName: stack.stackName, template: stack.template, ...clients });
		stops.push(...result.stops);
		notes.push(...result.notes.map((n) => `${stack.stackName}: ${n}`));
	}
	return { stops, notes };
}
