// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Shared env-var naming so the CDK layer (which writes the value) and the AWS
 * runtime layer (which reads it) agree on the key derived from a block's fullId.
 */
export function memoryEnvVar(fullId: string): string {
  return `BLOCKS_AGENTCORE_MEMORY_${fullId.replace(/[^A-Za-z0-9_]/g, '_').toUpperCase()}_ID`;
}

/**
 * A valid AgentCore Memory resource name: `^[a-zA-Z][a-zA-Z0-9_]{0,47}$`
 * (letters/digits/underscore only, must start with a letter, max 48 chars).
 */
export function memoryResourceName(fullId: string): string {
  let n = fullId.replace(/[^A-Za-z0-9]/g, '_');
  if (!/^[A-Za-z]/.test(n)) n = `m_${n}`;
  return n.substring(0, 48);
}
