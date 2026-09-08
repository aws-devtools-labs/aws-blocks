// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Internal CDK entry point — framework- and test-only surface that is
 * intentionally NOT part of the public API (`@aws-blocks/core` /
 * `@aws-blocks/core/cdk`).
 *
 * The compute abstraction lives behind this path while it has no public,
 * customer-facing surface. Importing from here is a signal that you are inside
 * the framework or a test, not a customer.
 *
 * Planned removal: once a customer can assign a compute and have it actually
 * take effect — i.e. `this.compute` resolution and request routing to the
 * chosen compute both exist, plus a synth-time guard that rejects an assignment
 * with no route — these exports move to the public CDK entry point
 * (`@aws-blocks/core/cdk`, re-exported from `index.cdk.ts`) and this file is
 * deleted. It must NOT be made public before then: a compute a customer can
 * declare but that is silently ignored is a worse experience than not having
 * the feature. Until that flip, treat everything here as unstable — no
 * backward-compatibility guarantee.
 *
 * @internal
 */

export { Compute } from './compute/compute.js';
export type { DefaultComputeFactory } from './compute/default-compute-factory.js';
// Reserved `/aws-blocks` path segment, needed by concrete computes (e.g.
// LambdaCompute in @aws-blocks/bb-lambda-compute) to build their API route tree.
export { BLOCKS_NAMESPACE } from '../constants.js';
