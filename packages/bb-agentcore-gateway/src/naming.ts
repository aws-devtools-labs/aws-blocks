// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/** Env-var keys shared between the CDK layer (writer) and aws runtime (reader). */
function base(fullId: string): string {
  return fullId.replace(/[^A-Za-z0-9_]/g, '_').toUpperCase();
}

export function gatewayUrlEnvVar(fullId: string): string {
  return `BLOCKS_AGENTCORE_GATEWAY_${base(fullId)}_URL`;
}

/** Sanitized target name used for AgentCore-qualified tool names (MCP wire). */
export function gatewayTargetName(fullId: string): string {
  return fullId.replace(/[^A-Za-z0-9_-]/g, '_');
}

/**
 * A valid AgentCore Gateway / GatewayTarget resource name:
 * `^([0-9a-zA-Z][-]?){1,100}$` — alphanumerics with optional single hyphens,
 * no underscores, must start alphanumeric, max ~100.
 */
export function gatewayResourceName(fullId: string): string {
  let n = fullId
    .replace(/[^A-Za-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!/^[0-9a-zA-Z]/.test(n)) n = `g${n}`;
  return n.substring(0, 100).replace(/-+$/, '');
}
