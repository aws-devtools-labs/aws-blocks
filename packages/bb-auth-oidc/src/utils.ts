// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import type { BlocksContext, ScopeParent } from '@aws-blocks/core';
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
 * The scope's fully-qualified ID, resolved the same way `Scope.fullId` does.
 *
 * Both runtimes build the session store before `super()` runs, so `this.fullId`
 * is not available where it is needed.
 *
 * @param scope - The parent scope passed to the constructor
 * @param id - The block's own ID
 * @returns The fully-qualified ID, e.g. `"myApp-auth"`
 */
export function scopeFullId(scope: ScopeParent, id: string): string {
	const parent = 'fullId' in scope && scope.fullId ? scope.fullId : 'id' in scope && scope.id ? scope.id : undefined;
	return parent ? `${parent}-${id}` : id;
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
