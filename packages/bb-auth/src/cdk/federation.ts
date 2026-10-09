// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Hosted-UI federation infrastructure for `Auth` (D3b): the `UserPoolDomain`,
 * a separate hosted-UI app client, and one identity-provider registration per
 * social / SAML / `federateVia: 'cognito'` provider.
 *
 * Provisioned **only** when at least one Cognito-federated provider is
 * configured; otherwise nothing here runs, and the template is exactly D3a's.
 *
 * New child construct ids (all under the block, none of them frozen-contract
 * ids, all stable from the first deploy that adds them):
 *
 * | id | resource |
 * |---|---|
 * | `domain` | `AWS::Cognito::UserPoolDomain` — prefix from {@link resolveDomainPrefix} |
 * | `hosted-ui-client` | `AWS::Cognito::UserPoolClient` — public client, code grant + PKCE |
 * | `saml-<id>` | `AWS::Cognito::UserPoolIdentityProvider` — SAML (no secret, so native) |
 * | `idp-<id>` | custom resource — social and Cognito-federated OIDC (secret read at deploy) |
 * | `idp-registration-fn` / `-logs` / `-provider` | the registration Lambda behind `idp-<id>` |
 *
 * @internal
 */

import { createHash } from 'node:crypto';
import { SECRETS_BULK_CONSTRUCT_ID } from '@aws-blocks/bb-app-setting';
import {
	type BuildingBlockScope,
	DEFAULT_NODE_RUNTIME,
	deployTimeLambdaCode,
	getBlocksRoot,
	registerConfig,
} from '@aws-blocks/core/cdk';
import * as cdk from 'aws-cdk-lib';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as cr from 'aws-cdk-lib/custom-resources';
import type { Construct, IDependable } from 'constructs';
import type { AuthOptions } from '../types.js';
import { federationConfigKeys, federationRedirectPaths } from './contract.js';
import {
	type IdpRegistration,
	idpRegistrations,
	RESERVED_DOMAIN_WORDS,
	validateDomainPrefix,
	validateFederationOptions,
} from './federation-providers.js';

/** The RPC prefix the default compute's `apiUrl` ends with (`BLOCKS_RPC_PREFIX` in core). */
const RPC_PREFIX = '/aws-blocks/api';

/**
 * Config key core's `Hosting` registers with the public origin the app is
 * served from (`hosting.distributionUrl`: the custom domain when one is set,
 * else the CloudFront default). Core keeps it a literal key; so do we.
 */
const PUBLIC_ORIGIN_KEY = 'BLOCKS_PUBLIC_ORIGIN';

/**
 * The config registry `registerConfig()` writes to (core's well-known symbol). It
 * lives on the backend root (`BlocksStack` / `BlocksBackend`) that owns the block,
 * which `getBlocksRoot` resolves — not on the enclosing `cdk.Stack`.
 */
const CONFIG_REGISTRY = Symbol.for('BLOCKS_CONFIG_REGISTRY');

/**
 * Derive the hosted-UI domain prefix from `fullId`: the lowercased `fullId`
 * (non-alphanumerics → `-`, Cognito's reserved words `aws` / `amazon` /
 * `cognito` removed, truncated) plus `-` and the first 8 hex chars of
 * `sha256(fullId)`. Always valid (≤ 63 chars, `[a-z0-9-]`, no leading/trailing
 * hyphen, no reserved word — hex digits cannot spell one) and deterministic.
 *
 * ⚠️ **Frozen once deployed.** `UserPoolDomain.Domain` is replace-only and
 * globally unique; a changed prefix kills every hosted-UI session and every
 * upstream IdP redirect URI. `federation.cdk.test.ts` pins the output.
 */
export function deriveDomainPrefix(fullId: string): string {
	const hash = createHash('sha256').update(fullId).digest('hex').slice(0, 8);
	let base = fullId.toLowerCase().replace(/[^a-z0-9]+/g, '-');
	// Removing one reserved word can splice another together ("awamazons"); repeat until stable.
	for (let previous = ''; previous !== base; ) {
		previous = base;
		for (const word of RESERVED_DOMAIN_WORDS) base = base.split(word).join('');
	}
	base = base
		.replace(/-+/g, '-')
		.replace(/^-+/, '')
		.slice(0, 63 - hash.length - 1)
		.replace(/-+$/, '');
	return base ? `${base}-${hash}` : hash;
}

/**
 * The validated `hostedUi.domainPrefix` override, or `undefined`. Checked at
 * runtime too (shape and value), for untyped JavaScript callers.
 */
function domainPrefixOverride(options: AuthOptions): string | undefined {
	const hostedUi: unknown = options.hostedUi;
	if (hostedUi === undefined) return undefined;
	if (typeof hostedUi !== 'object' || hostedUi === null) {
		throw new Error('Auth: `hostedUi` must be an object.');
	}
	if (!('domainPrefix' in hostedUi) || hostedUi.domainPrefix === undefined) return undefined;
	return validateDomainPrefix(hostedUi.domainPrefix, 'hostedUi.domainPrefix');
}

/** The prefix to provision: the validated override, else {@link deriveDomainPrefix}. */
export function resolveDomainPrefix(fullId: string, options: AuthOptions): string {
	return domainPrefixOverride(options) ?? deriveDomainPrefix(fullId);
}

/**
 * The public origin core's `Hosting` registered in the owning backend's config
 * registry, if any. Read lazily (at template resolution): `Hosting` is built
 * after the backend module, so it does not exist yet when `Auth` is constructed.
 */
function registeredPublicOrigin(root: Construct): string | undefined {
	const registry: unknown = Reflect.get(root, CONFIG_REGISTRY);
	if (typeof registry !== 'object' || registry === null || !('entries' in registry)) return undefined;
	const entries: unknown = registry.entries;
	if (!(entries instanceof Map)) return undefined;
	const origin: unknown = entries.get(PUBLIC_ORIGIN_KEY);
	return typeof origin === 'string' ? origin : undefined;
}

/**
 * The API front door: the base of the block's compute `apiUrl`
 * (`https://<api>.execute-api.<region>.amazonaws.com/<stage>`), the origin the
 * auth routes are reachable at when no `Hosting` fronts the API (sandbox mode,
 * or a backend-only deploy). `undefined` when the compute exposes no API URL.
 */
function apiOrigin(scope: BuildingBlockScope): string | undefined {
	const compute = scope.compute;
	if (!('apiUrl' in compute) || typeof compute.apiUrl !== 'string') return undefined;
	return cdk.Fn.select(0, cdk.Fn.split(RPC_PREFIX, compute.apiUrl));
}

/**
 * `<origin><path>` for every front door the browser can reach the auth routes
 * through: the API's own URL, and the `Hosting` public origin when the stack
 * has one. Both are deploy-time tokens resolved by CloudFormation — never a
 * placeholder. Lazy, so a `Hosting` constructed after `Auth` is still seen.
 */
function frontDoorUrls(scope: BuildingBlockScope, path: string, what: string): string[] {
	const api = apiOrigin(scope);
	const root = getBlocksRoot(scope);
	return cdk.Lazy.list(
		{
			produce: () => {
				const origins = [api, registeredPublicOrigin(root)].filter((o): o is string => o !== undefined);
				if (origins.length === 0) {
					throw new Error(
						`Auth '${scope.fullId}': hosted-UI federation needs a public URL for its ${what}, but the block's compute exposes no API URL and no Hosting public origin is registered for its backend.`,
					);
				}
				return [...new Set(origins)].map((origin) => `${origin}${path}`);
			},
		},
		{ omitEmpty: false },
	);
}

/** What {@link provisionHostedUiFederation} created. */
export interface HostedUiFederation {
	domain: cognito.UserPoolDomain;
	hostedUiClient: cognito.UserPoolClient;
	/** The prefix the domain was created with. */
	domainPrefix: string;
}

/**
 * Synth-time federation checks. Run before any resource is created so an
 * invalid configuration fails with the reason, and also usable without a
 * compute (in-process tests).
 */
export function validateHostedUiFederation(scope: BuildingBlockScope, options: AuthOptions): IdpRegistration[] {
	validateFederationOptions(options);
	resolveDomainPrefix(scope.fullId, options);
	// Resolves each provider secret to its SSM name (`secretParameterName`).
	return idpRegistrations(options);
}

/**
 * Provision the domain, the hosted-UI app client and every IdP registration on
 * `pool`, and register the federation config keys. Call only when
 * `cognitoFederatedProviderIds(options)` is non-empty.
 */
export function provisionHostedUiFederation(
	scope: BuildingBlockScope,
	pool: cognito.IUserPool,
	options: AuthOptions,
): HostedUiFederation {
	const registrations = validateHostedUiFederation(scope, options);
	const stack = cdk.Stack.of(scope);

	// ── Domain — create-only (replace-only + globally unique) ────────────────
	const domainPrefix = resolveDomainPrefix(scope.fullId, options);
	const domain = new cognito.UserPoolDomain(scope, 'domain', {
		userPool: pool,
		cognitoDomain: { domainPrefix },
	});

	// ── IdP registrations ────────────────────────────────────────────────────
	const idps: IDependable[] = [];
	const secretBearing = registrations.filter((r) => r.providerType !== 'SAML');
	const serviceToken = secretBearing.length > 0 ? registrationServiceToken(scope, pool, secretBearing) : undefined;
	// A `secret: true` AppSetting's value is written by bb-app-setting's shared
	// bulk-init custom resource. The provider secrets were constructed before
	// `Auth` (they are passed in), so the resource exists by now when any of them
	// is stack-managed; external (`fromExisting`) secrets need no ordering.
	const bulkSecrets = stack.node.tryFindChild(SECRETS_BULK_CONSTRUCT_ID);
	for (const r of registrations) {
		if (r.providerType === 'SAML') {
			idps.push(
				new cognito.CfnUserPoolIdentityProvider(scope, `saml-${r.id}`, {
					userPoolId: pool.userPoolId,
					providerName: r.providerName,
					providerType: 'SAML',
					providerDetails: r.details,
					attributeMapping: r.attributeMapping,
				}),
			);
			continue;
		}
		if (!serviceToken) throw new Error('Auth: internal error — no IdP registration provider.');
		const resource = new cdk.CustomResource(scope, `idp-${r.id}`, {
			serviceToken,
			resourceType: 'Custom::BlocksAuthIdentityProvider',
			properties: {
				UserPoolId: pool.userPoolId,
				ProviderName: r.providerName,
				ProviderType: r.providerType,
				ProviderDetails: r.details,
				SecretDetails: r.secretDetails,
				AttributeMapping: r.attributeMapping,
				// The secret values live in SSM and are read at deploy time, so a
				// rotation (an out-of-band SecureString write) changes no property
				// and would not re-invoke the handler. This nonce changes every synth,
				// so each deploy re-reads SSM and re-registers the IdP (an idempotent
				// update). Same trade-off as `AuthOIDC`'s deployed registration.
				Trigger: Date.now().toString(),
			},
		});
		if (bulkSecrets) resource.node.addDependency(bulkSecrets);
		idps.push(resource);
	}

	// ── Hosted-UI app client — SEPARATE from the frozen `client` ─────────────
	// A public client (no secret) using the authorization-code grant; the
	// runtime sends PKCE. Its callback / logout URLs are the real front doors
	// (API Gateway, and Hosting's public origin when present) — never a
	// `https://localhost` placeholder.
	const { callbackPath, signOutPath } = federationRedirectPaths(options);
	const hostedUiClient = new cognito.UserPoolClient(scope, 'hosted-ui-client', {
		userPool: pool,
		generateSecret: false,
		preventUserExistenceErrors: true,
		// No SDK sign-in flow on this client: refresh only.
		authFlows: { userPassword: false, userSrp: false, custom: false, adminUserPassword: false, user: false },
		oAuth: {
			flows: { authorizationCodeGrant: true },
			scopes: [cognito.OAuthScope.OPENID, cognito.OAuthScope.EMAIL, cognito.OAuthScope.PROFILE],
			callbackUrls: frontDoorUrls(scope, callbackPath, 'callback URL'),
			logoutUrls: frontDoorUrls(scope, signOutPath, 'sign-out URL'),
		},
		// Exactly the configured federated providers — no `COGNITO` (password
		// sign-in goes through the native client, never the hosted UI).
		supportedIdentityProviders: registrations.map((r) =>
			cognito.UserPoolClientIdentityProvider.custom(r.providerName),
		),
	});
	// Cognito rejects a client that lists a provider the pool does not have yet.
	for (const idp of idps) hostedUiClient.node.addDependency(idp);

	// ── Config — only in this (federated) configuration ──────────────────────
	// Token / revoke / logout are Cognito's OAuth HTTP endpoints, which need no
	// IAM; the runtime's existing `cognito-idp:*` grant covers the rest.
	const keys = federationConfigKeys(scope.fullId);
	registerConfig(scope, keys.DOMAIN, `${domain.domainName}.auth.${stack.region}.amazoncognito.com`);
	registerConfig(scope, keys.HOSTED_UI_CLIENT_ID, hostedUiClient.userPoolClientId);

	return { domain, hostedUiClient, domainPrefix };
}

/**
 * Directory of the esbuild-bundled registration handler (`npm run build:lambda`).
 * A vendorized copy has no `dist/`, so its source is bundled at synth instead
 * (`deployTimeLambdaCode` in `@aws-blocks/core/cdk`).
 */
const REGISTRATION_LAMBDA = {
	moduleUrl: import.meta.url,
	bundleDir: '../idp-registration-lambda',
	source: '../idp-registration-lambda',
	target: 'node22', // = build:lambda
} as const;

/**
 * The deploy-time registration Lambda + `Provider`, ported from `AuthOIDC`'s
 * deployed approach. It reads each secret's SecureString by name and calls
 * `Create/Update/DeleteIdentityProvider`, so the secret never appears in the
 * template. Returns the provider's service token.
 */
function registrationServiceToken(
	scope: BuildingBlockScope,
	pool: cognito.IUserPool,
	registrations: readonly IdpRegistration[],
): string {
	const stack = cdk.Stack.of(scope);
	const fn = new lambda.Function(scope, 'idp-registration-fn', {
		runtime: DEFAULT_NODE_RUNTIME,
		handler: 'index.handler',
		timeout: cdk.Duration.minutes(2),
		// Own the log group so retention follows the stack default, not "forever".
		logGroup: new logs.LogGroup(scope, 'idp-registration-logs', {
			retention: scope.defaults.logRetention,
			removalPolicy: cdk.RemovalPolicy.DESTROY,
		}),
		code: deployTimeLambdaCode(REGISTRATION_LAMBDA),
	});
	fn.addToRolePolicy(
		new iam.PolicyStatement({
			actions: [
				'cognito-idp:CreateIdentityProvider',
				'cognito-idp:UpdateIdentityProvider',
				'cognito-idp:DeleteIdentityProvider',
				'cognito-idp:DescribeIdentityProvider',
			],
			resources: [pool.userPoolArn],
		}),
	);
	const parameterArns = [...new Set(registrations.flatMap((r) => Object.values(r.secretDetails)))].map((name) =>
		stack.formatArn({ service: 'ssm', resource: 'parameter', resourceName: name.replace(/^\//, '') }),
	);
	fn.addToRolePolicy(new iam.PolicyStatement({ actions: ['ssm:GetParameter'], resources: parameterArns }));
	// SecureString decryption goes through KMS via SSM. `kms:ViaService` covers
	// the default `aws/ssm` key and a customer-managed key (whose own key policy
	// must also allow this role).
	fn.addToRolePolicy(
		new iam.PolicyStatement({
			actions: ['kms:Decrypt'],
			resources: ['*'],
			conditions: { StringEquals: { 'kms:ViaService': `ssm.${stack.region}.amazonaws.com` } },
		}),
	);
	const provider = new cr.Provider(scope, 'idp-registration-provider', {
		onEventHandler: fn,
		logGroup: new logs.LogGroup(scope, 'idp-registration-provider-logs', {
			retention: scope.defaults.logRetention,
			removalPolicy: cdk.RemovalPolicy.DESTROY,
		}),
	});
	return provider.serviceToken;
}
