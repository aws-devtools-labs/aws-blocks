// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Local-dev (mock) and types entry point for `LambdaCompute`.
 *
 * Local dev runs the backend in-process with no Lambda, so — as at runtime —
 * there is nothing for a compute to provision or execute. The mock reuses the
 * inert runtime handle: it constructs and its `setEnv` is a no-op. This entry
 * also backs the package's public `types`, so the customer-facing type is the
 * CDK-free `Compute` handle.
 */
export { LambdaCompute } from './index.aws.js';
export type { LambdaComputeProps } from './types.js';
