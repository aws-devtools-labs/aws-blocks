// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Multi-compute behind the managed CloudFront front door: `api` stays on the
 * default compute and `reports` runs on its own, smaller compute. Each method
 * reports which function served it, so a deployed call proves where it ran.
 */
import { ApiNamespace, Compute, Scope } from '@aws-blocks/blocks';

const scope = new Scope('multi-compute');

function whereAmI() {
  return {
    functionName: process.env.AWS_LAMBDA_FUNCTION_NAME ?? null,
    memoryMb: process.env.AWS_LAMBDA_FUNCTION_MEMORY_SIZE ?? null,
  };
}

export const api = new ApiNamespace(scope, 'api', () => ({
  async whereAmI() {
    return whereAmI();
  },
}));

const reportsCompute = new Compute(scope, 'reports', { type: 'serverless', memory: 512 });

// Constructed as 'reportsApi' but exported as `reports`: the gateway routes the
// export name, which is what the client calls.
export const reports = new ApiNamespace(scope, 'reportsApi', () => ({
  async whereAmI() {
    return whereAmI();
  },
}), { compute: reportsCompute });
