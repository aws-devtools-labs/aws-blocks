// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The public options (`store` + one tagged `providers` map, see `AuthOptions`)
 * → the internal shape every layer reads ({@link ResolvedAuthOptions}: one map
 * per provider family, and `federateVia` per OIDC provider).
 *
 * Every entry's constructor calls {@link resolveOptions} once; the CDK, runtime
 * and mock layers and the engines only ever see the resolved shape. Provider
 * keys pass through unchanged — they drive construct ids (`saml-<id>`,
 * `idp-<id>`) and Cognito identity-provider names, so the same key always
 * yields the same resources.
 *
 * Pure and dependency-free. Not exported from any package entry point.
 *
 * @internal
 */

import type {
	AmazonProvider,
	AppleProvider,
	AuthOptions,
	AuthStore,
	CognitoAuthOptions,
	CognitoOidcProvider,
	DirectOidcProvider,
	FacebookProvider,
	GoogleProvider,
	OAuth2Provider,
	SamlProvider,
	SocialProviderId,
	StubProvider,
} from './types.js';

/** A public provider shape without its `type` tag (the resolved maps carry the family instead). */
type Untagged<P> = Omit<P, 'type'>;

/** The social providers, keyed by their fixed id (`google`, …). @internal */
export interface SocialProviders {
	google?: Untagged<GoogleProvider>;
	facebook?: Untagged<FacebookProvider>;
	amazon?: Untagged<AmazonProvider>;
	apple?: Untagged<AppleProvider>;
}

/** A directly federated OIDC provider (a `'blocks'` block's `type: 'oidc'`). @internal */
export interface DirectOidcProviderOptions extends Untagged<DirectOidcProvider> {
	federateVia?: 'direct';
}

/** A Cognito-federated OIDC provider (a `'cognito'` block's `type: 'oidc'`). @internal */
export interface CognitoOidcProviderOptions extends Untagged<CognitoOidcProvider> {
	federateVia: 'cognito';
}

/** A bare OAuth 2.0 provider (`type: 'oauth2'`), federated directly. @internal */
export interface OAuth2ProviderOptions extends Untagged<OAuth2Provider> {
	federateVia?: 'direct';
}

/** A stub IdP provider (`type: 'stub'`), federated directly. @internal */
export interface StubOidcProviderOptions extends Untagged<StubProvider> {
	federateVia?: 'direct';
}

/**
 * One resolved OIDC entry. `federateVia` selects the engine; OAuth 2.0 and
 * stub providers are direct ones (structural subtypes of the direct shape).
 *
 * @internal
 */
export type OidcProviderOptions = DirectOidcProviderOptions | CognitoOidcProviderOptions;

/** One resolved SAML entry. @internal */
export type SamlProviderOptions = Untagged<SamlProvider>;

/**
 * The options as every layer reads them. Everything but the provider
 * configuration is the caller's, unchanged (including the mock-only
 * `codeDelivery` / `totpVerification`, read structurally by the mock).
 *
 * For `store: 'blocks'`, `emailPassword` is `false`, so the email + password
 * helpers (`emailPasswordEnabled`, `requiresUserPool`) see no pool method.
 *
 * @internal
 */
export interface ResolvedAuthOptions extends Omit<CognitoAuthOptions, 'store' | 'providers'> {
	/** The block's store; `undefined` is `'cognito'` (a hand-built resolved object in a test). */
	store?: AuthStore;
	socialProviders?: SocialProviders;
	oidcProviders?: Record<string, OidcProviderOptions>;
	samlProviders?: Record<string, SamlProviderOptions>;
}

const SOCIAL_TYPES: readonly SocialProviderId[] = ['google', 'facebook', 'amazon', 'apple'];

function describeType(type: unknown): string {
	return typeof type === 'string' ? `\`type: '${type}'\`` : 'no `type`';
}

/** The entry without its `type` tag. */
function untag<P extends { type: unknown }>(entry: P): Untagged<P> {
	const { type: _type, ...config } = entry;
	return config;
}

/**
 * Resolve the public options into {@link ResolvedAuthOptions}.
 *
 * - `store` omitted or `'cognito'`: social entries go to `socialProviders`,
 *   SAML to `samlProviders`, OIDC to `oidcProviders` with
 *   `federateVia: 'cognito'`.
 * - `store: 'blocks'`: every entry goes to `oidcProviders` with
 *   `federateVia: 'direct'`, and `emailPassword` is `false`.
 *
 * Provider keys pass through unchanged. A social entry must be keyed by its
 * `type` (`google: { type: 'google', … }`): Cognito registers social providers
 * under fixed names, and the resolved map is keyed by them, so the key is the
 * provider id everywhere — at most one entry per social type.
 *
 * @throws Error for a provider `type` the store does not accept (or none), two
 *   entries with the same social `type`, and a social entry keyed differently
 *   from its `type` — the backstop for configurations the compiler did not see
 *   (plain JavaScript, casts, a `: AuthOptions` variable).
 * @internal
 */
export function resolveOptions(options: AuthOptions): ResolvedAuthOptions {
	if (options.store === 'blocks') {
		const { store, providers, ...rest } = options;
		const oidcProviders: Record<string, OidcProviderOptions> = {};
		for (const [id, entry] of Object.entries(providers ?? {})) {
			if (!entry) continue;
			if (entry.type !== 'oidc' && entry.type !== 'oauth2' && entry.type !== 'stub') {
				throw new Error(
					`Auth: providers.${id} has ${describeType(Reflect.get(entry, 'type'))}, which needs \`store: 'cognito'\` (the default). ` +
						"A `store: 'blocks'` block accepts `type: 'oidc'`, `'oauth2'` (`github()`, `customOauth2()`) and `'stub'` (`stubIdp()`).",
				);
			}
			oidcProviders[id] = { ...untag(entry), federateVia: 'direct' };
		}
		return { ...rest, store, emailPassword: false, oidcProviders };
	}

	const { store, providers, ...rest } = options;
	const entries = Object.entries(providers ?? {}).filter(([, entry]) => entry);
	for (const type of SOCIAL_TYPES) {
		const ids = entries.filter(([, entry]) => entry.type === type).map(([id]) => `providers.${id}`);
		if (ids.length > 1) {
			throw new Error(
				`Auth: ${ids.join(' and ')} all have \`type: '${type}'\`. Cognito registers one provider per social type: keep one entry.`,
			);
		}
	}
	const resolved: ResolvedAuthOptions = { ...rest, store: store ?? 'cognito' };
	for (const [id, entry] of entries) {
		switch (entry.type) {
			case 'google':
			case 'facebook':
			case 'amazon':
			case 'apple':
				if (id !== entry.type) {
					throw new Error(
						`Auth: providers.${id} has \`type: '${entry.type}'\`, so its key must be \`${entry.type}\`: ` +
							'a social provider is keyed by its type (google, facebook, amazon, apple).',
					);
				}
				resolved.socialProviders ??= {};
				if (entry.type === 'apple') resolved.socialProviders.apple = untag(entry);
				else resolved.socialProviders[entry.type] = untag(entry);
				break;
			case 'saml':
				resolved.samlProviders ??= {};
				resolved.samlProviders[id] = untag(entry);
				break;
			case 'oidc':
				resolved.oidcProviders ??= {};
				resolved.oidcProviders[id] = { ...untag(entry), federateVia: 'cognito' };
				break;
			default:
				throw new Error(
					`Auth: providers.${id} has ${describeType(Reflect.get(entry, 'type'))}, which a Cognito user pool cannot federate. ` +
						"`type: 'oauth2'` (`github()`, `customOauth2()`) and `'stub'` (`stubIdp()`) need `store: 'blocks'`; " +
						"the default store accepts `type: 'google'`, `'facebook'`, `'amazon'`, `'apple'`, `'saml'` and `'oidc'`.",
				);
		}
	}
	return resolved;
}
