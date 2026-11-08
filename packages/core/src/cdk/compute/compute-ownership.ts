// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import type { Construct } from 'constructs';
import { getBlocksRoot } from '../root-registry.js';
import type { ComputeBase } from './compute.js';

/**
 * Why `block` can't run on `compute`, or `undefined` when it can: the compute
 * belongs to a different backend than the block.
 *
 * That happens when several backends are built from one backend module and the
 * `Compute` comes from a sub-module: `create()` re-runs only the top-level
 * module per backend, so the sub-module's `Compute` stays bound to the first
 * backend that imported it. Wiring a job to it would make another backend's
 * function its target — a cross-stack reference to a function that never
 * registered this job's handler. (An API namespace in the same situation is
 * served by its own backend's default compute instead; see
 * `resolveNamespaceRoutes`.)
 *
 * @returns the reason, worded to follow `<Block> "<fullId>" `, or `undefined`.
 * @internal
 */
export function foreignComputeProblem(block: Construct, compute: ComputeBase): string | undefined {
	const owner = getBlocksRoot(compute);
	if (owner === getBlocksRoot(block)) return undefined;
	return (
		`resolves to compute '${compute.node.path}', which belongs to another backend ('${owner.node.path}'). ` +
		'A Compute created in a module that several backends share stays bound to the first backend that imported ' +
		"it: create it in this backend's top-level backend module (backendCDKPath), so each backend gets its own."
	);
}
