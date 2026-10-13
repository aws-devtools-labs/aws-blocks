// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import type { BlocksContext } from '@aws-blocks/core';
import { stubIssuerUrl } from './engines/stub-idp.js';
import type { ProviderConfig } from './types.js';

/**
 * Env-var name used at runtime to read the cookie-signing secret's SSM
 * parameter name.
 *
 * Shared between the CDK synth path (which writes the env var via
 * `registerConfig`) and the AWS runtime path (which reads it from
 * `process.env`).
 *
 * @param fullId - The fully-qualified scope ID (e.g. `"myApp-auth"`)
 * @returns Environment variable name like `BLOCKS_AUTH_OIDC_COOKIE_SECRET_MYAPP_AUTH`
 */
export function cookieSecretEnvVar(fullId: string): string {
	return `BLOCKS_AUTH_OIDC_COOKIE_SECRET_${fullId.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
}

/**
 * Env-var name used at runtime to read whether this instance was deployed in
 * sandbox mode.
 *
 * Sandbox-vs-production is only known at CDK synth time (the `sandboxMode`
 * context key); the deployed Lambda has no CDK context. So the CDK synth path
 * stamps this flag via `registerConfig` (which serializes into the S3-backed
 * runtime config) and the AWS runtime path reads it from `process.env` to
 * enforce the stub-IdP security guard — a forgeable, dev-only IdP must never be
 * mounted in a deployed, non-sandbox app. Mirrors {@link cookieSecretEnvVar}'s
 * key derivation so both sides reconstruct a byte-identical env-var name.
 *
 * @param fullId - The fully-qualified scope ID (e.g. `"myApp-auth"`)
 * @returns Environment variable name like `BLOCKS_AUTH_OIDC_SANDBOX_MYAPP_AUTH`
 */
export function sandboxFlagEnvVar(fullId: string): string {
	return `BLOCKS_AUTH_OIDC_SANDBOX_${fullId.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
}

/** Shared by both runtimes so the stub-vs-real issuer rule stays identical. */
export function resolveProviderIssuerUrl(provider: ProviderConfig, ctx: BlocksContext): string {
	switch (provider.kind) {
		case 'stub':
			return stubIssuerUrl(provider.name, ctx);
		case 'oidc-builtin': // GoogleProvider
		case 'oidc-custom': // CustomOidcProvider
			return provider.issuerUrl;
		case 'oauth2-custom': // GitHub / CustomOauth2 — no issuer concept
		case 'cognito-federated': // resolved via the Cognito-mediated flow, not a plain issuer URL
			return '';
	}
}
