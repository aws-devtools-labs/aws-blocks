// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Local-dev (mock) and types entry for the generic `Compute` block. Local dev
 * runs the backend in-process with no provisioned compute, so this selects and
 * returns the inert concrete handle; compute assignment is transparent in dev.
 * This entry also backs the package's public `types`.
 */

import { assertNotMockInDeployedEnv } from '@aws-blocks/core/bb-utils';

// Fail closed if this mock entry loads in a deployed env — see assertNotMockInDeployedEnv.
assertNotMockInDeployedEnv('bb-compute');

export { Compute } from './index.aws.js';
export type { ComputeProps } from './types.js';
