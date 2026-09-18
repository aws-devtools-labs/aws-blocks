// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Internal CDK entry point — framework- and test-only surface that is
 * intentionally NOT part of the public API (`@aws-blocks/core` /
 * `@aws-blocks/core/cdk`).
 *
 * The compute *abstraction* itself (`Compute`) is now public — it is what
 * `ComputeProvider.provide()` returns and what a workload is assigned to — and
 * lives on `@aws-blocks/core/cdk`. It is re-exported here as well so the
 * framework's own compute code can keep a single internal import site; new
 * framework code may import it from either path. What is *only* here is the
 * compute *plumbing*: how the default compute is built and how finalize steps
 * enumerate the computes on a stack. Importing from here is a signal that you are
 * inside the framework or a test, not a customer. Everything here is unstable —
 * no backward-compatibility guarantee.
 *
 * @internal
 */

// Reserved `/aws-blocks` path segment, needed by concrete computes (e.g.
// LambdaCompute in @aws-blocks/bb-lambda-compute) to build their API route tree.
export { BLOCKS_NAMESPACE } from '../constants.js';
// Re-exported for framework code; the public home is `@aws-blocks/core/cdk`.
export { Compute } from './compute/compute.js';
export type { ComputeDashboardSection } from './compute/compute.js';
// Enumerate the computes registered on a stack — the Dashboard BB's default
// compute selection resolves through this at finalize.
export { getComputes } from './compute/compute-registry.js';
// How the umbrella (`@aws-blocks/blocks`) supplies the stack's default compute
// without core importing a concrete compute class.
export type { DefaultComputeFactory } from './compute/default-compute-factory.js';
