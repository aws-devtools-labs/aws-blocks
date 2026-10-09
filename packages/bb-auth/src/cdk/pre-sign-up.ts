// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The Cognito PreSignUp trigger behind `validateUser` (decision Q10) — CDK side.
 *
 * Provisioned **only** when `validateUser` is set and the block owns its pool
 * (a pool wrapped with `userPool` belongs to someone else, who owns its
 * triggers). Unset, nothing here runs and the template is unchanged.
 *
 * | What | Resource |
 * |---|---|
 * | the trigger | `LambdaConfig.PreSignUp` on `pool` → the shared backend Lambda (the app's own code runs `validateUser`) |
 * | `pre-sign-up-permission` | `AWS::Lambda::Permission`: `lambda:InvokeFunction` for `cognito-idp.amazonaws.com`, `SourceArn` = this pool only |
 *
 * With the trigger, the block also registers the config flag
 * `preSignUpTriggerConfigKey(fullId)` (in `index.cdk.ts`), from which the
 * runtime — of this block only — registers the trigger's event handler.
 *
 * `LambdaConfig` updates in place (no pool replacement) and is outside the
 * four service-immutable properties the D4 guard watches, so adding or
 * removing `validateUser` is a permitted change.
 *
 * The trigger is set as a property override on the L1 pool rather than with
 * `UserPool.addTrigger()`: that helper names its permission `PreSignUpCognito`
 * **under the function**, so a second `Auth` block on the same shared Lambda
 * would collide. The permission here lives under the block instead.
 *
 * **The dependency cycle, and how it is broken.** The pool now references the
 * function (`LambdaConfig`), the function depends on its role and the role's
 * default policy (CDK makes a `Function` depend on its role's subtree), and the
 * block's `cognito-idp:*` grants on that default policy reference the pool's
 * ARN — pool → function → default policy → pool. The standard CDK fix: with a
 * trigger, those grants go into a separate `iam.Policy` (`pool-access`)
 * attached to the same shared role. The function does not depend on it, so the
 * cycle is gone and the grants stay scoped to the pool ARN (no wildcard).
 *
 * @internal
 */

import * as cdk from 'aws-cdk-lib';
import type * as cognito from 'aws-cdk-lib/aws-cognito';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import type { Construct } from 'constructs';

/** What the trigger needs from the `Auth` CDK construct. */
export interface PreSignUpTriggerOwner extends Construct {
	readonly fullId: string;
	/** The shared backend Lambda (`BlocksStack.handler`). */
	readonly handler: lambda.IFunction;
}

/** The function the trigger invokes, or an actionable synth error. */
function backendFunction(owner: PreSignUpTriggerOwner): lambda.IFunction {
	let fn: lambda.IFunction | undefined;
	try {
		fn = owner.handler;
	} catch {
		fn = undefined;
	}
	if (!fn || typeof fn.functionArn !== 'string') {
		throw new Error(
			`Auth '${owner.fullId}': \`validateUser\` runs as the user pool's Cognito PreSignUp trigger, which needs the ` +
				"app's backend Lambda, but this stack has none. Deploy the backend on the default Lambda compute.",
		);
	}
	return fn;
}

/**
 * Point the pool's PreSignUp trigger at the shared backend Lambda and let this
 * pool (only) invoke it. See the module documentation.
 *
 * @internal
 */
export function provisionPreSignUpTrigger(owner: PreSignUpTriggerOwner, pool: cognito.IUserPool): void {
	const fn = backendFunction(owner);
	// `isCfnResource` (a brand check), not `instanceof`: it survives two copies of
	// aws-cdk-lib in one dependency tree, where a silent skip would leave the
	// pool without its trigger.
	const cfnPool = pool.node.defaultChild;
	if (!cdk.CfnResource.isCfnResource(cfnPool) || cfnPool.cfnResourceType !== 'AWS::Cognito::UserPool') {
		throw new Error(`Auth '${owner.fullId}': the user pool has no CfnUserPool to attach the PreSignUp trigger to.`);
	}
	cfnPool.addPropertyOverride('LambdaConfig.PreSignUp', fn.functionArn);
	new lambda.CfnPermission(owner, 'pre-sign-up-permission', {
		action: 'lambda:InvokeFunction',
		functionName: fn.functionArn,
		principal: 'cognito-idp.amazonaws.com',
		sourceArn: pool.userPoolArn,
		sourceAccount: cdk.Stack.of(owner).account,
	});
}
