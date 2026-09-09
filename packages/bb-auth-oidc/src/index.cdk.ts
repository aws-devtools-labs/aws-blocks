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

import type { ScopeParent } from '@aws-blocks/core';
import { Scope, registerConfig, DEFAULT_NODE_RUNTIME } from '@aws-blocks/core/cdk';
import { AppSetting } from '@aws-blocks/bb-app-setting';
import { KVStore } from '@aws-blocks/bb-kv-store';
import * as cdk from 'aws-cdk-lib';
import { CustomResource } from 'aws-cdk-lib';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import { Code, Function as LambdaFunction } from 'aws-cdk-lib/aws-lambda';
import { LogGroup } from 'aws-cdk-lib/aws-logs';
import { PolicyStatement } from 'aws-cdk-lib/aws-iam';
import { Provider } from 'aws-cdk-lib/custom-resources';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import type { IDependable } from 'constructs';

const __dirname = dirname(fileURLToPath(import.meta.url));
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
> extends Scope {
	public readonly callbackPath: string;
	public readonly signOutPath: string;

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

		// Cognito allows only one identity provider per provider name per pool.
		// Two `cognitoFederated()` configs with the same `identityProvider` would
		// otherwise synth two custom resources writing the same Cognito provider —
		// a silent last-writer-wins overwrite. Fail fast at synth instead.
		const seen = new Set<string>();
		for (const p of cognitoProviders) {
			if (seen.has(p.identityProvider)) {
				throw new Error(
					`AuthOIDC: duplicate cognitoFederated identityProvider '${p.identityProvider}'. ` +
						'Each Cognito identity provider name may be configured only once per user pool.',
				);
			}
			seen.add(p.identityProvider);
		}

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

		// IdP registration runs through a deploy-time custom resource rather than
		// native `AWS::Cognito::UserPoolIdentityProvider` resources. The native path
		// would write the IdP client id/secret into `ProviderDetails` as
		// `{{resolve:ssm-secure:...}}` dynamic references, which CloudFormation does
		// not permit on that property — deploy fails at change-set creation. Instead,
		// a Lambda reads the SecureString parameters via the SDK at deploy time and
		// calls Cognito's `CreateIdentityProvider`, so the credentials reach Cognito
		// without ever appearing in the CloudFormation template. See DESIGN.md.
		const idpParamNames: string[] = [];
		const idpFn = new LambdaFunction(this, 'idp-registration-fn', {
			runtime: DEFAULT_NODE_RUNTIME,
			handler: 'index.handler',
			timeout: cdk.Duration.minutes(2),
			// Own the log group so its retention follows the stack-wide default
			// instead of AWS's infinite retention.
			logGroup: new LogGroup(this, 'idp-registration-logs', {
				retention: this.defaults.logRetention,
				removalPolicy: cdk.RemovalPolicy.DESTROY,
			}),
			code: Code.fromAsset(join(__dirname, 'idp-registration-lambda')),
		});
		// Register / update / deregister the IdP on the pool.
		idpFn.addToRolePolicy(new PolicyStatement({
			actions: [
				'cognito-idp:CreateIdentityProvider',
				'cognito-idp:UpdateIdentityProvider',
				'cognito-idp:DeleteIdentityProvider',
			],
			resources: [pool.userPoolArn],
		}));
		// Read the IdP credential SecureString parameters at deploy time. ARNs are
		// resolved lazily as providers register below.
		idpFn.addToRolePolicy(new PolicyStatement({
			actions: ['ssm:GetParameter'],
			resources: cdk.Lazy.list({
				produce: () => idpParamNames.map(n =>
					stack.formatArn({ service: 'ssm', resource: 'parameter', resourceName: n.replace(/^\//, '') }),
				),
			}),
		}));
		// SecureString decryption goes through KMS via the SSM service. Scoping to
		// `kms:ViaService = ssm.<region>` covers both the default `aws/ssm` key and
		// any customer-managed key (whose own key policy must also allow this role).
		idpFn.addToRolePolicy(new PolicyStatement({
			actions: ['kms:Decrypt'],
			resources: ['*'],
			conditions: { StringEquals: { 'kms:ViaService': `ssm.${stack.region}.amazonaws.com` } },
		}));
		const idpProvider = new Provider(this, 'idp-registration-provider', { onEventHandler: idpFn });

		const idpDependencies: IDependable[] = [];
		for (const provider of cognitoProviders) {
			const idp = this.registerIdentityProvider(pool, provider, idpProvider.serviceToken, idpParamNames);
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

		const envPrefix = `BLOCKS_AUTH_OIDC_COGNITO_${this.fullId.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
		registerConfig(this, `${envPrefix}_POOL_ID`, pool.userPoolId);
		registerConfig(this, `${envPrefix}_CLIENT_ID`, client.userPoolClientId);
		registerConfig(this, `${envPrefix}_CLIENT_SECRET`, client.userPoolClientSecret.unsafeUnwrap());
		registerConfig(this, `${envPrefix}_REGION`, stack.region);
		registerConfig(this, `${envPrefix}_DOMAIN`, domainConfig.cognitoDomain);
	}

	/**
	 * Register a federated identity provider on the Cognito User Pool via a
	 * deploy-time custom resource. Only the SSM parameter *names* (never the
	 * secret values) are passed to CloudFormation; the handler reads and
	 * decrypts the credentials via the SDK at deploy time. Returns the custom
	 * resource so the app client can depend on it (the IdP must exist before the
	 * client lists it in `SupportedIdentityProviders`).
	 */
	private registerIdentityProvider(
		pool: cognito.UserPool,
		provider: CognitoFederatedProvider,
		serviceToken: string,
		paramNames: string[],
	): IDependable | undefined {
		const clientIdParam = `/${provider.idpClientId.fullId}`;
		const clientSecretParam = `/${provider.idpClientSecret.fullId}`;

		// Provider-type-specific, non-secret `ProviderDetails` + `AttributeMapping`.
		// The handler merges the resolved client_id/client_secret into these.
		let providerType: string;
		let providerDetails: Record<string, string>;
		const attributeMapping: Record<string, string> = { email: 'email', name: 'name' };
		switch (provider.identityProvider) {
			case 'Google':
				providerType = 'Google';
				providerDetails = { authorize_scopes: 'openid email profile' };
				break;
			case 'Facebook':
				providerType = 'Facebook';
				providerDetails = { authorize_scopes: 'public_profile email' };
				break;
			case 'LoginWithAmazon':
				providerType = 'LoginWithAmazon';
				providerDetails = { authorize_scopes: 'profile' };
				break;
			default:
				// Custom OIDC IdP — requires idpIssuerUrl on the provider config.
				if (!provider.idpIssuerUrl) return undefined;
				providerType = 'OIDC';
				providerDetails = {
					authorize_scopes: 'openid email profile',
					oidc_issuer: provider.idpIssuerUrl,
					attributes_request_method: 'GET',
				};
				break;
		}

		paramNames.push(clientIdParam, clientSecretParam);

		return new CustomResource(this, `idp-${provider.name}`, {
			serviceToken,
			properties: {
				UserPoolId: pool.userPoolId,
				ProviderName: provider.identityProvider,
				ProviderType: providerType,
				ClientIdParam: clientIdParam,
				ClientSecretParam: clientSecretParam,
				ProviderDetails: providerDetails,
				AttributeMapping: attributeMapping,
				// The credential values live in SSM and are read at deploy time, so
				// they never appear as custom-resource properties. That means a
				// credential set/rotation (an out-of-band SecureString write) does not
				// change any property and would not, on its own, re-invoke the handler.
				// This nonce changes every synth so each `cdk deploy` re-reads SSM and
				// re-registers the IdP with the current value. Trade-off: the resource
				// shows as updated on every deploy (the Update is idempotent).
				Trigger: Date.now().toString(),
			},
		});
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
