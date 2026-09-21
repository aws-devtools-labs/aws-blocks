// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import type { Construct } from 'constructs';
import { getBlocksRoot } from '../root-registry.js';
import type { Compute } from './compute.js';

const REGISTRY_KEY = Symbol.for('BLOCKS_COMPUTE_REGISTRY');

/**
 * Get or create the compute list for a given backend root. The list is stored on
 * the root object (keyed by a Symbol), so each `BlocksStack`/`BlocksBackend` gets
 * its own — a compute never leaks into another backend's list, even when two
 * backends share one `cdk.Stack`. Mirrors the config registry
 * (`config-registry.ts`), which scopes its state the same way.
 */
function getRegistry(root: Construct): Compute[] {
	let list = (root as any)[REGISTRY_KEY] as Compute[] | undefined;
	if (!list) {
		list = [];
		(root as any)[REGISTRY_KEY] = list;
	}
	return list;
}

/**
 * Register a compute on its owning backend root. Called from the {@link Compute}
 * base constructor, so every compute self-registers the moment it is constructed
 * — the finalize steps then enumerate them without a separate discovery pass
 * (mirrors how `registerConfig` accumulates config during the backend import).
 *
 * @param compute - The compute to register (used to locate its backend root).
 */
export function registerCompute(compute: Compute): void {
	getRegistry(getBlocksRoot(compute)).push(compute);
}

/**
 * The computes registered on the backend root that owns `scope`, in construction
 * order. Returns an empty array before any compute is constructed.
 *
 * @param scope - Any construct in the backend (used to locate the backend root).
 */
export function getComputes(scope: Construct): readonly Compute[] {
	return getRegistry(getBlocksRoot(scope));
}
