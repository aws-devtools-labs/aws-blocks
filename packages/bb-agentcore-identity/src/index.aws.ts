// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * AWS runtime implementation of the AgentCore Identity block.
 *
 * Uses the AgentCore data plane (`@aws-sdk/client-bedrock-agentcore`):
 *  - inbound : GetWorkloadAccessToken / ...ForJWT / ...ForUserId
 *  - outbound: GetResourceApiKey / GetResourceOauth2Token (via a workload token)
 *
 * The workload identity + credential providers are provisioned by the CDK layer.
 */

import { Scope } from '@aws-blocks/core';
import type { ScopeParent } from '@aws-blocks/core';
import { BB_NAME, BB_VERSION } from './version.js';
import {
  BedrockAgentCoreClient,
  GetResourceApiKeyCommand,
  GetResourceOauth2TokenCommand,
  GetWorkloadAccessTokenCommand,
  GetWorkloadAccessTokenForJWTCommand,
  GetWorkloadAccessTokenForUserIdCommand,
} from '@aws-sdk/client-bedrock-agentcore';
import { identityError, IdentityErrors } from './errors.js';
import { defaultWorkloadName, workloadEnvVar } from './naming.js';
import type {
  AgentCoreIdentityOptions,
  CredentialProvider,
  OAuthToken,
  WorkloadAccessToken,
  WorkloadCaller,
} from './types.js';

export * from './types.js';
export { IdentityErrors } from './errors.js';

export class AgentCoreIdentity extends Scope {
  private readonly client: BedrockAgentCoreClient;
  private readonly workloadName: string;
  private readonly providers: Map<string, CredentialProvider>;

  constructor(scope: ScopeParent, id: string, options?: AgentCoreIdentityOptions) {
    super(id, { parent: scope, bbName: BB_NAME, bbVersion: BB_VERSION });
    this.workloadName =
      process.env[workloadEnvVar(this.fullId)] ??
      options?.workloadName ??
      defaultWorkloadName(this.fullId);
    this.providers = new Map((options?.providers ?? []).map((p) => [p.name, p]));
    this.client = new BedrockAgentCoreClient({});
  }

  async getWorkloadAccessToken(caller: WorkloadCaller = {}): Promise<WorkloadAccessToken> {
    let token: string | undefined;
    if ('jwt' in caller) {
      const res = await this.client.send(
        new GetWorkloadAccessTokenForJWTCommand({ workloadName: this.workloadName, userToken: caller.jwt }),
      );
      token = res.workloadAccessToken;
    } else if ('userId' in caller) {
      const res = await this.client.send(
        new GetWorkloadAccessTokenForUserIdCommand({ workloadName: this.workloadName, userId: caller.userId }),
      );
      token = res.workloadAccessToken;
    } else {
      const res = await this.client.send(
        new GetWorkloadAccessTokenCommand({ workloadName: this.workloadName }),
      );
      token = res.workloadAccessToken;
    }
    return { workloadAccessToken: token ?? '', workloadName: this.workloadName };
  }

  async getApiKey(providerName: string): Promise<string> {
    this.requireProvider(providerName, 'apiKey');
    const { workloadAccessToken } = await this.getWorkloadAccessToken();
    const res = await this.client.send(
      new GetResourceApiKeyCommand({
        workloadIdentityToken: workloadAccessToken,
        resourceCredentialProviderName: providerName,
      }),
    );
    if (!res.apiKey) {
      throw identityError(IdentityErrors.MissingCredential, `No API key returned for "${providerName}"`);
    }
    return res.apiKey;
  }

  async getOAuthToken(providerName: string, opts?: { scopes?: string[] }): Promise<OAuthToken> {
    const provider = this.requireProvider(providerName, 'oauth2');
    const scopes = opts?.scopes ?? (provider.type === 'oauth2' ? provider.scopes ?? [] : []);
    const res = await this.client.send(
      new GetResourceOauth2TokenCommand({
        workloadIdentityToken: (await this.getWorkloadAccessToken()).workloadAccessToken,
        resourceCredentialProviderName: providerName,
        scopes,
        // Machine-to-machine: the agent's own workload credentials (no end-user).
        oauth2Flow: 'M2M',
      }),
    );
    if (!res.accessToken) {
      // 3-legged flows return an authorizationUrl the user must visit first.
      throw identityError(
        IdentityErrors.MissingCredential,
        res.authorizationUrl
          ? `OAuth2 authorization required for "${providerName}": ${res.authorizationUrl}`
          : `No OAuth2 token returned for "${providerName}"`,
      );
    }
    return { accessToken: res.accessToken, tokenType: 'Bearer', scopes };
  }

  private requireProvider(name: string, type: CredentialProvider['type']): CredentialProvider {
    const provider = this.providers.get(name);
    if (!provider) {
      throw identityError(IdentityErrors.ProviderNotFound, `Unknown credential provider "${name}"`);
    }
    if (provider.type !== type) {
      throw identityError(
        IdentityErrors.ProviderTypeMismatch,
        `Provider "${name}" is "${provider.type}", expected "${type}"`,
      );
    }
    return provider;
  }
}
