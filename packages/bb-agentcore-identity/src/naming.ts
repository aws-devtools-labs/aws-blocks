// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/** Env-var key (CDK writes, aws runtime reads) for the workload identity name. */
export function workloadEnvVar(fullId: string): string {
  return `BLOCKS_AGENTCORE_IDENTITY_${fullId.replace(/[^A-Za-z0-9_]/g, '_').toUpperCase()}_WORKLOAD`;
}

/** Default workload identity name derived from a block's fullId. */
export function defaultWorkloadName(fullId: string): string {
  return fullId.replace(/[^A-Za-z0-9_-]/g, '_').substring(0, 100);
}
