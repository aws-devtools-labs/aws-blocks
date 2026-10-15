// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Shared constants used across the Blocks framework.
 *
 * Centralizes magic strings so directory names and conventions
 * can be updated in one place.
 */

/** Directory where sandbox/deploy config is written (relative to project root). */
export const BLOCKS_SANDBOX_DIR = '.blocks-sandbox';

/** Default backend entry point directory name. */
export const BLOCKS_BACKEND_DIR = 'aws-blocks';

/**
 * Config key the deploy stamps this build's id under, inside the public runtime
 * config at `<BLOCKS_SANDBOX_DIR>/config.json`. Written by the hosting construct
 * and read by the `--wait-live` liveness poll, so it lives here to keep the two
 * from drifting. Double-underscore-prefixed to mark it an internal field.
 */
export const BLOCKS_BUILD_ID_CONFIG_KEY = '__blocksBuildId';

/**
 * Prefix of the single machine-readable success line a deploy prints last
 * (`BLOCKS_DEPLOYED url=… api=…`). Shared so the producer (`formatDeploySignal`)
 * and the log reader (`parseDeployStatus`) grep for the exact same token.
 */
export const BLOCKS_DEPLOYED_PREFIX = 'BLOCKS_DEPLOYED';

/**
 * The terminal failure banner a deploy prints to stdout when `cdk deploy` fails.
 * Shared so the producer (`deploy()`/`sandbox()`) and the log reader
 * (`parseDeployStatus`) use the same string — a drift between them would make a
 * failed deploy read as "still running" forever.
 */
export const BLOCKS_DEPLOY_FAILED_LINE = '❌ Deployment failed.';
