// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * AWS-runtime entry point for `AuthOIDC`.
 * Wires the shared class to real IdPs via `OidcClientEngine`. Cookie-signing
 * secret is read from SSM (provisioned by CDK synth).
 */

import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';

import {
	buildingBlockParent,
	getSdkIdentifiers,
	installClientUserAgent,
	registerSdkIdentifiers,
	type ScopeParent,
} from '@aws-blocks/core';
import { resolveCookieSecurity } from '@aws-blocks/auth-common/cookies';
import { KVStore } from '@aws-blocks/bb-kv-store';
import { BB_NAME, BB_VERSION } from './version.js';
import { AuthOIDC as AuthOIDCBase, DEFAULT_CALLBACK_PATH } from './auth-oidc.js';
import type { AuthEngine } from './engine.js';
import { OidcClientEngine } from './engines/oidc-client-engine.js';
import { CognitoFederationEngine } from './engines/cognito-federation-engine.js';
import { SessionManager } from './engines/session-manager.js';
import { mountAuthRoutes, mountStubIdpRoutes } from './routes.js';
import { isDeployedEnv } from '@aws-blocks/core/bb-utils';
import { cognitoEnvPrefix, cookieSecretEnvVar, resolveProviderIssuerUrl, sandboxFlagEnvVar, stubOutsideSandboxMessage } from './utils.js';
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
	OIDCClient,
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
		const self = buildingBlockParent({ id, parent: scope, bbName: BB_NAME, bbVersion: BB_VERSION });
		const envVarName = cookieSecretEnvVar(self.fullId);
		// Lazy env resolution — this module is imported during client-code
		// generation (outside Lambda) where env vars are absent. We defer the
		// hard check to the cookie-secret resolver so construction succeeds
		// during codegen but runtime calls still fail fast if misconfigured.
		const parameterName = process.env[envVarName] ?? '';

		// The store feeds `engine`, which `super()` consumes, so `this` is unavailable.
		const sessions = new KVStore<SessionRow>(self, 'sessions');

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

		let engine: AuthEngine;
		if (hasCognitoFederated) {
			const sessionManager = new SessionManager({
				sessionStore: sessions,
				cookieSecret,
				cookieNamePrefix: `oidc_${self.fullId}`,
				cookieAttributes: cookieOpts,
			});

			const envPrefix = cognitoEnvPrefix(self.fullId);
			engine = new CognitoFederationEngine({
				providers: options.providers,
				sessionManager,
				cognitoClientId: () => {
					const val = process.env[`${envPrefix}_CLIENT_ID`];
					if (!val) throw new Error(`AuthOIDC: env var ${envPrefix}_CLIENT_ID is not set.`);
					return val;
				},
				cognitoClientSecret: () => {
					return process.env[`${envPrefix}_CLIENT_SECRET`] ?? '';
				},
				cognitoUserPoolId: () => {
					const val = process.env[`${envPrefix}_POOL_ID`];
					if (!val) throw new Error(`AuthOIDC: env var ${envPrefix}_POOL_ID is not set.`);
					return val;
				},
				allowedRelayOrigins: options.allowedRelayOrigins,
			});
		} else {
			engine = new OidcClientEngine({
				providers: options.providers,
				sessionStore: sessions,
				cookieSecret,
				cookieNamePrefix: `oidc_${self.fullId}`,
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

		// Defense in depth for the synth guard in index.cdk.ts: on deployed compute,
		// mount stub IdP routes only when the CDK layer recorded a sandbox deploy.
		// `isDeployedEnv()` is the compute-agnostic signal the mock-entry guard uses
		// (Lambda, ECS/Fargate, AgentCore alike). Outside deployed compute (local
		// dev, client codegen) the check is skipped.
		const isDeployed = isDeployedEnv();
		const isSandbox = process.env[sandboxFlagEnvVar(this.fullId)] === 'true';
		for (const provider of options.providers) {
			if (provider.kind === 'stub') {
				if (isDeployed && !isSandbox) throw new Error(stubOutsideSandboxMessage(provider.name));
				mountStubIdpRoutes(this, provider);
			}
		}
	}
}

