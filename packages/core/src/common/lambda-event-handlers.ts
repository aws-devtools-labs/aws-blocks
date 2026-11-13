// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The one-handler-per-event-key rule shared by the Lambda runtime
 * (`Scope.registerLambdaEventHandler` in `./index.ts`) and the CDK layer
 * (`Scope.registerLambdaEventHandler` in `../cdk/index.ts`). Both derive the key
 * and word the error here, so a configuration that synth accepts is one the
 * Lambda accepts too.
 *
 * Not re-exported from the package root.
 *
 * @module
 * @internal
 */

/**
 * The routing key for a Lambda event handler: `{eventSource}:{identifier}`.
 *
 * @internal
 */
export function lambdaEventHandlerKey(eventSource: string, identifier: string): string {
	return `${eventSource}:${identifier}`;
}

/**
 * The error for a second registration under `key`. Names both blocks when the
 * first owner is known.
 *
 * @internal
 */
export function duplicateLambdaEventHandlerError(key: string, fullId: string, ownerFullId?: string): Error {
	const owner = ownerFullId ? `Building Block '${ownerFullId}'` : 'another Building Block';
	return new Error(
		`Scope '${fullId}': a Lambda event handler for "${key}" is already registered by ${owner}. ` +
			'Each event source is handled by exactly one block, so two blocks cannot both ' +
			'consume the same queue, schedule, WebSocket API or Cognito user pool trigger. Give each its own ' +
			'resource, or let only one of them own it.',
	);
}
