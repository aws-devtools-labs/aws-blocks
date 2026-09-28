// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * CDK-side shim: how a real Blocks app would emit `amplify_outputs.json`.
 *
 * NOT wired into a live synth in this experiment (that needs the full monorepo
 * build + `--conditions=cdk`); it documents the integration point and
 * type-checks the read of `AuthCognito`'s public surface. The commented CDK
 * imports show exactly which construct members are read.
 *
 * Real flow (Blocks-owns-backend, no ampx):
 *   1. App defines `AuthCognito` in `aws-blocks/index.ts` (server side) and
 *      the CDK app in `aws-blocks/index.cdk.ts`.
 *   2. A CfnOutput exposes userPoolId / userPoolClientId / region.
 *   3. Post-deploy (or in a synth aspect), read those outputs and call
 *      `emitAmplifyOutputs(...)`, writing `amplify_outputs.json` to the web root
 *      — the same lifecycle slot `ampx sandbox` fills, but sourced from Blocks.
 */

import { writeFileSync } from 'node:fs';
import { emitAmplifyOutputs, type BlocksCognitoFacts } from './emit-amplify-outputs.js';

// In real CDK (index.cdk.ts), after `BlocksStack.create(...)`:
//
//   import { AuthCognito } from '@aws-blocks/blocks/cdk';
//   const auth = /* the AuthCognito instance from your backend scope */;
//   new cdk.CfnOutput(stack, 'AmplifyAuthUserPoolId',   { value: auth.userPool.userPoolId });
//   new cdk.CfnOutput(stack, 'AmplifyAuthClientId',     { value: auth.userPoolClient.userPoolClientId });
//   new cdk.CfnOutput(stack, 'AmplifyAuthRegion',       { value: cdk.Stack.of(auth).region });
//
// `auth.userPool` (cognito.IUserPool) and `auth.userPoolClient`
// (cognito.IUserPoolClient) are BOTH declared `public readonly` on the
// AuthCognito class (packages/bb-auth-cognito/src/index.cdk.ts), so no
// escape hatch is needed to read the IDs.

/**
 * Build the outputs from resolved deploy values (e.g. read back from the
 * CloudFormation stack outputs, exactly like `ampx generate outputs` does from
 * a stack) and write the file to `outPath`.
 */
export function writeAmplifyOutputsFile(
	outPath: string,
	facts: BlocksCognitoFacts,
	blocksApiUrl?: string,
): void {
	const { outputs, gaps } = emitAmplifyOutputs(facts, { blocksApiUrl });
	writeFileSync(outPath, `${JSON.stringify(outputs, null, 2)}\n`, 'utf-8');
	if (gaps.length) {
		// Surface the fidelity gaps to the operator rather than silently degrading.
		for (const g of gaps) {
			// eslint-disable-next-line no-console
			console.warn(`[amplify-outputs] gap (${g.category}): ${g.detail}`);
		}
	}
}
