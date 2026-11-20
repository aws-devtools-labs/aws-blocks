// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Shared constants used across the CDK Blocks framework.
 *
 * Centralizes magic strings so directory names and conventions
 * can be updated in one place.
 */

/** Directory where sandbox/deploy config is written (relative to project root). */
export const BLOCKS_SANDBOX_DIR = '.cdk-blocks-sandbox';

/**
 * The directory name the runtime config is PUBLISHED under, which is a public URL
 * path and not a path on disk (D-031).
 *
 * It is deliberately NOT {@link BLOCKS_SANDBOX_DIR}. The disk directory was renamed
 * for the CDK Blocks rebrand; this was not, because a customer's already-deployed
 * frontend bundle asks for this path to resolve its API URL, and a browser or
 * CloudFront cache can keep asking for it after a deploy. Renaming it breaks those
 * pages until the customer redeploys, which renaming a private directory does not.
 *
 * The published sites in this package read it: the CloudFront behaviour, the S3 key
 * the config is uploaded to, the invalidation paths, the no-cache path, the liveness
 * probe, and the placeholder write whose on-disk path becomes that S3 key. Anything
 * touching the developer's own disk reads {@link BLOCKS_SANDBOX_DIR} instead.
 * `@aws-cdk-blocks/hosting` does not depend on this package, so its matching S3 exclude
 * repeats the value as a literal and is pinned by test instead.
 */
export const BLOCKS_SANDBOX_SERVED_DIR = '.blocks-sandbox';

/**
 * The name {@link BLOCKS_SANDBOX_DIR} had before the `cdk-blocks` rename (D-031).
 * An app upgrading from an earlier version still has its state under this name, so
 * the copy-forward step reads it; nothing else may. Losing `sandbox-id.txt` in
 * particular sends the next deploy to a different stack and leaves the customer's
 * old one standing in their account.
 *
 * It currently holds the same literal as {@link BLOCKS_SANDBOX_SERVED_DIR}, because
 * both predate the rename — a coincidence, not a relationship. This one names a
 * directory on an upgrading developer's disk that the migration reads once; that one
 * names a live public URL. Rebranding the served path later must not touch this
 * value, or the migration stops finding the state it exists to rescue.
 */
export const LEGACY_SANDBOX_DIR = '.blocks-sandbox';

/**
 * The hidden config folder's pre-rename name, read only where its absence would
 * fail silently: `getStackId`, because the secret and config prefixes answer an
 * unresolved id with unscoped names rather than failing. Never written.
 *
 * Telemetry's `getProjectId` also reads it, so an upgraded app keeps its project
 * id instead of being counted twice. Consent does not: #1606 removed the
 * CDK Blocks opt-out and consent now comes from CDK's own setting.
 *
 * The `${''}` split keeps a rename pass over this file from rewriting the value
 * into the new name, which is the mistake `check:rename-traps` trap 2 exists for.
 */
export const LEGACY_BLOCKS_DIR = `.blocks${''}`;

/** Default backend entry point directory name. */
export const BLOCKS_BACKEND_DIR = 'cdk-blocks';

/**
 * Backend directory of an app not yet migrated to {@link BLOCKS_BACKEND_DIR}.
 * Read by `migrate`, which takes a pre-rename app as its input, so this is a
 * fixed historical value: renaming it with the scaffolded directory stops
 * migrate detecting the apps it exists to migrate.
 */
export const LEGACY_BLOCKS_BACKEND_DIR = 'aws-blocks';

/**
 * Config key the deploy stamps this build's id under, inside the public runtime
 * config at `<BLOCKS_SANDBOX_SERVED_DIR>/config.json`. Written by the hosting
 * construct and read by the `--wait-live` liveness poll, which fetches that path
 * over HTTP — so it lives here to keep the two from drifting. Not the dev server's
 * local copy under {@link BLOCKS_SANDBOX_DIR}, which carries no build id.
 * Double-underscore-prefixed to mark it an internal field.
 */
export const BLOCKS_BUILD_ID_CONFIG_KEY = '__blocksBuildId';
