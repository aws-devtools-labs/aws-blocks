// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import * as cdk from 'aws-cdk-lib';
import type { Construct } from 'constructs';
import type { Compute } from './compute.js';

const REGISTRY_KEY = Symbol.for('BLOCKS_COMPUTE_REGISTRY');

/**
 * Get or create the compute list for a given stack. The list is stored on the
 * stack object (keyed by a Symbol), so each stack in a multi-stack synth gets
 * its own — a compute never leaks into another stack's list. Mirrors the config
 * registry (`config-registry.ts`), which scopes its state the same way.
 */
function getRegistry(stack: cdk.Stack): Compute[] {
	let list = (stack as any)[REGISTRY_KEY] as Compute[] | undefined;
	if (!list) {
		list = [];
		(stack as any)[REGISTRY_KEY] = list;
	}
	return list;
}

/**
 * Register a compute on its owning stack. Called from the {@link Compute} base
 * constructor, so every compute self-registers the moment it is constructed —
 * the finalize steps then enumerate them without a separate discovery pass
 * (mirrors how `registerConfig` accumulates config during the backend import).
 *
 * @param compute - The compute to register (used to locate its stack).
 */
export function registerCompute(compute: Compute): void {
	getRegistry(cdk.Stack.of(compute)).push(compute);
}

/**
 * The computes registered on the stack that owns `scope`, in construction
 * order. Returns an empty array before any compute is constructed.
 *
 * @param scope - Any construct in the stack (used to locate the stack).
 */
export function getComputes(scope: Construct): readonly Compute[] {
	return getRegistry(cdk.Stack.of(scope));
}
