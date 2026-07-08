// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Shared, zero-runtime types for the AgentCore Identity block.
 *
 * Mirrors Amazon Bedrock AgentCore Identity:
 *  - a *workload identity* represents the agent;
 *  - *inbound auth* exchanges a caller's identity (JWT / user id) for a
 *    workload access token;
 *  - *outbound auth* lets the agent fetch downstream credentials (API keys,
 *    OAuth2 tokens) from the managed Token Vault — without handling raw secrets.
 */

/** An API-key credential provider (outbound). */
export interface ApiKeyProvider {
  type: 'apiKey';
  /** Provider name, referenced when fetching the key. */
  name: string;
  /**
   * Dev-only API key used by the local mock's token vault. On AWS the key lives
   * in the managed Token Vault (provisioned by the CDK layer); this is ignored.
   */
  apiKey?: string;
}

/** An OAuth2 credential provider (outbound). */
export interface OAuth2Provider {
  type: 'oauth2';
  name: string;
  /** OIDC discovery URL of the identity provider. */
  discoveryUrl?: string;
  clientId?: string;
  /** Default scopes requested when none are passed to getOAuthToken. */
  scopes?: string[];
}

export type CredentialProvider = ApiKeyProvider | OAuth2Provider;

export interface AgentCoreIdentityOptions {
  /** Workload identity name. Defaults to the block's fullId. */
  workloadName?: string;
  /** Outbound credential providers this block can vend. */
  providers?: CredentialProvider[];
}

/** Result of an inbound workload-access-token exchange. */
export interface WorkloadAccessToken {
  workloadAccessToken: string;
  workloadName: string;
}

/** An OAuth2 token vended for a downstream resource. */
export interface OAuthToken {
  accessToken: string;
  tokenType: 'Bearer';
  scopes: string[];
  /** ISO-8601 expiry, when known. */
  expiresAt?: string;
}

/** Identify the caller for an inbound exchange. */
export type WorkloadCaller =
  | { jwt: string }
  | { userId: string }
  | Record<string, never>; // none → the agent's own workload token
