// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * VPC Smoke Test — Lambda handler entry point.
 * Re-exports the BB instances for the runtime to use.
 */

export { kv, table, files, job, setting, rt, auth, logger, metrics, tracer } from './index.js';

export const handler = undefined; // Blocks wires this automatically
