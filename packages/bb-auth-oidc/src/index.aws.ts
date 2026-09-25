// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * AWS-runtime entry point for `AuthOIDC`.
 * Wires the shared class to real IdPs via `OidcClientEngine`. Cookie-signing
 * secret is read from SSM (provisioned by CDK synth).
 */

import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';

import { type ScopeParent, registerSdkIdentifiers, getSdkIdentifiers, installClientUserAgent } from '@aws-blocks/core';
import { resolveCookieSecurity } from '@aws-blocks/auth-common/cookies';
import { KVStore } from '@aws-blocks/bb-kv-store';
import { BB_NAME, BB_VERSION } from './version.js';
import { AuthOIDC as AuthOIDCBase, DEFAULT_CALLBACK_PATH } from './auth-oidc.js';
import { OidcClientEngine } from './engines/oidc-client-engine.js';
import { CognitoFederationEngine } from './engines/cognito-federation-engine.js';
import { SessionManager } from './engines/session-manager.js';
import { mountAuthRoutes, mountStubIdpRoutes } from './routes.js';
import { cookieSecretEnvVar, resolveProviderIssuerUrl } from './utils.js';
import type { AuthOIDCOptions, ProviderConfig, SessionRow } from './types.js';

export { AuthOIDCErrors, type AuthOIDCErrorName } from './errors.js';
export {
	google,
	github,
	customOidc,
	customOauth2,
	stubIdp,
	cognitoFederated,
} from './providers.js';
export { relayOrigin, type RelayOrigin } from './relay.js';
export type {
	OIDCUser,
	MappedClaims,
	OnStubAuthorize,
	StubAuthorizeRequest,
	StubUser,
} from './types.js';

/** Read the cookie-signing secret from SSM (once per Lambda container). */
async function resolveSsmSecret(ssmClient: SSMClient, parameterName: string): Promise<string> {
	const result = await ssmClient.send(
		new GetParameterCommand({ Name: parameterName, WithDecryption: true }),
	);
	const value = result.Parameter?.Value;
	if (!value) {
		throw new Error(`AuthOIDC: SSM parameter ${parameterName} has no value`);
	}
	return value;
}

/** OIDC sign-in gate (AWS runtime). See `auth-oidc.ts` for class-level docs. */
export class AuthOIDC<
	P extends readonly ProviderConfig[] = readonly ProviderConfig[],
> extends AuthOIDCBase<P> {

	constructor(scope: ScopeParent, id: string, options: AuthOIDCOptions<P>) {
		const fullIdForEnv = scopeFullId(scope, id);
		const envVarName = cookieSecretEnvVar(fullIdForEnv);
		// Lazy env resolution — this module is imported during client-code
		// generation (outside Lambda) where env vars are absent. We defer the
		// hard check to the cookie-secret resolver so construction succeeds
		// during codegen but runtime calls still fail fast if misconfigured.
		const parameterName = process.env[envVarName] ?? '';

		const sessions = new KVStore<SessionRow>(scope, `${id}-sessions`);

		const cookieOpts = {
			...resolveCookieSecurity({
				crossDomain: options.crossDomain ?? false,
				isLocalhost: false,
			}),
			path: '/',
		};

		// SSM client is created lazily to avoid failing during codegen imports
		let ssmClient: SSMClient | undefined;
		const getSsmClient = () => {
			if (!ssmClient) {
				ssmClient = new SSMClient({
					customUserAgent: this.buildUserAgentChain(),
				});
				installClientUserAgent(ssmClient);
			}
			return ssmClient;
		};

		const cookieSecret = () => {
			if (!parameterName) {
				throw new Error(
					`AuthOIDC: env var ${envVarName} is not set. `
						+ 'Ensure the CDK synth (index.cdk.ts) provisioned the cookie-signing '
						+ 'SSM parameter and that its name was wired to the Lambda environment.',
				);
			}
			return resolveSsmSecret(getSsmClient(), parameterName);
		};

		const hasCognitoFederated = options.providers.some(p => p.kind === 'cognito-federated');

		let engine;
		if (hasCognitoFederated) {
			const sessionManager = new SessionManager({
				sessionStore: sessions,
				cookieSecret,
				cookieNamePrefix: `oidc_${fullIdForEnv}`,
				cookieAttributes: cookieOpts,
			});

			const cognitoEnvPrefix = `BLOCKS_AUTH_OIDC_COGNITO_${fullIdForEnv.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
			engine = new CognitoFederationEngine({
				providers: options.providers,
				sessionManager,
				cognitoClientId: () => {
					const val = process.env[`${cognitoEnvPrefix}_CLIENT_ID`];
					if (!val) throw new Error(`AuthOIDC: env var ${cognitoEnvPrefix}_CLIENT_ID is not set.`);
					return val;
				},
				cognitoClientSecret: () => {
					return process.env[`${cognitoEnvPrefix}_CLIENT_SECRET`] ?? '';
				},
				cognitoUserPoolId: () => {
					const val = process.env[`${cognitoEnvPrefix}_POOL_ID`];
					if (!val) throw new Error(`AuthOIDC: env var ${cognitoEnvPrefix}_POOL_ID is not set.`);
					return val;
				},
				allowedRelayOrigins: options.allowedRelayOrigins,
			});
		} else {
			engine = new OidcClientEngine({
				providers: options.providers,
				sessionStore: sessions,
				cookieSecret,
				cookieNamePrefix: `oidc_${fullIdForEnv}`,
				cookieAttributes: cookieOpts,
				callbackPath: options.callbackPath ?? DEFAULT_CALLBACK_PATH,
				postSignInPath: options.postSignInPath ?? '/',
				resolveIssuerUrl: resolveProviderIssuerUrl,
				allowInsecureIssuers: false,
				allowedRelayOrigins: options.allowedRelayOrigins,
			});
		}

		super(scope, id, options, engine, { bbName: BB_NAME, bbVersion: BB_VERSION });
		registerSdkIdentifiers(this.fullId, {
			sessionTableName: getSdkIdentifiers(sessions).tableName,
		});
		mountAuthRoutes(this);

		for (const provider of options.providers) {
			if (provider.kind === 'stub') {
				mountStubIdpRoutes(this, provider);
			}
		}
	}
}

function scopeFullId(scope: ScopeParent, id: string): string {
	const segments: string[] = [id];
	let current: ScopeParent | undefined = scope;
	while (current && 'parent' in current && current.parent) {
		segments.unshift(current.id);
		current = (current as { parent: ScopeParent }).parent;
	}
	if (current && 'id' in current) segments.unshift(current.id);
	return segments.join('-');
}

