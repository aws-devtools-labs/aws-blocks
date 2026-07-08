// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * AWS runtime implementation of the AgentCore Gateway block.
 *
 * The tool handlers live in this same backend bundle, so `listTools` / `callTool`
 * dispatch in-process — making the gateway's tools usable by an in-app agent
 * identically in local dev and on AWS. In addition, `getEndpoint()` returns the
 * real AgentCore Gateway MCP URL (provisioned by the CDK layer), which external
 * agents / the AgentCore Runtime use to reach the same tools over MCP.
 */

import { Scope } from '@aws-blocks/core';
import type { ScopeParent } from '@aws-blocks/core';
import { BB_NAME, BB_VERSION } from './version.js';
import { callTool, listTools } from './dispatch.js';
import { gatewayTargetName, gatewayUrlEnvVar } from './naming.js';
import type { AgentCoreGatewayOptions, McpTool, ToolCallResult } from './types.js';

export * from './types.js';
export { GatewayErrors } from './errors.js';
export { qualifyToolName, unqualifyToolName } from './dispatch.js';

export class AgentCoreGateway extends Scope {
  private readonly options: AgentCoreGatewayOptions;
  private readonly targetName: string;
  private readonly endpoint: string;

  constructor(scope: ScopeParent, id: string, options: AgentCoreGatewayOptions) {
    super(id, { parent: scope, bbName: BB_NAME, bbVersion: BB_VERSION });
    this.options = options;
    this.targetName = gatewayTargetName(this.fullId);
    this.endpoint = process.env[gatewayUrlEnvVar(this.fullId)] ?? '';
  }

  async listTools(): Promise<McpTool[]> {
    return listTools(this.targetName, this.options.tools);
  }

  async callTool(name: string, args: Record<string, unknown> = {}): Promise<ToolCallResult> {
    return callTool(this.options.tools, name, args);
  }

  /** The AgentCore Gateway MCP endpoint URL for external MCP clients. */
  getEndpoint(): string {
    return this.endpoint;
  }
}
