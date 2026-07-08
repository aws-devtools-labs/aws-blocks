// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Local (mock) implementation of the AgentCore Gateway block.
 *
 * Simulates the aggregated MCP server in-process: `listTools()` returns MCP
 * descriptors and `callTool()` dispatches to the registered handlers — exactly
 * what the real gateway does over the network, but offline. This is the spirit
 * of AgentCore's local dev runtime for tools.
 */

import { Scope } from '@aws-blocks/core';
import type { ScopeParent } from '@aws-blocks/core';
import { BB_NAME, BB_VERSION } from './version.js';
import { callTool, listTools } from './dispatch.js';
import { gatewayTargetName } from './naming.js';
import type { AgentCoreGatewayOptions, McpTool, ToolCallResult } from './types.js';

export * from './types.js';
export { GatewayErrors } from './errors.js';
export { qualifyToolName, unqualifyToolName } from './dispatch.js';

export class AgentCoreGateway extends Scope {
  private readonly options: AgentCoreGatewayOptions;
  private readonly targetName: string;

  constructor(scope: ScopeParent, id: string, options: AgentCoreGatewayOptions) {
    super(id, { parent: scope, bbName: BB_NAME, bbVersion: BB_VERSION });
    this.options = options;
    this.targetName = gatewayTargetName(this.fullId);
  }

  /** MCP `tools/list` — descriptors for all tools (AgentCore-qualified names). */
  async listTools(): Promise<McpTool[]> {
    return listTools(this.targetName, this.options.tools);
  }

  /** MCP `tools/call` — run a tool by name (accepts qualified or bare names). */
  async callTool(name: string, args: Record<string, unknown> = {}): Promise<ToolCallResult> {
    return callTool(this.options.tools, name, args);
  }

  /** MCP endpoint URL. Empty locally — tools are invoked in-process. */
  getEndpoint(): string {
    return '';
  }
}
