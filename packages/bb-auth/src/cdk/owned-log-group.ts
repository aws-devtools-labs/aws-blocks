// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Keep a deploy-time Lambda's log group owned by the stack (L80).
 *
 * `Auth`'s deploy-time Lambdas (the pool guard and the IdP registration, each an
 * onEvent function plus its `cr.Provider` framework function) log to a
 * `logs.LogGroup` the stack creates and deletes. Their roles still carry
 * `AWSLambdaBasicExecutionRole`, which allows `logs:CreateLogGroup`. During
 * `destroy()` the framework function flushes its last lines a few seconds after
 * CloudFormation has deleted its group, and that permission let the flush
 * recreate the group outside the stack, where it outlived the stack. An explicit
 * deny keeps `CreateLogStream` / `PutLogEvents` working on the owned group and
 * turns a late flush into a dropped line instead of an orphaned group.
 *
 * @internal
 */

import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import type * as cr from 'aws-cdk-lib/custom-resources';

/** Deny `logs:CreateLogGroup` to `fn`'s role. A no-op for a function without one. */
export function denyLogGroupCreation(fn: lambda.IFunction): void {
	fn.role?.addToPrincipalPolicy(
		new iam.PolicyStatement({
			effect: iam.Effect.DENY,
			actions: ['logs:CreateLogGroup'],
			resources: ['*'],
		}),
	);
}

/**
 * The framework onEvent function a `cr.Provider` creates for itself (construct
 * id `framework-onEvent`, CDK's `FRAMEWORK_ON_EVENT_HANDLER_NAME`). Throws if a
 * CDK upgrade renames it, so the deny can't silently stop applying.
 */
export function providerFrameworkFunction(provider: cr.Provider): lambda.Function {
	const fn = provider.node.tryFindChild('framework-onEvent');
	if (!(fn instanceof lambda.Function)) {
		throw new Error(
			`bb-auth: cr.Provider '${provider.node.path}' has no 'framework-onEvent' function; aws-cdk-lib changed its provider framework layout`,
		);
	}
	return fn;
}

/** {@link denyLogGroupCreation} for a provider's onEvent handler and its framework function. */
export function keepProviderLogGroupsOwned(onEvent: lambda.IFunction, provider: cr.Provider): void {
	denyLogGroupCreation(onEvent);
	denyLogGroupCreation(providerFrameworkFunction(provider));
}
