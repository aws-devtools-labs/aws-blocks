// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Names shared by the CDN invalidation handler (`../nextjs_cdn_invalidation.ts`,
 * runtime), the Next.js adapter and the construct that wires it
 * (`../../constructs/cdn_invalidation.ts`). Kept apart from the handler so the
 * build and synth code don't load its AWS SDK clients.
 *
 * @module
 */

/** Env var naming the SSM parameter that holds the distribution id. */
export const CDN_INVALIDATION_PARAM_ENV = 'HOSTING_CDN_INVALIDATION_PARAM';

/** Env var holding the app's `basePath` (unset when there is none). */
export const CDN_INVALIDATION_BASE_PATH_ENV = 'HOSTING_CDN_INVALIDATION_BASE_PATH';

/** The handler's `name` (what OpenNext logs for the override). */
export const CDN_INVALIDATION_HANDLER_NAME = 'cdk-blocks-hosting-cloudfront';

/**
 * File name of the self-contained handler bundle
 * (`dist/adapters/nextjs_cdn_invalidation_bundle.mjs`) inside each OpenNext
 * server function bundle, next to its `open-next.config.mjs`.
 */
export const CDN_INVALIDATION_BUNDLE_FILE = 'cdk-blocks-cdn-invalidation.mjs';
