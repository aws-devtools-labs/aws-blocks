// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Local-dev (mock) and types entry for the generic `Compute` block. Local dev
 * runs the backend in-process with no provisioned compute, so this selects and
 * returns the inert concrete handle; compute assignment is transparent in dev.
 * This entry also backs the package's public `types`.
 */
export { Compute } from './index.aws.js';
export type { ComputeProps } from './types.js';
