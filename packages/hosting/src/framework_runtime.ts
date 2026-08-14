// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Single source of truth for the AWS-managed Node.js runtime that executes the
 * SSR/server bundles the framework adapters emit (Next.js/OpenNext, Nitro,
 * Astro, SvelteKit). Adapters must reference this constant instead of writing a
 * `nodejs*.x` literal into the manifest, so a runtime bump is a one-line change.
 *
 * Scope: REGIONAL framework compute only. Lambda@Edge compute uses
 * {@link FRAMEWORK_EDGE_COMPUTE_RUNTIME}, which lags behind by design.
 */
export const FRAMEWORK_COMPUTE_RUNTIME = 'nodejs24.x';

/**
 * Runtime for framework compute placed at the edge (Lambda@Edge / CloudFront
 * `placement: 'global'`).
 *
 * Deliberately pinned to `nodejs20.x` and NOT bumped in lockstep with
 * {@link FRAMEWORK_COMPUTE_RUNTIME} for two reasons:
 *
 * 1. Lambda@Edge supports only a subset of Lambda's managed runtimes (see
 *    https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/lambda-at-edge-function-restrictions.html)
 *    and trails the general Lambda runtime catalog. Emitting an unsupported
 *    runtime makes the CloudFront association fail at deploy time, not at synth.
 * 2. `patchEdgeBundlesForLambdaEdge` in the Next.js adapter rewrites the
 *    OpenNext `node:process` namespace-import banner specifically for the Node 20
 *    ESM semantics this runtime provides; bumping the runtime without revalidating
 *    that patch would risk a cold-start `TypeError` on `process.env` assignment.
 *
 * Bump only after confirming Lambda@Edge support AND re-validating the edge
 * bundle patch against the target Node version.
 */
export const FRAMEWORK_EDGE_COMPUTE_RUNTIME = 'nodejs20.x';
