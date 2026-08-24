// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Single source of truth for the AWS-managed Node.js runtime that executes the
 * SSR/server bundles the framework adapters emit (Next.js/OpenNext, Nitro,
 * Astro, SvelteKit). Adapters must reference this constant instead of writing a
 * `nodejs*.x` literal into the manifest, so a runtime bump is a one-line change.
 *
 * Scope: REGIONAL framework compute only. Lambda@Edge compute uses
 * {@link FRAMEWORK_EDGE_COMPUTE_RUNTIME}, which is tracked separately because
 * Lambda@Edge can only associate a subset of Lambda's managed runtimes.
 *
 * Note: this constant and {@link FRAMEWORK_EDGE_COMPUTE_RUNTIME} currently hold
 * the same value by coincidence, not by design — they are governed by different
 * support tables and must be evaluated and bumped independently. Do not collapse
 * them into a single constant.
 */
export const FRAMEWORK_COMPUTE_RUNTIME = 'nodejs24.x';

/**
 * Runtime for framework compute placed at the edge (Lambda@Edge / CloudFront
 * `placement: 'global'`).
 *
 * Tracked as its own constant because Lambda@Edge supports only a subset of
 * Lambda's managed runtimes (see
 * https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/lambda-at-edge-function-restrictions.html);
 * emitting an unsupported runtime fails the CloudFront association at deploy
 * time, not at synth. For Node.js, Lambda@Edge draws from the same managed
 * runtime table as regional Lambda: `nodejs24.x` is supported (deprecates
 * 2028-04-30), while `nodejs20.x` is already past its 2026-04-30 deprecation
 * and can no longer back newly-created edge functions.
 *
 * `patchEdgeBundlesForLambdaEdge` in the Next.js adapter, which rewrites the
 * OpenNext `node:process` namespace-import banner, was revalidated against this
 * runtime: the crash it fixes stems from ES Module namespace exports being
 * non-writable per the ECMAScript spec — not from a Node 20 quirk — and its
 * replacement relies only on top-level `await import(...)` plus the long-stable
 * `node:process` default export. Both behave identically on Node 20/22/24.
 *
 * Bump only after confirming Lambda@Edge support AND re-validating the edge
 * bundle patch against the target Node version.
 */
export const FRAMEWORK_EDGE_COMPUTE_RUNTIME = 'nodejs24.x';
