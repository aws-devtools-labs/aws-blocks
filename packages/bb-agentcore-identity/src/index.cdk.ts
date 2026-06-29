// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * CDK (infrastructure) implementation of the AgentCore Identity block.
 *
 * Provisions a workload identity and the configured credential providers in the
 * Token Vault, grants the Blocks Lambda the identity data-plane permissions, and
 * injects the workload name into the handler environment.
 *
 * Runtime methods are synth guards (they run only in the aws-runtime build).
 */

import { CfnResource } from 'aws-cdk-lib';
import { PolicyStatement } from 'aws-cdk-lib/aws-iam';
import { Scope, synthGuard } from '@aws-blocks/core/cdk';
import type { ScopeParent } from '@aws-blocks/core';
import { BB_NAME, BB_VERSION } from './version.js';
import { defaultWorkloadName, workloadEnvVar } from './naming.js';
import type {
  AgentCoreIdentityOptions,
  OAuthToken,
  WorkloadAccessToken,
  WorkloadCaller,
} from './types.js';

export * from './types.js';
export { IdentityErrors } from './errors.js';

export class AgentCoreIdentity extends Scope {
  constructor(scope: ScopeParent, id: string, options?: AgentCoreIdentityOptions) {
    super(id, { parent: scope, bbName: BB_NAME, bbVersion: BB_VERSION });
    const workloadName = options?.workloadName ?? defaultWorkloadName(this.fullId);

    new CfnResource(this, 'workload', {
      type: 'AWS::BedrockAgentCore::WorkloadIdentity',
      properties: { Name: workloadName },
    });

    for (const provider of options?.providers ?? []) {
      if (provider.type === 'apiKey') {
        new CfnResource(this, `cred-${provider.name}`, {
          type: 'AWS::BedrockAgentCore::ApiKeyCredentialProvider',
          properties: {
            Name: provider.name,
            // In production, reference a Secrets Manager secret instead of inlining.
            ...(provider.apiKey ? { ApiKey: provider.apiKey } : {}),
          },
        });
      } else {
        new CfnResource(this, `cred-${provider.name}`, {
          type: 'AWS::BedrockAgentCore::OAuth2CredentialProvider',
          properties: {
            Name: provider.name,
            ...(provider.discoveryUrl
              ? {
                  Oauth2ProviderConfigInput: {
                    CustomOauth2ProviderConfig: {
                      OidcDiscoveryUrl: provider.discoveryUrl,
                      ClientId: provider.clientId,
                    },
                  },
                }
              : {}),
          },
        });
      }
    }

    this.handler.addEnvironment(workloadEnvVar(this.fullId), workloadName);
    this.handler.addToRolePolicy(
      new PolicyStatement({
        actions: [
          'bedrock-agentcore:GetWorkloadAccessToken',
          'bedrock-agentcore:GetWorkloadAccessTokenForJWT',
          'bedrock-agentcore:GetWorkloadAccessTokenForUserId',
          'bedrock-agentcore:GetResourceApiKey',
          'bedrock-agentcore:GetResourceOauth2Token',
        ],
        resources: ['*'],
      }),
    );
  }

  // --- runtime methods: only valid in the aws-runtime build ---
  async getWorkloadAccessToken(_caller?: WorkloadCaller): Promise<WorkloadAccessToken> {
    return synthGuard('AgentCoreIdentity', 'getWorkloadAccessToken');
  }
  async getApiKey(_providerName: string): Promise<string> {
    return synthGuard('AgentCoreIdentity', 'getApiKey');
  }
  async getOAuthToken(_providerName: string, _opts?: { scopes?: string[] }): Promise<OAuthToken> {
    return synthGuard('AgentCoreIdentity', 'getOAuthToken');
  }
}
