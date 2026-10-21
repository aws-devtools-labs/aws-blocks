// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Keep the GSI manager's log groups owned by the stack.
 *
 * The GSI manager's Lambdas (the onEvent and isComplete handlers, plus the
 * `cr.Provider` framework functions) log to `logs.LogGroup`s the stack creates
 * and deletes. Their roles still carry `AWSLambdaBasicExecutionRole`, which
 * allows `logs:CreateLogGroup`. During `destroy()` a framework function flushes
 * its last lines a few seconds after CloudFormation has deleted its group, and
 * that permission let the flush recreate the group outside the stack, where it
 * outlived the stack. An explicit deny keeps `CreateLogStream` / `PutLogEvents`
 * working on the owned group and turns a late flush into a dropped line instead
 * of an orphaned group.
 *
 * @internal
 */

import { Effect, PolicyStatement } from 'aws-cdk-lib/aws-iam';
import { Function as LambdaFunction, type IFunction } from 'aws-cdk-lib/aws-lambda';
import type { Provider } from 'aws-cdk-lib/custom-resources';

/** Construct ids of the framework functions a `cr.Provider` with an isComplete handler creates. */
const FRAMEWORK_FUNCTION_IDS = ['framework-onEvent', 'framework-isComplete', 'framework-onTimeout'] as const;

/** Deny `logs:CreateLogGroup` to `fn`'s role. A no-op for a function without one. */
export function denyLogGroupCreation(fn: IFunction): void {
	fn.role?.addToPrincipalPolicy(
		new PolicyStatement({
			effect: Effect.DENY,
			actions: ['logs:CreateLogGroup'],
			resources: ['*'],
		}),
	);
}

/**
 * The framework functions `provider` created for itself. Throws if an
 * aws-cdk-lib upgrade renames one, so the deny can't silently stop applying.
 */
export function providerFrameworkFunctions(provider: Provider): LambdaFunction[] {
	return FRAMEWORK_FUNCTION_IDS.map((id) => {
		const fn = provider.node.tryFindChild(id);
		if (!(fn instanceof LambdaFunction)) {
			throw new Error(
				`bb-distributed-table: cr.Provider '${provider.node.path}' has no '${id}' function; aws-cdk-lib changed its provider framework layout`,
			);
		}
		return fn;
	});
}

/** {@link denyLogGroupCreation} for the provider's handlers and every framework function. */
export function keepProviderLogGroupsOwned(handlers: IFunction[], provider: Provider): void {
	for (const fn of [...handlers, ...providerFrameworkFunctions(provider)]) denyLogGroupCreation(fn);
}
