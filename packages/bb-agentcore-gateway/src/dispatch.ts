// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Shared MCP-style tool dispatch, used by both the mock and aws runtime layers.
 *
 * The tool *handlers* are TypeScript functions defined in the backend, so this
 * logic is identical whether running locally or in Lambda — the gateway's tools
 * are usable in-process by an in-app agent in both contexts. (On AWS the CDK
 * layer additionally exposes the same tools over a real MCP endpoint for
 * external agents.)
 */

import { gatewayError, GatewayErrors } from './errors.js';
import type { McpTool, ToolCallResult, ToolsConfig } from './types.js';

/** AgentCore tool-name separator: `${targetName}___${toolName}`. */
export const TOOL_NAME_SEP = '___';

/** Build the AgentCore-style qualified tool name. */
export function qualifyToolName(targetName: string, tool: string): string {
  return `${targetName}${TOOL_NAME_SEP}${tool}`;
}

/** Strip an optional `${targetName}___` prefix, returning the bare tool name. */
export function unqualifyToolName(name: string): string {
  const idx = name.lastIndexOf(TOOL_NAME_SEP);
  return idx === -1 ? name : name.slice(idx + TOOL_NAME_SEP.length);
}

/** MCP `tools/list`: descriptors for every tool, with AgentCore-qualified names. */
export function listTools(targetName: string, tools: ToolsConfig): McpTool[] {
  return Object.entries(tools).map(([name, def]) => ({
    name: qualifyToolName(targetName, name),
    description: def.description,
    inputSchema: def.inputSchema,
  }));
}

/** MCP `tools/call`: validate args against the schema and run the handler. */
export async function callTool(
  tools: ToolsConfig,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolCallResult> {
  const tool = unqualifyToolName(name);
  const def = tools[tool];
  if (!def) {
    throw gatewayError(GatewayErrors.ToolNotFound, `Unknown tool "${name}"`);
  }
  validateArgs(tool, def.inputSchema.required ?? [], args);
  const result = await def.handler(args ?? {});
  return { tool, result };
}

function validateArgs(tool: string, required: string[], args: Record<string, unknown>): void {
  const provided = args ?? {};
  const missing = required.filter((k) => provided[k] === undefined || provided[k] === null);
  if (missing.length > 0) {
    throw gatewayError(
      GatewayErrors.InvalidInput,
      `Tool "${tool}" missing required argument(s): ${missing.join(', ')}`,
    );
  }
}
