// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * `@aws-blocks/bb-auth` — `aws-runtime` entry (Lambda).
 *
 * `Auth` is the real engine-agnostic `AuthBase` (sessions,
 * cookies, guards, the `createApi()` state machine) over the Cognito SDK
 * user-pool engine (`engines/native-cognito.ts`: the sign-in core from D5c,
 * the account + admin surface from D5c2), and the direct
 * federation engine (D6a: OIDC and bare OAuth 2.0 providers, HTTPS only).
 * Hosted-UI providers (social, SAML, `federateVia: 'cognito'`) sign in through
 * Cognito managed login (`engines/federation-hosted-ui.ts`, D6b); a `stubIdp()`
 * provider answers 501 (local only).
 *
 * A `stubIdp()` provider is local only **unless** it sets `unsafeAllowDeployed`:
 * then this entry serves the stub IdP too (for disposable e2e stacks), loading
 * `engines/stub-idp.js` with a dynamic import on that path only — so a normal
 * deployed app's module graph never contains it. Its keys derive from the
 * session secret (every Lambda instance signs with the same key) and its issuer
 * is the API Gateway URL the CDK layer registers (`stubIdpConfigKeys`).
 *
 * With `validateUser` set, the pool's Cognito PreSignUp trigger invokes this
 * same Lambda; the layer routes it to the block (`presignup-trigger.ts`).
 */

import { AppSetting } from '@aws-blocks/bb-app-setting';
import type { BlocksContext, ScopeParent } from '@aws-blocks/core';
import { ApiError } from '@aws-blocks/core';
import { EventSourceMapping } from '@aws-blocks/core/bb-utils';
import { AuthBase, type AuthLayer, defineAuthLayer } from './auth-base.js';
import { CognitoAccessTokenVerifier } from './bearer-cognito.js';
import { cognitoConfigKeys, preSignUpTriggerConfigKey, stubIdpConfigKeys } from './cdk/contract.js';
import { DirectFederationEngine, isStubProvider } from './engines/federation-direct.js';
import { HostedUiFederationEngine } from './engines/federation-hosted-ui.js';
import { unavailableFederationEngine } from './engines/federation-unavailable.js';
import { NativeCognitoEngine } from './engines/native-cognito.js';
import { mountStubIdpRoutes, stubAllowsDeployment, stubIssuerUrl } from './engines/stub-idp-routes.js';
import type { EngineHost, FederationEngine, ResolvedProvider } from './engines/types.js';
import { AuthErrors } from './errors.js';
import { federationRoutePaths, mountFederationRoutes } from './federation-routes.js';
import type { AuthOptions, StubOidcProviderOptions } from './types.js';

export type { AuthBase } from './auth-base.js';
export type { AuthErrorName } from './errors.js';
export { AuthErrors, isAuthError } from './errors.js';
export { customOauth2, github, stubIdp } from './providers.js';
export { relayOrigin } from './relay.js';
export type * from './types.js';

/**
 * A `stubIdp({ unsafeAllowDeployed: true })` provider on the deployed backend:
 * the stub IdP's routes, and the direct engine pointed at them (HTTPS only).
 *
 * The **only** place the AWS entry reaches `engines/stub-idp.js`, and only
 * through this dynamic import, run on the provider's first request — so a
 * deployed app without the opt-in never loads it (`index.aws.bearer.test.ts`).
 * The issuer is the gateway URL the CDK layer registered: HTTPS, reachable by
 * the Lambda itself, and the same whichever front door a request came through.
 */
function deployedStubIdp(
	host: EngineHost,
	provider: ResolvedProvider,
	config: StubOidcProviderOptions,
): FederationEngine {
	const apiUrlKey = stubIdpConfigKeys(host.scope.fullId).API_URL;
	const issuer = (ctx: BlocksContext) =>
		stubIssuerUrl(provider.id, ctx, process.env[apiUrlKey] || process.env.BLOCKS_API_URL);
	const paths = federationRoutePaths(host.options);
	mountStubIdpRoutes(host.scope, provider.id, async () => {
		const { createStubIdp } = await import('./engines/stub-idp.js');
		return createStubIdp({
			providerId: provider.id,
			settings: config.stubIdp,
			dataDir: () => undefined,
			client: {
				clientId: config.clientId,
				redirectPaths: [paths.callback],
				postLogoutPaths: [paths.postSignOut, paths.signOut],
			},
			issuer,
			secret: () => host.sessionSecret(),
		});
	});
	return new DirectFederationEngine(host, provider, { allowInsecure: false, stubIssuer: issuer });
}

/**
 * The AWS layer: the session secret is the `session-secret` `AppSetting` child
 * — the same construct id, and so the same SSM parameter, `AuthCognito` uses —
 * so existing sessions keep verifying after the switch. The native engine
 * drives Cognito through the SDK; it is built only when the configuration has a
 * user pool (Q6), and creates its SDK client lazily.
 */
const AWS_LAYER: AuthLayer = {
	sessionSecret(auth) {
		const setting = new AppSetting(auth, 'session-secret', { secret: true });
		let cached: string | undefined;
		return async () => {
			if (cached) return cached;
			const value = await setting.get();
			if (!value) {
				throw new ApiError('The authentication service is not configured.', 500, {
					name: AuthErrors.InternalError,
				});
			}
			cached = value;
			return value;
		};
	},
	native: (host) => new NativeCognitoEngine(host),
	federation(host, provider) {
		if (provider.family === 'oidc' && provider.transport === 'direct') {
			// The stub IdP is mounted only on the local dev server — unless the
			// provider opted in with `unsafeAllowDeployed` (synth refuses it otherwise).
			if (isStubProvider(provider.config)) {
				return stubAllowsDeployment(provider.config.stubIdp)
					? deployedStubIdp(host, provider, provider.config)
					: unavailableFederationEngine(provider, 'stub-deployed');
			}
			return new DirectFederationEngine(host, provider, { allowInsecure: false });
		}
		// Social, SAML and `federateVia: 'cognito'`: Cognito managed login.
		return new HostedUiFederationEngine(host, provider);
	},
	routes: (host) => mountFederationRoutes(host),
	// `allowBearerAuth`: Cognito-signed access tokens only (never `alg: none`).
	poolBearer: (host) => new CognitoAccessTokenVerifier(host),
	// Q10: when `validateUser` is set on a pool this block creates, the CDK layer
	// points the pool's PreSignUp trigger at this Lambda; core routes the event by
	// user pool id. R2-1: registered only by the block the CDK layer wired the
	// trigger for — it says so with the `preSignUpTriggerConfigKey` flag — never
	// inferred here from the pool id alone. Otherwise a second `Auth` wrapping the
	// same pool (`userPool: Auth.fromExisting(…)`, e.g. for `admin`) would claim
	// the same key; core refuses a second registration, and before it did, the
	// later block silently replaced the owner's handler and accepted every
	// sign-up unchecked. The pool id is empty during client code generation.
	//
	// While a deploy adds or removes `validateUser`, the code and the config can
	// briefly disagree; every mix fails closed or runs the current code's check:
	// a flag without `validateUser` registers a handler that accepts (the trigger
	// is being removed), and `validateUser` without the flag registers none, so
	// core rejects the event ("not configured") until the config arrives.
	preSignUpTrigger(host) {
		const userPoolId = process.env[cognitoConfigKeys(host.scope.fullId).USER_POOL_ID];
		if (!userPoolId) return;
		if (process.env[preSignUpTriggerConfigKey(host.scope.fullId)] !== 'true') return;
		host.scope.registerLambdaEventHandler(EventSourceMapping.COGNITO_USER_POOL, userPoolId, (event) =>
			host.handle(event),
		);
	},
};

/**
 * The unified auth Building Block, published as `@aws-blocks/bb-auth` and exported
 * from `@aws-blocks/blocks`. See the package README.
 *
 * @typeParam O - The options literal, captured with `const` so inline options
 * narrow the method surface without `as const`.
 */
export class Auth<const O extends AuthOptions = AuthOptions> extends AuthBase<O> {
	// biome-ignore lint/complexity/noUselessConstructor: pins the documented constructor signature of this entry
	constructor(scope: ScopeParent, id: string, options?: O) {
		super(scope, id, options);
	}
}
defineAuthLayer(Auth, AWS_LAYER);
