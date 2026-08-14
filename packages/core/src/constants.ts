// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Reserved namespace for AWS-managed framework features.
 * No user routes can be registered under this path.
 */
export const BLOCKS_NAMESPACE = '/aws-blocks';

/**
 * URL path prefix for the Blocks RPC endpoint.
 *
 * CloudFront behaviors route this path (and children) to the API Gateway
 * origin. Namespaced under `/aws-blocks/api` so it doesn't shadow
 * framework-conventional `/api/*` SSR routes (Next.js `pages/api/*`,
 * `app/api/*`, Nuxt `server/api/*`) on CloudFront's first-match-wins
 * behavior resolution.
 */
export const BLOCKS_RPC_PREFIX = '/aws-blocks/api';

/**
 * Reserved subtree for the auth Building Block's HTTP routes.
 *
 * Like {@link BLOCKS_RPC_PREFIX}, this lives under the reserved `/aws-blocks`
 * namespace so Hosting can proxy the whole auth flow (callback, sign-in,
 * exchange, authorize-params, the stub IdP, …) to the API Gateway origin with a
 * single CloudFront behavior — and so it never collides with a customer's own
 * `/auth/*` frontend routes. The auth BB mounts every route it owns under this
 * prefix; CloudFront forwards the subtree and the Lambda dispatches by path.
 */
export const BLOCKS_AUTH_PREFIX = '/aws-blocks/auth';

/**
 * Reserved path for the client runtime config (`config.json`).
 *
 * In production CloudFront serves `${BLOCKS_SANDBOX_PREFIX}/*` from S3 as
 * static assets (see hosting.ts) so the browser client can resolve its API
 * URL. The local dev server mirrors this by serving the config from the front
 * door itself, instead of proxying the request to the framework dev server —
 * which only serves its own static dir (Next.js `public/`, etc.) and would 404
 * on a project-root file. Keeping this symmetric with production is what makes
 * the browser client work the same in `dev`, `sandbox`, and deployed.
 */
export const BLOCKS_SANDBOX_PREFIX = '/.blocks-sandbox';
