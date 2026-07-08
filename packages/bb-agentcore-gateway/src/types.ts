// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Shared, zero-runtime types for the AgentCore Gateway block.
 *
 * Mirrors Amazon Bedrock AgentCore Gateway: a Gateway exposes one or more
 * *targets* as MCP tools behind a single MCP endpoint. This block models a
 * Lambda-backed target whose tool handlers are ordinary TypeScript functions,
 * usable in-process by an in-app agent and (on AWS) reachable over MCP by
 * external agents.
 */

/** Minimal JSON-Schema describing a tool's input object. */
export interface ToolInputSchema {
  type: 'object';
  properties?: Record<string, unknown>;
  required?: string[];
  [k: string]: unknown;
}

/** A single tool: description, input schema, and the function that runs it. */
export interface ToolDefinition {
  description: string;
  inputSchema: ToolInputSchema;
  /** Executes the tool. Receives validated args, returns the tool result. */
  handler: (args: Record<string, unknown>) => unknown | Promise<unknown>;
}

/** Map of tool name → definition. */
export type ToolsConfig = Record<string, ToolDefinition>;

/** Inbound authorization mode for the gateway (who may call it). */
export type AuthorizerType = 'NONE' | 'AWS_IAM' | 'CUSTOM_JWT';

export interface CustomJwtAuthorizer {
  discoveryUrl: string;
  allowedClients?: string[];
  allowedAudience?: string[];
}

export interface AgentCoreGatewayOptions {
  /** The tools this gateway exposes. */
  tools: ToolsConfig;
  /** Inbound auth. Default 'AWS_IAM' on AWS; ignored locally. */
  authorizerType?: AuthorizerType;
  /** Required when authorizerType is 'CUSTOM_JWT'. */
  customJwtAuthorizer?: CustomJwtAuthorizer;
  removalPolicy?: 'destroy' | 'retain';
}

/** An MCP tool descriptor, as returned by `tools/list`. */
export interface McpTool {
  name: string;
  description: string;
  inputSchema: ToolInputSchema;
}

/** Result of an MCP `tools/call`. */
export interface ToolCallResult {
  /** The tool name that was invoked (resolved, un-prefixed). */
  tool: string;
  /** The value returned by the tool handler. */
  result: unknown;
}
