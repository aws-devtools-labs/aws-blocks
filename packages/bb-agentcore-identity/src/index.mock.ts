// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Local (mock) implementation of the AgentCore Identity block.
 *
 * Simulates a local Token Vault and workload-identity exchange in-process so the
 * full credential flow is testable offline. API keys come from the provider
 * config (or env); OAuth2/3LO can't really run locally, so a deterministic dev
 * token is issued. The public surface matches `index.aws.ts` exactly.
 */

import { Scope } from '@aws-blocks/core';
import type { ScopeParent } from '@aws-blocks/core';
import { BB_NAME, BB_VERSION } from './version.js';
import { identityError, IdentityErrors } from './errors.js';
import { defaultWorkloadName } from './naming.js';
import type {
  AgentCoreIdentityOptions,
  ApiKeyProvider,
  CredentialProvider,
  OAuth2Provider,
  OAuthToken,
  WorkloadAccessToken,
  WorkloadCaller,
} from './types.js';

export * from './types.js';
export { IdentityErrors } from './errors.js';

export class AgentCoreIdentity extends Scope {
  private readonly workloadName: string;
  private readonly providers: Map<string, CredentialProvider>;

  constructor(scope: ScopeParent, id: string, options?: AgentCoreIdentityOptions) {
    super(id, { parent: scope, bbName: BB_NAME, bbVersion: BB_VERSION });
    this.workloadName = options?.workloadName ?? defaultWorkloadName(this.fullId);
    this.providers = new Map((options?.providers ?? []).map((p) => [p.name, p]));
  }

  /** Inbound: exchange a caller identity for a workload access token. */
  async getWorkloadAccessToken(caller: WorkloadCaller = {}): Promise<WorkloadAccessToken> {
    const subject =
      'jwt' in caller ? `jwt:${hash(caller.jwt)}` : 'userId' in caller ? `user:${caller.userId}` : 'self';
    return {
      workloadAccessToken: `mock-wat.${this.workloadName}.${subject}`,
      workloadName: this.workloadName,
    };
  }

  /** Outbound: fetch the API key for a provider from the (mock) Token Vault. */
  async getApiKey(providerName: string): Promise<string> {
    const provider = this.requireProvider(providerName, 'apiKey') as ApiKeyProvider;
    const key = provider.apiKey ?? process.env[`BLOCKS_AGENTCORE_APIKEY_${providerName.toUpperCase()}`];
    if (!key) {
      throw identityError(
        IdentityErrors.MissingCredential,
        `No dev API key for provider "${providerName}". Set provider.apiKey or env BLOCKS_AGENTCORE_APIKEY_${providerName.toUpperCase()}.`,
      );
    }
    return key;
  }

  /** Outbound: fetch an OAuth2 token for a provider (dev token locally). */
  async getOAuthToken(providerName: string, opts?: { scopes?: string[] }): Promise<OAuthToken> {
    const provider = this.requireProvider(providerName, 'oauth2') as OAuth2Provider;
    const scopes = opts?.scopes ?? provider.scopes ?? [];
    const expiresAt = new Date(Date.now() + 3600_000).toISOString();
    return {
      accessToken: `mock-oauth.${providerName}.${scopes.join('+') || 'default'}`,
      tokenType: 'Bearer',
      scopes,
      expiresAt,
    };
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

function hash(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}
