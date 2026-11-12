// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Internal runtime seams for AWS Blocks' own Building Blocks.
 *
 * Imported as `@aws-blocks/core/internal`. Not part of the public API: these
 * can change in any release. Runtime only (no CDK imports), so it is safe in a
 * Lambda bundle. The CDK counterpart is `@aws-blocks/core/cdk/internal`.
 *
 * @internal
 * @module
 */

export { CONFIG_REFRESH_MIN_INTERVAL_MS, refreshConfig } from './common/config.js';
