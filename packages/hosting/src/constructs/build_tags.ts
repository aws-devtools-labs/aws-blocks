// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Shared build-artifact tag constants.
//
// This module is intentionally dependency-free (no `aws-cdk-lib`, no
// `constructs`) so it can be imported by BOTH the CDK construct
// (`storage_construct.ts`) and the esbuild-bundled Lambda handler
// (`kv_keys_handler.ts`) without dragging the CDK library into the Lambda
// bundle. Keep it free of any non-type imports.

/**
 * Object tag key that marks a build's objects as SUPERSEDED — i.e. no longer
 * the build that KVS `meta.b` points to. The `DeleteOldBuilds` S3 lifecycle
 * rule matches ONLY objects carrying this tag, so the in-service build (which
 * is never tagged) is never expired, regardless of deploy cadence (issue #480).
 *
 * S3 lifecycle `TagFilters` are inclusion-only (there is no "NOT tagged"
 * predicate), which is why we tag the superseded build rather than tagging the
 * live build and excluding it.
 */
export const BUILD_STATE_TAG_KEY = 'aws-blocks:build-state';

/** Tag value applied to a build once it is no longer the live build. */
export const BUILD_STATE_SUPERSEDED = 'superseded';
