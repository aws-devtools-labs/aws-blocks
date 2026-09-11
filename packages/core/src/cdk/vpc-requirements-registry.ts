// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import * as cdk from 'aws-cdk-lib';
import type { Construct } from 'constructs';
import type { VpcRequirements } from './vpc-types.js';

const REGISTRY_KEY = Symbol.for('BLOCKS_VPC_REQUIREMENTS_REGISTRY');

/** A registered requirement plus the fullId of the BB that declared it (for errors). */
export interface RegisteredVpcRequirement {
	readonly fullId: string;
	readonly requirements: VpcRequirements;
}

/**
 * Get or create the VPC-requirements list for a given stack. Stored on the stack
 * object (keyed by a Symbol), so each stack in a multi-stack synth gets its own —
 * a requirement never leaks into another stack's list. Mirrors the compute and
 * config registries, which scope their state the same way.
 */
function getRegistry(stack: cdk.Stack): RegisteredVpcRequirement[] {
	let list = (stack as any)[REGISTRY_KEY] as RegisteredVpcRequirement[] | undefined;
	if (!list) {
		list = [];
		(stack as any)[REGISTRY_KEY] = list;
	}
	return list;
}

/**
 * Register a Building Block's VPC requirements on its owning stack. Called from
 * the {@link BuildingBlockScope} base constructor, so every BB self-registers the
 * moment it is constructed — `finalizeVpc` then enumerates them without a separate
 * discovery pass (mirrors how `registerCompute`/`registerConfig` accumulate during
 * the backend import). Because it's driven by the base constructor, a BB **cannot**
 * silently skip declaring its requirements: the constructor won't compile without
 * supplying them (see `BuildingBlockScope`).
 *
 * @param bb - The construct declaring the requirement (used to locate its stack and name it).
 * @param requirements - What the BB needs from the VPC.
 */
export function registerVpcRequirements(
	bb: Construct & { readonly fullId: string },
	requirements: VpcRequirements,
): void {
	getRegistry(cdk.Stack.of(bb)).push({ fullId: bb.fullId, requirements });
}

/**
 * The VPC requirements registered on the stack that owns `scope`, in construction
 * order. Returns an empty array before any BB is constructed.
 *
 * @param scope - Any construct in the stack (used to locate the stack).
 */
export function getVpcRequirements(scope: Construct): readonly RegisteredVpcRequirement[] {
	return getRegistry(cdk.Stack.of(scope));
}

/** Clear the registry. **For test cleanup only.** */
export function _resetVpcRequirementsRegistry(stack: cdk.Stack): void {
	(stack as any)[REGISTRY_KEY] = [];
}
