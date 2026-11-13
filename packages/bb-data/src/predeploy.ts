// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import type { PredeployContext, PredeployResult } from '@aws-blocks/core/scripts';
import { checkFreePlanAurora } from './free-plan-aurora.js';

/**
 * The block's pre-deploy hook, declared under `aws-blocks.predeploy` in its
 * `package.json` for the `sandbox` and `production` stages. `npm run deploy`
 * and `npm run sandbox` call it after they synthesize the app and before
 * `cdk deploy`.
 *
 * On an account on the AWS Free plan, it stops the deploy when the synthesized
 * stacks create an Aurora cluster without express configuration (the `Database`
 * default), which RDS would reject minutes into the deploy. It does nothing on a
 * Paid plan, or when the plan was not read: a plan read that is denied or times
 * out must not slow or block a deploy that may be fine.
 */
export async function predeploy(context: PredeployContext): Promise<PredeployResult> {
	if (context.account?.plan !== 'FREE') return {};
	const invocation = context.invocation ?? (context.stage === 'production' ? 'npm run deploy' : 'npm run sandbox');
	return checkFreePlanAurora(await context.synth(), context.account.id, invocation);
}
