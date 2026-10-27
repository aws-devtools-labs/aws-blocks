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
import {
	BuildingBlockScope,
	DEFAULT_NODE_RUNTIME,
	getRegisteredConfigValue,
	getSharedGatewayUrl,
	registerConfig,
	synthGuard,
} from '@aws-blocks/core/cdk';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { AppSetting, SECRETS_BULK_CONSTRUCT_ID } from '@aws-blocks/bb-app-setting';
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
	signInRoutePathFor,
} from './auth-oidc.js';
import { cognitoEnvPrefix, cookieSecretEnvVar } from './utils.js';

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
import { BB_NAME } from './version.js';

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

	constructor(scope: ScopeParent, id: string, options: AuthOIDCOptions<P>) {
		super(id, { parent: scope, bbName: BB_NAME, vpc: { interfaceEndpoints: [ec2.InterfaceVpcEndpointAwsService.SSM] } });

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

		// The callback path must match the BB's callback route (under `/aws-blocks/auth/`).
		const callbackPath = options.callbackPath ?? DEFAULT_CALLBACK_PATH;
		const { callbackUrls, logoutUrls } = this.cognitoClientUrls(cognitoProviders, callbackPath);
		const client = pool.addClient('app-client', {
			generateSecret: true,
			oAuth: {
				flows: { authorizationCodeGrant: true },
				scopes: [
					cognito.OAuthScope.OPENID,
					cognito.OAuthScope.EMAIL,
					cognito.OAuthScope.PROFILE,
				],
				callbackUrls,
				logoutUrls,
			},
			supportedIdentityProviders: idpDependencies.length > 0
				? cognitoProviders.map(p => cognito.UserPoolClientIdentityProvider.custom(p.identityProvider))
				: undefined,
		});

		for (const dep of idpDependencies) {
			client.node.addDependency(dep);
		}

		const envPrefix = cognitoEnvPrefix(this.fullId);
		registerConfig(this, `${envPrefix}_POOL_ID`, pool.userPoolId);
		registerConfig(this, `${envPrefix}_CLIENT_ID`, client.userPoolClientId);
		registerConfig(this, `${envPrefix}_CLIENT_SECRET`, client.userPoolClientSecret.unsafeUnwrap());
		registerConfig(this, `${envPrefix}_REGION`, stack.region);
		registerConfig(this, `${envPrefix}_DOMAIN`, domainConfig.cognitoDomain);
	}

	/**
	 * The callback and sign-out URLs registered on the Cognito app client. They
	 * must match the `redirect_uri` the runtime sends (`computeCallbackUrl` in
	 * `auth-oidc.ts`), or Cognito's `/oauth2/authorize` answers `redirect_mismatch`.
	 *
	 * Both lists are `cdk.Lazy` because the URLs they need don't exist yet when
	 * `AuthOIDC` is constructed: the backend module (where `AuthOIDC` is built) is
	 * imported before `create()` builds the shared API Gateway, and
	 * `BLOCKS_PUBLIC_ORIGIN` is registered later still — by `Hosting` (built after
	 * `create()` resolves) or by the managed `apiFrontDoor: 'cloudfront'` aspect
	 * (which runs at synth). The producers run at synth, after all of that.
	 *
	 * Each list holds, de-duplicated:
	 *
	 * - `BLOCKS_PUBLIC_ORIGIN` + path, when a front door publishes an `https://`
	 *   one — what the runtime sends whenever that origin is set (CloudFront /
	 *   custom domain / HTTPS ALB / stacked doors, and `apiFrontDoor: 'cloudfront'`).
	 * - The shared API Gateway URL (`restApi.url`, stage included) + path — what
	 *   the runtime derives from the request when no public origin is published
	 *   (bare API Gateway). The gateway fronts every compute target, so this holds
	 *   whatever compute serves the auth routes.
	 * - `http://localhost:3000` + path, in sandbox mode only — the local dev
	 *   server's loopback origin.
	 * - The caller's `additionalCallbackUrls` / `additionalLogoutUrls`.
	 *
	 * Neither list can come out empty in a deployed backend (the gateway URL is
	 * always present there); if neither the gateway nor anything else is
	 * available (an isolated unit test with no backend root), the producer falls
	 * back to the original `https://localhost` placeholder so the client still
	 * synthesizes.
	 */
	private cognitoClientUrls(
		cognitoProviders: readonly CognitoFederatedProvider[],
		callbackPath: string,
	): { callbackUrls: string[]; logoutUrls: string[] } {
		const sandbox =
			this.node.tryGetContext('sandboxMode') === 'true' || this.node.tryGetContext('sandboxMode') === true;
		// Origin roots, resolved at synth. Each ends WITH a trailing slash, so it is
		// itself the sign-out URL and the callback URL is the root + the path minus
		// its leading `/` (no double slash). Token-safe: the gateway URL is an
		// opaque `${Token[...]}` string whose trailing `/` can't be stripped before
		// deploy, so a suffix is appended rather than trimmed — the same join the
		// shared gateway uses for `apiUrl`.
		const originRoots = (): string[] => {
			const roots: string[] = [];
			// `https://<domain>` (no trailing slash), as published by Hosting / the front door.
			// Only an `https://` origin is registered: Cognito accepts plain `http://` only
			// for `localhost`, so registering a plain-HTTP door (an ALB without a
			// certificate publishes `http://<alb-dns>`) would fail the app client's deploy.
			// Skipping it does NOT make sign-in work through the gateway URL instead: the
			// runtime (`computeCallbackUrl`) sends `BLOCKS_PUBLIC_ORIGIN` as the
			// `redirect_uri` whenever it is set, so sign-in through such a door fails with
			// `redirect_mismatch` until the app is served over HTTPS. A synth warning says
			// so (see `warnOnPlainHttpPublicOrigin`).
			const publicOrigin = this.classifyPublicOrigin();
			if (publicOrigin?.kind === 'register') {
				roots.push(`${publicOrigin.origin}/`);
			}
			// `restApi.url` = `https://{id}.execute-api.{region}.amazonaws.com/{stage}/`.
			const gatewayUrl = getSharedGatewayUrl(this);
			if (gatewayUrl) roots.push(gatewayUrl);
			if (sandbox) roots.push('http://localhost:3000/');
			return roots;
		};
		const relativeCallbackPath = callbackPath.replace(/^\/+/, '');
		const dedupe = (urls: readonly (string | undefined)[]): string[] =>
			[...new Set(urls.filter((u): u is string => !!u))];
		const extraCallbacks = cognitoProviders.flatMap(p => p.additionalCallbackUrls ?? []);
		const extraLogouts = cognitoProviders.flatMap(p => p.additionalLogoutUrls ?? []);
		// Fail at synth on caller URLs Cognito would reject at deploy (late, as a
		// CloudFormation failure). Token entries can't be inspected and are left as-is.
		for (const p of cognitoProviders) {
			for (const u of p.additionalCallbackUrls ?? []) assertCognitoClientUrl(u, 'additionalCallbackUrls', p.identityProvider);
			for (const u of p.additionalLogoutUrls ?? []) assertCognitoClientUrl(u, 'additionalLogoutUrls', p.identityProvider);
		}
		this.warnOnPlainHttpPublicOrigin();

		const callbackUrls = cdk.Lazy.list({
			produce: () => {
				const urls = dedupe([...originRoots().map(root => `${root}${relativeCallbackPath}`), ...extraCallbacks]);
				// Cognito requires at least one callback URL once OAuth flows are on.
				return urls.length > 0 ? urls : [`https://localhost${callbackPath}`];
			},
		});
		const logoutUrls = cdk.Lazy.list({
			produce: () => {
				const urls = dedupe([...originRoots(), ...extraLogouts]);
				return urls.length > 0 ? urls : ['https://localhost/'];
			},
		});
		return { callbackUrls, logoutUrls };
	}

	/**
	 * Decide whether `BLOCKS_PUBLIC_ORIGIN` can be registered on the Cognito app
	 * client. Called at synth (from the `cdk.Lazy` producers and the validation
	 * hook), after every front door has registered its origin.
	 *
	 * - `register`: the origin is `https://` — a literal `https://` prefix (the
	 *   usual `https://${Token}` CloudFront / custom-domain value), or a
	 *   whole-token value that resolves at synth to an `https://` string. A
	 *   whole-token value that only resolves at deploy (a CloudFormation
	 *   intrinsic) can't be scheme-checked at synth, so it is deliberately
	 *   registered as-is and Cognito validates it at deploy.
	 * - `skip`: the scheme is known at synth and isn't `https://` (e.g. a
	 *   certless ALB's `http://${Token}`). `display` is the origin when it is a
	 *   plain string, for the warning message.
	 * - `undefined`: no public origin is published.
	 */
	private classifyPublicOrigin():
		| { kind: 'register'; origin: string }
		| { kind: 'skip'; display?: string }
		| undefined {
		const origin = getRegisteredConfigValue(this, 'BLOCKS_PUBLIC_ORIGIN');
		if (typeof origin !== 'string' || !origin) return undefined;
		if (origin.startsWith('https://')) return { kind: 'register', origin };
		if (!cdk.Token.isUnresolved(origin)) return { kind: 'skip', display: origin };
		// Unresolved, with a literal non-https scheme in front (`http://${Token}`).
		if (/^[a-z][a-z0-9+.-]*:\/\//i.test(origin)) return { kind: 'skip' };
		// Whole token (e.g. a BYO door's `Lazy` string): resolve it if synth can.
		const resolved: unknown = cdk.Stack.of(this).resolve(origin);
		if (typeof resolved === 'string') {
			return resolved.startsWith('https://')
				? { kind: 'register', origin }
				: { kind: 'skip', display: resolved };
		}
		// Deliberate: a deploy-time intrinsic can't be scheme-checked at synth, so it is
		// registered as-is and Cognito validates the resolved URL at deploy.
		return { kind: 'register', origin };
	}

	/**
	 * Emit a synth warning when the app publishes a public origin that is not
	 * `https://` (so it is left off the Cognito app client). Runs as a validation
	 * hook, i.e. after aspects (the managed `apiFrontDoor` registers its origin in
	 * one) and after `Hosting` — the same point the `cdk.Lazy` producers see.
	 */
	private warnOnPlainHttpPublicOrigin(): void {
		this.node.addValidation({
			validate: () => {
				const publicOrigin = this.classifyPublicOrigin();
				if (publicOrigin?.kind === 'skip') {
					const shown = publicOrigin.display ? ` (${publicOrigin.display})` : '';
					cdk.Annotations.of(this).addWarningV2(
						'@aws-blocks/bb-auth-oidc:PlainHttpPublicOrigin',
						`The app's public origin${shown} is not https, so it was not registered as a Cognito ` +
							'callback URL (Cognito rejects http callback URLs other than localhost). The runtime ' +
							'sends the public origin as the redirect_uri whenever one is published, so federated ' +
							'sign-in will fail with redirect_mismatch until the app is served over https (for ' +
							'example, attach a certificate or a custom domain to the front door). For advanced ' +
							'setups, register extra redirect targets with additionalCallbackUrls.',
					);
				}
				return [];
			},
		});
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

		const cr = new CustomResource(this, `idp-${provider.name}`, {
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

		// A `secret: true` AppSetting's SecureString value is written by the shared
		// bb-app-setting bulk-init custom resource (a direct child of the stack).
		// Depend on it so the parameter exists before this handler reads it — a hard
		// ordering guarantee rather than leaving it to the handler's read-retry. The
		// construct id comes from bb-app-setting's exported `SECRETS_BULK_CONSTRUCT_ID`
		// (not a hard-coded string), so a rename there can't silently break this
		// cross-package coupling — it's a compile-time dependency. The lookup can
		// still legitimately miss (e.g. a non-BlocksStack test harness, or no secret
		// AppSetting at all), in which case the read-retry remains the fallback.
		const bulkSecrets = cdk.Stack.of(this).node.tryFindChild(SECRETS_BULK_CONSTRUCT_ID);
		if (bulkSecrets) cr.node.addDependency(bulkSecrets);

		return cr;
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

	/**
	 * The absolute-within-host path for a provider's sign-in kickoff route.
	 * Derived from `callbackPath` with no I/O, so it works during synth too
	 * (e.g. to build a link or a `RawRoute` path at module scope).
	 */
	signInRoutePath(providerName: string): string {
		return signInRoutePathFor(this.callbackPath, providerName);
	}

	// Runtime-only methods throw during synth (see `synthGuard` in `@aws-blocks/core/cdk`).
	requireAuth(..._args: unknown[]): never { return synthGuard('AuthOIDC', 'requireAuth'); }
	checkAuth(..._args: unknown[]): never { return synthGuard('AuthOIDC', 'checkAuth'); }
	getCurrentUser(..._args: unknown[]): never { return synthGuard('AuthOIDC', 'getCurrentUser'); }
	getSignInUrl(..._args: unknown[]): never { return synthGuard('AuthOIDC', 'getSignInUrl'); }
	handleCallback(..._args: unknown[]): never { return synthGuard('AuthOIDC', 'handleCallback'); }
	handleCallbackDispatch(..._args: unknown[]): never { return synthGuard('AuthOIDC', 'handleCallbackDispatch'); }
	handleExchange(..._args: unknown[]): never { return synthGuard('AuthOIDC', 'handleExchange'); }
	getAuthorizeParams(..._args: unknown[]): never { return synthGuard('AuthOIDC', 'getAuthorizeParams'); }
	refreshBearerTokens(..._args: unknown[]): never { return synthGuard('AuthOIDC', 'refreshBearerTokens'); }
	signOut(..._args: unknown[]): never { return synthGuard('AuthOIDC', 'signOut'); }
}

/**
 * Schemes never accepted as a Cognito app-client URL, even though they parse.
 */
const DENIED_CLIENT_URL_SCHEMES: ReadonlySet<string> = new Set(['javascript', 'data', 'file', 'vbscript', 'blob', 'about']);

/**
 * OAuth query parameters the authorization server appends to the redirect; a
 * registered URL that already carries one collides with the redirect contract.
 * Mirrors the OAuth 2.0 authorization-code redirect parameters (`code`, `state`).
 */
const RESERVED_CLIENT_URL_QUERY_PARAMS: readonly string[] = ['code', 'state'];

/**
 * Synth-time check for a caller-supplied Cognito app-client URL
 * (`additionalCallbackUrls` / `additionalLogoutUrls`). The string is registered
 * on the app client exactly as written, so the string-level checks run on the
 * RAW value (WHATWG `URL` parsing normalizes some forms away) and `URL` parsing
 * is used only for structural checks. Rejected, as a synth error naming the URL
 * and the option:
 *
 * - whitespace or control characters anywhere (incl. leading/trailing);
 * - a backslash, or userinfo (`@`) in the authority;
 * - the `javascript:`, `data:`, `file:`, `vbscript:`, `blob:` and `about:`
 *   schemes;
 * - `http:` / `https:` without exactly `//` followed by a host, a wildcard
 *   (`*`) or non-ASCII host;
 * - plain `http://` whose host isn't `localhost` (Cognito accepts http only for
 *   localhost);
 * - a fragment (`#`), or a `code` / `state` query parameter;
 * - anything the `URL` constructor can't parse.
 *
 * Unresolved CDK tokens are skipped (their value isn't known at synth). Native
 * custom schemes (`myapp://auth/callback`, `com.example.app:/oauth2redirect`)
 * are accepted.
 */
function assertCognitoClientUrl(url: string, option: string, provider: string): void {
	if (cdk.Token.isUnresolved(url)) return;
	const where = `cognitoFederated('${provider}') option ${option}`;
	const reject: (reason: string) => never = reason => {
		throw new Error(`${where}: '${url}' ${reason}`);
	};

	// --- String-level checks on the raw value (before any normalization). ---
	// biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters is the point.
	if (url !== url.trim() || /[\s\x00-\x1F\x7F]/.test(url)) {
		reject('is not a valid URL: it contains whitespace or control characters.');
	}
	if (url.includes('\\')) reject('contains a backslash; use forward slashes only.');
	const schemeMatch = /^([a-z][a-z0-9+.-]*):/i.exec(url);
	if (!schemeMatch) reject('is not a valid URL: it has no scheme.');
	const scheme = schemeMatch[1].toLowerCase();
	if (DENIED_CLIENT_URL_SCHEMES.has(scheme)) {
		reject(`uses the '${scheme}:' scheme, which is not accepted for callback or sign-out URLs.`);
	}
	// Raw authority: what follows `scheme://` up to the first `/`, `?` or `#`.
	const rest = url.slice(scheme.length + 1);
	const authority = rest.startsWith('//') ? rest.slice(2).split(/[/?#]/, 1)[0] : undefined;
	if (authority?.includes('@')) reject('contains userinfo (\'@\') in the host; callback and sign-out URLs take a plain host.');
	if (authority?.includes('*')) reject('uses a wildcard host; register each host explicitly.');
	// Anything outside printable ASCII (control characters were rejected above).
	if (authority && /[^\u0020-\u007E]/.test(authority)) {
		reject('has a non-ASCII host; use its ASCII (punycode) form.');
	}
	const web = scheme === 'http' || scheme === 'https';
	// `https:///x` would be normalized by `URL` to host `x`; require `//<host>` verbatim.
	if (web && !authority) reject(`has no host; expected '${scheme}://<host>/...'.`);

	// --- Structural checks on the parsed URL. ---
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		reject('is not a valid URL.');
	}
	if (url.includes('#')) {
		reject("contains a URL fragment ('#'); Cognito does not accept fragments in callback or sign-out URLs.");
	}
	if (web && !parsed.hostname) reject(`has no host; expected '${scheme}://<host>/...'.`);
	if (scheme === 'http' && parsed.hostname !== 'localhost') {
		reject('uses http with a host other than localhost; Cognito accepts http only for localhost. Use an https URL.');
	}
	const reserved = RESERVED_CLIENT_URL_QUERY_PARAMS.filter(p => parsed.searchParams.has(p));
	if (reserved.length > 0) {
		reject(
			`carries the reserved OAuth query parameter(s) ${reserved.map(p => `'${p}'`).join(', ')}, which the authorization server appends on redirect.`,
		);
	}
}
