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
 * Env-var name the AWS runtime reads to learn whether this instance was deployed
 * in sandbox mode.
 *
 * Sandbox vs production is known only at CDK synth (the `sandboxMode` context
 * key, which `npm run sandbox` sets); the deployed Lambda has no CDK context. The
 * CDK layer writes this flag with `registerConfig`, and the runtime reads it to
 * refuse a stub IdP outside sandbox. Shared for the same reason as
 * {@link cookieSecretEnvVar}: both sides must derive a byte-identical name.
 *
 * @param fullId - The fully-qualified scope ID (e.g. `"myApp-auth"`)
 * @returns Environment variable name like `BLOCKS_AUTH_OIDC_SANDBOX_MYAPP_AUTH`
 */
export function sandboxFlagEnvVar(fullId: string): string {
	return `BLOCKS_AUTH_OIDC_SANDBOX_${fullId.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
}

/**
 * The error a stub IdP provider gets outside sandbox mode, shared by the synth
 * guard (`index.cdk.ts`) and the runtime guard (`index.aws.ts`).
 */
export function stubOutsideSandboxMessage(providerName: string): string {
	return (
		`AuthOIDC: stubIdp() provider '${providerName}' can only run locally or in a sandbox (npm run sandbox). ` +
		'The stub IdP signs in any identity without a credential, so it must not reach a production deployment. ' +
		'Use a real provider (google(), github(), customOidc(), cognitoFederated()) for this deployment.'
	);
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
