// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Mock-runtime entry point for `AuthOIDC`.
 * Wires to an in-process stub IdP via `OidcClientEngine`.
 */

import { randomBytes } from 'node:crypto';
import { buildingBlockParent, getSdkIdentifiers, registerSdkIdentifiers, type ScopeParent } from '@aws-blocks/core';
import { getMockDataDir, assertNotMockInDeployedEnv } from '@aws-blocks/core/bb-utils';
import { resolveCookieSecurity } from '@aws-blocks/auth-common/cookies';
import { KVStore } from '@aws-blocks/bb-kv-store';
import { AuthOIDC as AuthOIDCBase, DEFAULT_CALLBACK_PATH } from './auth-oidc.js';
import type { AuthEngine } from './engine.js';
import { OidcClientEngine } from './engines/oidc-client-engine.js';
import { CognitoFederationEngine } from './engines/cognito-federation-engine.js';
import { SessionManager } from './engines/session-manager.js';
import { mountAuthRoutes, mountStubIdpRoutes } from './routes.js';
import { resolveProviderIssuerUrl } from './utils.js';
import type { AuthOIDCOptions, ProviderConfig, SessionRow } from './types.js';
import { BB_NAME, BB_VERSION } from './version.js';

// Fail closed if this mock entry loads in a deployed env — see assertNotMockInDeployedEnv.
assertNotMockInDeployedEnv('bb-auth-oidc');

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

/**
 * Cookie-signing secret for the mock runtime. Ephemeral and random per
 * process: sign and verify both happen in the same local process, so the
 * cookie round-trip is unaffected. It intentionally does not persist across
 * restarts (sessions from a previous dev-server run are dropped) — the mock is
 * local-dev only. It's held on `globalThis` (like `bb-realtime`'s local token
 * secret) so duplicate copies of this module in one process agree on it.
 */
const MOCK_COOKIE_SECRET_KEY = Symbol.for('@aws-blocks/bb-auth-oidc.mockCookieSecret');
const mockCookieSecretHolder = globalThis as unknown as Record<symbol, string | undefined>;
mockCookieSecretHolder[MOCK_COOKIE_SECRET_KEY] ??= randomBytes(32).toString('hex');
const MOCK_COOKIE_SECRET: string = mockCookieSecretHolder[MOCK_COOKIE_SECRET_KEY];

/**
 * Credential resolver for the mock runtime's Cognito engine. `cognitoFederated`
 * requires a deployed Cognito User Pool + app-client credentials (provisioned by
 * CDK at deploy), which don't exist in local `npm run dev`. Throwing here gives a
 * clear, actionable error at sign-in time instead of a confusing OIDC failure.
 */
function cognitoUnavailableLocally(): never {
	throw new Error(
		"AuthOIDC: cognitoFederated() isn't available in local `npm run dev` — it needs a "
			+ 'deployed Cognito User Pool. Add a stubIdp({ name }) provider for local sign-in, '
			+ 'or run `npm run sandbox` / `npm run deploy` to exercise the real Cognito flow.',
	);
}

/**
 * OIDC sign-in gate (mock runtime). See `auth-oidc.ts` for class-level docs.
 * Mounts stub IdP per provider + callback/sign-out routes on the dev server.
 */
export class AuthOIDC<
	P extends readonly ProviderConfig[] = readonly ProviderConfig[],
> extends AuthOIDCBase<P> {

	constructor(scope: ScopeParent, id: string, options: AuthOIDCOptions<P>) {
		const self = buildingBlockParent({ id, parent: scope, bbName: BB_NAME, bbVersion: BB_VERSION });
		const sessions = new KVStore<SessionRow>(self, 'sessions');

		// The same expression as the AWS runtime; `user-agent.test.ts` pins the pair.
		const cookieNamePrefix = `oidc_${self.fullId}`;
		const cookieAttributes = {
			...resolveCookieSecurity({
				crossDomain: options.crossDomain ?? false,
				isLocalhost: true,
			}),
			path: '/',
		};

		// Engine selection mirrors the AWS runtime (index.aws.ts): a
		// `cognito-federated` provider needs the Cognito-specific engine, not the
		// standard OIDC one. Keeping the two runtimes in sync is essential — when
		// they drifted, the mock built `OidcClientEngine` for cognito-federated
		// and ran OIDC discovery against an empty issuer, crashing `npm run dev`.
		const hasCognitoFederated = options.providers.some((p) => p.kind === 'cognito-federated');

		let engine: AuthEngine;
		if (hasCognitoFederated) {
			// Cognito federation needs a deployed Cognito User Pool + app-client
			// credentials, which only exist after `npm run sandbox`/`deploy`. In the
			// local mock those aren't available, so the credential resolvers fail
			// fast with an actionable message the moment a cognito-federated sign-in
			// is attempted (construction stays lazy, so declaring the provider does
			// not block `npm run dev` for the rest of the app).
			const sessionManager = new SessionManager({
				sessionStore: sessions,
				cookieSecret: MOCK_COOKIE_SECRET,
				cookieNamePrefix,
				cookieAttributes,
			});
			engine = new CognitoFederationEngine({
				providers: options.providers,
				sessionManager,
				cognitoClientId: cognitoUnavailableLocally,
				cognitoClientSecret: cognitoUnavailableLocally,
				cognitoUserPoolId: cognitoUnavailableLocally,
				allowedRelayOrigins: options.allowedRelayOrigins,
			});
		} else {
			engine = new OidcClientEngine({
				providers: options.providers,
				sessionStore: sessions,
				cookieSecret: MOCK_COOKIE_SECRET,
				cookieNamePrefix,
				cookieAttributes,
				callbackPath: options.callbackPath ?? DEFAULT_CALLBACK_PATH,
				postSignInPath: options.postSignInPath ?? '/',
				resolveIssuerUrl: resolveProviderIssuerUrl,
				allowInsecureIssuers: true,
				allowedRelayOrigins: options.allowedRelayOrigins,
			});
		}
		super(scope, id, options, engine, { bbName: BB_NAME, bbVersion: BB_VERSION });
		registerSdkIdentifiers(this.fullId, {
			sessionTableName: getSdkIdentifiers(sessions).tableName,
		});

		const dataDir = getMockDataDir(this);
		for (const provider of options.providers) {
			if (provider.kind === 'stub') {
				mountStubIdpRoutes(this, provider, dataDir);
			}
		}

		this.logResolvedProviders(options.providers);

		mountAuthRoutes(this);
	}

	private logResolvedProviders(providers: readonly ProviderConfig[]): void {
		// console.log, not this.log: the instance logger defaults to error level,
		// and this banner must show in `npm run dev` without extra config.
		for (const provider of providers) {
			if (provider.kind === 'stub') {
				console.log(
					`[auth] provider "${provider.name}" → Blocks stub IdP (local sign-in, no real credentials)`,
				);
			} else {
				const issuerUrl =
					provider.kind === 'oidc-builtin' || provider.kind === 'oidc-custom'
						? provider.issuerUrl
						: undefined;
				console.log(
					`[auth] provider "${provider.name}" → ${issuerUrl ?? '(configured IdP)'} (real IdP)`,
				);
			}
		}
	}
}
