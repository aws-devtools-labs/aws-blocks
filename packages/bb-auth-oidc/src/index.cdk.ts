// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * CDK-synth entry point for `AuthOIDC`.
 *
 * Provisions the infrastructure required for the BB:
 *
 * 1. A `bb-app-setting` SecureString SSM parameter holding the
 *    cookie-signing secret. Its value is generated on first deploy by a
 *    CDK custom resource and consumed at runtime through the
 *    `BLOCKS_AUTH_OIDC_COOKIE_SECRET_<fullId>` env var.
 * 2. A `KVStore` (DynamoDB table) for session storage. Sessions carry
 *    refresh tokens and verified claims; the cookie carries an opaque
 *    session id that keys into this table.
 *
 * It does **not** declare the HTTP routes: every auth route lives under the
 * reserved `/aws-blocks/auth` subtree, which `core`'s Hosting proxies to API
 * Gateway with a single CloudFront behavior. The routes themselves are mounted
 * by the AWS runtime entry and dispatched by the Lambda's RawRoute registry.
 *
 * **What this construct does NOT provision:**
 *
 * - No database or user table. AuthOIDC does not track users; customers
 *   persist identity via `onSignIn` to tables they own.
 * - No provider client-secret SSM params. Customers declare those via
 *   `AppSetting` in their own app code and pass resolver closures into
 *   the provider helpers.
 */

import { type ScopeParent } from '@aws-blocks/core';
import { BuildingBlockScope, registerConfig } from '@aws-blocks/core/cdk';
import type { VpcRequirements } from '@aws-blocks/core/cdk';
import { AppSetting } from '@aws-blocks/bb-app-setting';
import { KVStore } from '@aws-blocks/bb-kv-store';
import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import type * as lambda from 'aws-cdk-lib/aws-lambda';
import type { IDependable } from 'constructs';
import type { AuthOIDCOptions, CognitoFederatedProvider, ProviderConfig } from './types.js';
import {
	DEFAULT_CALLBACK_PATH,
	DEFAULT_SIGNOUT_PATH,
} from './auth-oidc.js';
import { cookieSecretEnvVar } from './utils.js';

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

/**
 * CDK-synth `AuthOIDC`.
 *
 * Provisions the cookie-signing secret and the session store (KVStore). Routes
 * are not declared here — they live under the reserved `/aws-blocks/auth`
 * subtree that Hosting proxies. Runtime logic (token exchange, cookie signing,
 * session lookups) lives in the `aws-runtime` entry — CDK never imports that
 * code path.
 *
 * @example
 * ```typescript
 * // aws-blocks/index.cdk.ts
 * new AuthOIDC(stack, 'auth', {
 *   providers: [
 *     google({
 *       clientId:     () => googleId.get(),
 *       clientSecret: () => googleSecret.get(),
 *     }),
 *   ],
 * });
 * ```
 */
export class AuthOIDC<
	P extends readonly ProviderConfig[] = readonly ProviderConfig[],
> extends BuildingBlockScope {
	public readonly callbackPath: string;
	public readonly signOutPath: string;

	getVpcRequirements(): VpcRequirements {
		return {
			interfaceEndpoints: [ec2.InterfaceVpcEndpointAwsService.SSM],
		};
	}

	constructor(scope: ScopeParent, id: string, options: AuthOIDCOptions<P>) {
		super(id, { parent: scope });

		this.callbackPath = options.callbackPath ?? DEFAULT_CALLBACK_PATH;
		this.signOutPath = options.signOutPath ?? DEFAULT_SIGNOUT_PATH;

		// No route declarations here: every auth route lives under the reserved
		// `/aws-blocks/auth` subtree, which `core`'s Hosting proxies to API
		// Gateway with a single CloudFront behavior. The Lambda's RawRoute
		// registry (wired by the AWS runtime entry) does the actual dispatch.

		// Cookie-signing secret. The env var value must match AppSetting's
		// default parameter name: `/${appSetting.fullId}`.
		new AppSetting(this, `cookie-secret-${id}`, { secret: true });
		registerConfig(this, cookieSecretEnvVar(this.fullId), `/${this.fullId}-cookie-secret-${id}`);

		// Session store — always provisioned.
		new KVStore(this, 'sessions');

		// When `cognitoFederated` providers are configured, provision the
		// Cognito User Pool, App Client, domain, and IdP registrations.
		const cognitoProviders = options.providers.filter(
			(p): p is CognitoFederatedProvider => p.kind === 'cognito-federated',
		);
		if (cognitoProviders.length > 0) {
			this.provisionCognitoFederation(cognitoProviders, options);
		}
	}

	/**
	 * Provision Cognito User Pool + App Client + Identity Providers for
	 * cognitoFederated providers. All providers share a single pool.
	 */
	private provisionCognitoFederation(
		cognitoProviders: CognitoFederatedProvider[],
		options: AuthOIDCOptions<readonly ProviderConfig[]>,
	): void {
		const stack = cdk.Stack.of(this);

		const pool = new cognito.UserPool(this, 'cognito-pool', {
			userPoolName: `${this.fullId}-federation`,
			selfSignUpEnabled: false,
			signInAliases: { email: true },
			autoVerify: { email: true },
			removalPolicy: cdk.RemovalPolicy.DESTROY,
		});

		// Custom domains require ACM certificates and are deferred.
		const domainConfig = cognitoProviders[0];
		if (!domainConfig.cognitoDomain.includes('.')) {
			pool.addDomain('domain', {
				cognitoDomain: { domainPrefix: domainConfig.cognitoDomain },
			});
		}

		const idpDependencies: IDependable[] = [];
		for (const provider of cognitoProviders) {
			const idp = this.registerIdentityProvider(pool, provider);
			if (idp) idpDependencies.push(idp);
		}

		// Callback URLs get the real API Gateway URL post-deploy or via a
		// custom resource; the placeholder below keeps synth valid. The path must
		// match the BB's callback route (under `/aws-blocks/auth/`).
		const callbackPath = options.callbackPath ?? DEFAULT_CALLBACK_PATH;
		const client = pool.addClient('app-client', {
			generateSecret: true,
			oAuth: {
				flows: { authorizationCodeGrant: true },
				scopes: [
					cognito.OAuthScope.OPENID,
					cognito.OAuthScope.EMAIL,
					cognito.OAuthScope.PROFILE,
				],
				callbackUrls: [`https://localhost${callbackPath}`],
				logoutUrls: ['https://localhost/'],
			},
			supportedIdentityProviders: idpDependencies.length > 0
				? cognitoProviders.map(p => cognito.UserPoolClientIdentityProvider.custom(p.identityProvider))
				: undefined,
		});

		for (const dep of idpDependencies) {
			client.node.addDependency(dep);
		}

		const fn = this.handler as lambda.Function;
		const envPrefix = `BLOCKS_AUTH_OIDC_COGNITO_${this.fullId.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
		registerConfig(this, `${envPrefix}_POOL_ID`, pool.userPoolId);
		registerConfig(this, `${envPrefix}_CLIENT_ID`, client.userPoolClientId);
		registerConfig(this, `${envPrefix}_CLIENT_SECRET`, client.userPoolClientSecret.unsafeUnwrap());
		registerConfig(this, `${envPrefix}_REGION`, stack.region);
		registerConfig(this, `${envPrefix}_DOMAIN`, domainConfig.cognitoDomain);
	}

	/**
	 * Register a federated identity provider on the Cognito User Pool.
	 * Uses CloudFormation dynamic references to read IdP credentials from
	 * SSM at deploy time.
	 */
	private registerIdentityProvider(
		pool: cognito.UserPool,
		provider: CognitoFederatedProvider,
	): IDependable | undefined {
		const idpClientIdParam = `/${provider.idpClientId.fullId}`;
		const idpClientSecretParam = `/${provider.idpClientSecret.fullId}`;
		const clientIdRef = `{{resolve:ssm-secure:${idpClientIdParam}}}`;
		const clientSecretRef = `{{resolve:ssm-secure:${idpClientSecretParam}}}`;

		switch (provider.identityProvider) {
			case 'Google':
				return new cognito.UserPoolIdentityProviderGoogle(this, `idp-${provider.name}`, {
					userPool: pool,
					clientId: clientIdRef,
					clientSecretValue: cdk.SecretValue.unsafePlainText(clientSecretRef),
					scopes: ['openid', 'email', 'profile'],
					attributeMapping: {
						email: cognito.ProviderAttribute.GOOGLE_EMAIL,
						fullname: cognito.ProviderAttribute.GOOGLE_NAME,
					},
				});
			case 'Facebook':
				return new cognito.UserPoolIdentityProviderFacebook(this, `idp-${provider.name}`, {
					userPool: pool,
					clientId: clientIdRef,
					clientSecret: clientSecretRef,
					scopes: ['public_profile', 'email'],
					attributeMapping: {
						email: cognito.ProviderAttribute.FACEBOOK_EMAIL,
						fullname: cognito.ProviderAttribute.FACEBOOK_NAME,
					},
				});
			case 'LoginWithAmazon':
				return new cognito.UserPoolIdentityProviderAmazon(this, `idp-${provider.name}`, {
					userPool: pool,
					clientId: clientIdRef,
					clientSecret: clientSecretRef,
					attributeMapping: {
						email: cognito.ProviderAttribute.AMAZON_EMAIL,
						fullname: cognito.ProviderAttribute.AMAZON_NAME,
					},
				});
			default:
				// Custom OIDC IdP — requires idpIssuerUrl on the provider config.
				if (provider.idpIssuerUrl) {
					return new cognito.UserPoolIdentityProviderOidc(this, `idp-${provider.name}`, {
						userPool: pool,
						name: provider.identityProvider,
						clientId: clientIdRef,
						clientSecret: clientSecretRef,
						issuerUrl: provider.idpIssuerUrl,
						scopes: ['openid', 'email', 'profile'],
						attributeMapping: {
							email: cognito.ProviderAttribute.other('email'),
							fullname: cognito.ProviderAttribute.other('name'),
						},
					});
				}
				return undefined;
		}
	}

	/**
	 * Stub for CDK synth. The real state-machine `ApiNamespace` is emitted
	 * by the runtime entries (`./index.mock.ts`, `./index.aws.ts`). This
	 * no-op keeps `oidcAuth.createApi()` calls in the IFC layer executable
	 * under `--conditions=cdk` without emitting a second (broken) namespace.
	 */
	createApi() {
		return Object.assign(() => ({}), { [Symbol.for('blocks:ApiNamespace')]: 'auth' });
	}
}
