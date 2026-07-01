// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * CDK (infrastructure) implementation of the AgentCore Gateway block.
 *
 * Provisions:
 *  - an Amazon Bedrock AgentCore Gateway (`AWS::BedrockAgentCore::Gateway`) with
 *    the configured inbound authorizer, returning an MCP endpoint URL;
 *  - a Lambda gateway target (`AWS::BedrockAgentCore::GatewayTarget`) whose tool
 *    schema is derived from the block's `tools`, pointing at the Blocks handler;
 *  - the IAM wiring for the gateway to invoke the handler.
 *
 * The gateway URL is injected into the handler environment for `getEndpoint()`.
 * Runtime tool dispatch (`listTools`/`callTool`) runs in the aws-runtime build.
 */

import { CfnResource, RemovalPolicy } from 'aws-cdk-lib';
import { PolicyStatement, Role, ServicePrincipal } from 'aws-cdk-lib/aws-iam';
import { Scope, synthGuard } from '@aws-blocks/core/cdk';
import type { ScopeParent } from '@aws-blocks/core';
import { BB_NAME, BB_VERSION } from './version.js';
import { gatewayResourceName, gatewayUrlEnvVar } from './naming.js';
import type {
  AgentCoreGatewayOptions,
  McpTool,
  ToolCallResult,
  ToolInputSchema,
} from './types.js';

export * from './types.js';
export { GatewayErrors } from './errors.js';
export { qualifyToolName, unqualifyToolName } from './dispatch.js';

export class AgentCoreGateway extends Scope {
  constructor(scope: ScopeParent, id: string, options: AgentCoreGatewayOptions) {
    super(id, { parent: scope, bbName: BB_NAME, bbVersion: BB_VERSION });

    const authorizerType = options.authorizerType ?? 'AWS_IAM';

    // Service role the gateway assumes to invoke the target Lambda (outbound auth).
    const gatewayRole = new Role(this, 'gw-role', {
      assumedBy: new ServicePrincipal('bedrock-agentcore.amazonaws.com'),
    });
    gatewayRole.addToPolicy(
      new PolicyStatement({
        actions: ['lambda:InvokeFunction'],
        resources: [this.handler.functionArn],
      }),
    );

    const gateway = new CfnResource(this, 'gateway', {
      type: 'AWS::BedrockAgentCore::Gateway',
      properties: {
        Name: gatewayResourceName(this.fullId),
        ProtocolType: 'MCP',
        RoleArn: gatewayRole.roleArn,
        AuthorizerType: authorizerType,
        ...(authorizerType === 'CUSTOM_JWT' && options.customJwtAuthorizer
          ? {
              AuthorizerConfiguration: {
                CustomJWTAuthorizer: {
                  DiscoveryUrl: options.customJwtAuthorizer.discoveryUrl,
                  AllowedClients: options.customJwtAuthorizer.allowedClients,
                  AllowedAudience: options.customJwtAuthorizer.allowedAudience,
                },
              },
            }
          : {}),
      },
    });
    if (options.removalPolicy === 'retain') gateway.applyRemovalPolicy(RemovalPolicy.RETAIN);

    const gatewayId = gateway.ref;

    // Lambda target exposing the block's tools as MCP tools.
    const target = new CfnResource(this, 'target', {
      type: 'AWS::BedrockAgentCore::GatewayTarget',
      properties: {
        GatewayIdentifier: gatewayId,
        Name: gatewayResourceName(`${this.fullId}-target`),
        TargetConfiguration: {
          Mcp: {
            Lambda: {
              LambdaArn: this.handler.functionArn,
              ToolSchema: { InlinePayload: toInlineToolSchema(options) },
            },
          },
        },
        CredentialProviderConfigurations: [{ CredentialProviderType: 'GATEWAY_IAM_ROLE' }],
      },
    });
    target.addDependency(gateway);

    // Allow the gateway service to invoke our handler.
    this.handler.addPermission('agentcore-gateway-invoke', {
      principal: new ServicePrincipal('bedrock-agentcore.amazonaws.com'),
    });

    this.handler.addEnvironment(
      gatewayUrlEnvVar(this.fullId),
      gateway.getAtt('GatewayUrl').toString(),
    );
  }

  // --- runtime methods: only valid in the aws-runtime build ---
  async listTools(): Promise<McpTool[]> {
    return synthGuard('AgentCoreGateway', 'listTools');
  }
  async callTool(_name: string, _args?: Record<string, unknown>): Promise<ToolCallResult> {
    return synthGuard('AgentCoreGateway', 'callTool');
  }
  getEndpoint(): string {
    return synthGuard('AgentCoreGateway', 'getEndpoint');
  }
}

function toInlineToolSchema(options: AgentCoreGatewayOptions): Array<Record<string, unknown>> {
  return Object.entries(options.tools).map(([name, def]) => ({
    Name: name,
    Description: def.description,
    InputSchema: toAgentCoreSchema(def.inputSchema),
  }));
}

/**
 * Convert a JSON-Schema-style node into AgentCore's PascalCase `SchemaDefinition`
 * ({ Type, Properties, Required, Items, Description }).
 */
function toAgentCoreSchema(node: ToolInputSchema | Record<string, unknown>): Record<string, unknown> {
  const n = node as Record<string, unknown>;
  const out: Record<string, unknown> = { Type: (n.type as string) ?? 'object' };
  if (typeof n.description === 'string') out.Description = n.description;
  if (n.type === 'object' && n.properties && typeof n.properties === 'object') {
    out.Properties = Object.fromEntries(
      Object.entries(n.properties as Record<string, unknown>).map(([k, v]) => [
        k,
        toAgentCoreSchema(v as Record<string, unknown>),
      ]),
    );
    if (Array.isArray(n.required) && n.required.length > 0) out.Required = n.required;
  }
  if (n.type === 'array' && n.items) {
    out.Items = toAgentCoreSchema(n.items as Record<string, unknown>);
  }
  return out;
}
