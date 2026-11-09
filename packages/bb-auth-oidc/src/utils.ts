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
 * Env-var name prefix for the Cognito-federated provider's deployed settings.
 *
 * Shared with the CDK synth path for the same reason as `cookieSecretEnvVar`:
 * the synth side writes these names and the runtime reads them, so a second
 * copy of the expression would let the two drift apart silently.
 *
 * @param fullId - The fully-qualified scope ID (e.g. `"myApp-auth"`)
 * @returns Prefix like `BLOCKS_AUTH_OIDC_COGNITO_MYAPP_AUTH`, without a trailing `_`
 */
export function cognitoEnvPrefix(fullId: string): string {
	return `BLOCKS_AUTH_OIDC_COGNITO_${fullId.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
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
