// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import * as cdk from 'aws-cdk-lib';
import type { Construct } from 'constructs';
import { getComputes } from './compute/compute-registry.js';

const REGISTRY_KEY = Symbol.for('BLOCKS_TRACER_PRESENCE');

/**
 * Mark that the app contains a `Tracer`. Tracing is **presence-gated**: a Tracer
 * anywhere in the app means every compute should be traced (X-Ray provisions
 * real, costed infra, so it's off unless the app opts in by creating a Tracer).
 * Multiple Tracers are fine — this just records the boolean. Stored per stack
 * (keyed by a Symbol), like the config/compute registries.
 *
 * @param scope - Any construct in the stack (used to locate the stack).
 */
export function registerTracer(scope: Construct): void {
	(cdk.Stack.of(scope) as unknown as Record<symbol, boolean>)[REGISTRY_KEY] = true;
}

function hasTracer(stack: cdk.Stack): boolean {
	return (stack as unknown as Record<symbol, boolean | undefined>)[REGISTRY_KEY] === true;
}

/**
 * If the app contains a `Tracer`, enable tracing on **every** compute in the
 * stack. Runs once at the end of `create()` (after the backend module has
 * imported, so all computes are registered). `Compute.enableTracing()` is
 * idempotent, so this is safe regardless of how many Tracers exist.
 *
 * @param scope - Any construct in the stack (used to locate the stack).
 */
export function finalizeTracing(scope: Construct): void {
	const stack = cdk.Stack.of(scope);
	if (!hasTracer(stack)) return;
	for (const compute of getComputes(scope)) compute.enableTracing();
}
