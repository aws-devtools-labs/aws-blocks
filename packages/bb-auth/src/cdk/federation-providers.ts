// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * `AuthOptions` provider records → Cognito identity-provider registrations, and
 * the synth-time checks for them (D3b).
 *
 * Pure: no `aws-cdk-lib`. `federation.ts` turns each {@link IdpRegistration}
 * into CloudFormation; keeping the mapping here lets it be tested without a
 * synth and keeps the per-provider rules in one table.
 *
 * Secrets never appear in a registration's `details`. A secret-bearing value
 * (`client_secret`, Sign in with Apple's `private_key`) is recorded as the
 * **name** of the SSM SecureString that holds it, in `secretDetails`; the
 * deploy-time registration Lambda reads and decrypts it. CloudFormation does
 * not accept an `ssm-secure` dynamic reference on
 * `AWS::Cognito::UserPoolIdentityProvider.ProviderDetails` (see DESIGN.md).
 *
 * @internal
 */

import type {
	AppSettingRef,
	AuthOptions,
	CognitoOidcProviderOptions,
	ProviderCommon,
	SamlProviderOptions,
} from '../types.js';
import { AUTH_ROUTE_PREFIX, type CognitoFederatedKind, cognitoFederatedProviders } from './contract.js';

/** Cognito `ProviderType` values `Auth` registers. */
export type IdpProviderType = 'Google' | 'Facebook' | 'LoginWithAmazon' | 'SignInWithApple' | 'OIDC' | 'SAML';

/** One identity provider to register on the pool. */
export interface IdpRegistration {
	/** The provider id — the key in `socialProviders` / `samlProviders` / `oidcProviders`. */
	id: string;
	kind: CognitoFederatedKind;
	/** Cognito `ProviderName` (`Google`, `SignInWithApple`, or the id for OIDC / SAML). */
	providerName: string;
	providerType: IdpProviderType;
	/** Non-secret `ProviderDetails`. */
	details: Record<string, string>;
	/** `ProviderDetails` key → SSM SecureString parameter **name** (never the value). Empty for SAML. */
	secretDetails: Record<string, string>;
	/** Cognito `AttributeMapping`: pool attribute → IdP claim. */
	attributeMapping: Record<string, string>;
}

/**
 * Default `authorize_scopes` per provider, and how Cognito expects them joined
 * (Facebook's are comma-separated; everyone else's space-separated — the same
 * rule CDK's L2 providers apply).
 */
const SCOPES: Record<'google' | 'facebook' | 'amazon' | 'apple' | 'oidc', { defaults: string[]; join: string }> = {
	google: { defaults: ['openid', 'email', 'profile'], join: ' ' },
	facebook: { defaults: ['public_profile', 'email'], join: ',' },
	amazon: { defaults: ['profile'], join: ' ' },
	apple: { defaults: ['email', 'name'], join: ' ' },
	oidc: { defaults: ['openid', 'email', 'profile'], join: ' ' },
};

/** Default claim mapping for OAuth/OIDC-style providers (what `AuthOIDC` ships today). */
const DEFAULT_OIDC_MAPPING: Readonly<Record<string, string>> = { email: 'email', name: 'name' };

/** Default SAML mapping: the email claim URI Entra ID, ADFS and Okta's SAML templates emit. */
const DEFAULT_SAML_MAPPING: Readonly<Record<string, string>> = {
	email: 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress',
};

/**
 * Cognito standard attributes an IdP claim may be mapped onto. `sub` and
 * `username` are deliberately absent: identity is never mappable (see
 * `ProviderCommon.attributeMapping`).
 */
const STANDARD_ATTRIBUTES = new Set([
	'address',
	'birthdate',
	'email',
	'email_verified',
	'family_name',
	'gender',
	'given_name',
	'locale',
	'middle_name',
	'name',
	'nickname',
	'phone_number',
	'phone_number_verified',
	'picture',
	'preferred_username',
	'profile',
	'updated_at',
	'website',
	'zoneinfo',
]);

/** Keys that identify a user. Rejected at runtime too, for untyped callers (the type closes them off). */
const IDENTITY_KEYS = new Set(['sub', 'userSub', 'userId', 'username']);

/** Provider names Cognito reserves (case-insensitive) — unusable as an OIDC / SAML id. */
const RESERVED_PROVIDER_NAMES = new Set(['cognito', 'google', 'facebook', 'loginwithamazon', 'signinwithapple']);

/** Cognito's `ProviderName` pattern (`[^_\p{Z}][\p{L}\p{M}\p{S}\p{N}\p{P}][^_\p{Z}]+`), 3–32 characters. */
const PROVIDER_NAME_PATTERN = /^[^_\p{Z}][\p{L}\p{M}\p{S}\p{N}\p{P}][^_\p{Z}]+$/u;

/**
 * The SSM SecureString name an `AppSettingRef` resolves to, read from the
 * `AppSetting`'s CDK layer: its `parameterName` — the explicit `name`, the
 * `AppSetting.fromExisting()` name, or the default `/<fullId>` — the same name
 * its runtime reads. Fails at synth, never at deploy, for:
 * - a value that is not an object with a `fullId` (e.g. a plain-text string);
 * - an object that is not an `AppSetting` (a hand-made `{ fullId, get }`): it
 *   carries no parameter name, and guessing `/<fullId>` could register the IdP
 *   with a parameter that does not exist;
 * - a non-secret `AppSetting`: a provider secret in a plaintext SSM `String` is
 *   readable by anyone with `ssm:GetParameter`.
 */
export function secretParameterName(ref: AppSettingRef, what: string): string {
	if (!ref || typeof ref !== 'object' || typeof ref.fullId !== 'string' || ref.fullId.length === 0) {
		throw new Error(`Auth: ${what} must be an AppSetting reference (an \`AppSetting\` with \`secret: true\`).`);
	}
	// `parameterName` / `secret` are on the AppSetting CDK class only (the
	// public `AppSettingRef` type is the runtime surface), so read them untyped.
	const parameterName: unknown = Reflect.get(ref, 'parameterName');
	const secret: unknown = Reflect.get(ref, 'secret');
	if (typeof parameterName !== 'string' || parameterName.length === 0 || typeof secret !== 'boolean') {
		throw new Error(
			`Auth: ${what} ('${ref.fullId}') is not an AppSetting — it has no SSM parameter name. Pass an \`AppSetting\` created with \`secret: true\` (or \`AppSetting.fromExisting(scope, id, { name, secret: true })\`).`,
		);
	}
	if (!secret) {
		throw new Error(
			`Auth: ${what} ('${ref.fullId}', SSM parameter '${parameterName}') must be an AppSetting with \`secret: true\`. A provider secret must be an SSM SecureString, not a plaintext String.`,
		);
	}
	return parameterName;
}

function scopesFor(provider: keyof typeof SCOPES, id: string, scopes: readonly string[] | undefined): string {
	const rule = SCOPES[provider];
	const list = scopes ?? rule.defaults;
	if (list.length === 0) throw new Error(`Auth: provider '${id}' has an empty \`scopes\` list.`);
	for (const s of list) {
		if (typeof s !== 'string' || s.length === 0 || /[\s,]/.test(s)) {
			throw new Error(`Auth: provider '${id}' has an invalid scope ${JSON.stringify(s)} (no spaces or commas).`);
		}
	}
	return list.join(rule.join);
}

/**
 * Resolve `ProviderCommon.attributeMapping` over the provider's defaults (the
 * caller's entries win). Keys are pool attributes: a Cognito standard
 * attribute, a declared `users.attributes` name (prefixed `custom:` here), or
 * an explicit `custom:<name>` of a declared attribute.
 */
function attributeMappingFor(
	id: string,
	defaults: Readonly<Record<string, string>>,
	mapping: ProviderCommon['attributeMapping'],
	customAttributes: ReadonlySet<string>,
): Record<string, string> {
	const out: Record<string, string> = { ...defaults };
	for (const [key, claim] of Object.entries(mapping ?? {})) {
		if (IDENTITY_KEYS.has(key)) {
			throw new Error(
				`Auth: provider '${id}' maps '${key}' — identity attributes are not mappable. Identity comes from the provider's subject.`,
			);
		}
		if (typeof claim !== 'string' || claim.length === 0) {
			throw new Error(`Auth: provider '${id}' maps '${key}' to an empty claim name.`);
		}
		const bare = key.startsWith('custom:') ? key.slice('custom:'.length) : key;
		if (customAttributes.has(bare)) {
			out[`custom:${bare}`] = claim;
		} else if (!key.startsWith('custom:') && STANDARD_ATTRIBUTES.has(key)) {
			out[key] = claim;
		} else {
			throw new Error(
				`Auth: provider '${id}' maps '${key}', which is neither a Cognito standard attribute nor a declared \`users.attributes\` entry.`,
			);
		}
	}
	return out;
}

function requireNonEmpty(value: unknown, what: string): string {
	if (typeof value !== 'string' || value.trim().length === 0) throw new Error(`Auth: ${what} is required.`);
	return value;
}

function requireHttpsUrl(value: unknown, what: string): string {
	const s = requireNonEmpty(value, what);
	let url: URL;
	try {
		url = new URL(s);
	} catch {
		throw new Error(`Auth: ${what} must be an absolute https:// URL (got ${JSON.stringify(s)}).`);
	}
	if (url.protocol !== 'https:') throw new Error(`Auth: ${what} must use https:// (got ${JSON.stringify(s)}).`);
	return s;
}

function validateProviderName(kind: 'saml' | 'oidc', id: string): void {
	const record = kind === 'saml' ? 'samlProviders' : 'oidcProviders';
	if (id.length < 3 || id.length > 32 || !PROVIDER_NAME_PATTERN.test(id)) {
		throw new Error(
			`Auth: ${record} id '${id}' is not a valid Cognito provider name: 3–32 characters, no spaces, and no '_' at the start or after the second character.`,
		);
	}
	if (RESERVED_PROVIDER_NAMES.has(id.toLowerCase())) {
		throw new Error(`Auth: ${record} id '${id}' is reserved by Cognito. Choose another id.`);
	}
}

function socialRegistration(
	id: string,
	providerName: string,
	options: AuthOptions,
	customAttributes: ReadonlySet<string>,
): IdpRegistration {
	const social = options.socialProviders ?? {};
	switch (id) {
		case 'google':
		case 'facebook':
		case 'amazon': {
			const p = social[id];
			if (!p) throw new Error(`Auth: socialProviders.${id} is not set.`);
			return {
				id,
				kind: 'social',
				providerName,
				providerType: id === 'google' ? 'Google' : id === 'facebook' ? 'Facebook' : 'LoginWithAmazon',
				details: {
					client_id: requireNonEmpty(p.clientId, `socialProviders.${id}.clientId`),
					authorize_scopes: scopesFor(id, id, p.scopes),
				},
				secretDetails: {
					client_secret: secretParameterName(p.clientSecret, `socialProviders.${id}.clientSecret`),
				},
				attributeMapping: attributeMappingFor(id, DEFAULT_OIDC_MAPPING, p.attributeMapping, customAttributes),
			};
		}
		case 'apple': {
			// A real `SignInWithApple` provider: Services ID + team id + key id, and
			// the `.p8` key as the secret. (`AuthOIDC` synthesized Apple as `OIDC`
			// and dropped it when no issuer URL was set.)
			const p = social.apple;
			if (!p) throw new Error('Auth: socialProviders.apple is not set.');
			return {
				id,
				kind: 'social',
				providerName,
				providerType: 'SignInWithApple',
				details: {
					client_id: requireNonEmpty(p.clientId, 'socialProviders.apple.clientId (the Services ID)'),
					team_id: requireNonEmpty(p.teamId, 'socialProviders.apple.teamId'),
					key_id: requireNonEmpty(p.keyId, 'socialProviders.apple.keyId'),
					authorize_scopes: scopesFor('apple', id, p.scopes),
				},
				secretDetails: { private_key: secretParameterName(p.privateKey, 'socialProviders.apple.privateKey') },
				attributeMapping: attributeMappingFor(id, DEFAULT_OIDC_MAPPING, p.attributeMapping, customAttributes),
			};
		}
		default:
			throw new Error(
				`Auth: unknown socialProviders key '${id}'. Supported: google, facebook, amazon, apple. Use \`oidcProviders\` for any other OIDC IdP.`,
			);
	}
}

function samlRegistration(id: string, p: SamlProviderOptions, customAttributes: ReadonlySet<string>): IdpRegistration {
	validateProviderName('saml', id);
	const hasUrl = p.metadataUrl !== undefined;
	const hasFile = p.metadataFile !== undefined;
	if (hasUrl === hasFile) {
		throw new Error(`Auth: samlProviders.${id} needs exactly one of \`metadataUrl\` or \`metadataFile\`.`);
	}
	const details: Record<string, string> = hasUrl
		? { MetadataURL: requireHttpsUrl(p.metadataUrl, `samlProviders.${id}.metadataUrl`) }
		: { MetadataFile: requireNonEmpty(p.metadataFile, `samlProviders.${id}.metadataFile`) };
	details.IDPSignout = 'false';
	if (p.signRequest) details.RequestSigningAlgorithm = 'rsa-sha256';
	return {
		id,
		kind: 'saml',
		providerName: id,
		providerType: 'SAML',
		details,
		secretDetails: {},
		attributeMapping: attributeMappingFor(id, DEFAULT_SAML_MAPPING, p.attributeMapping, customAttributes),
	};
}

function cognitoOidcRegistration(
	id: string,
	p: CognitoOidcProviderOptions,
	customAttributes: ReadonlySet<string>,
): IdpRegistration {
	validateProviderName('oidc', id);
	const method = p.attributesRequestMethod ?? 'GET';
	if (method !== 'GET' && method !== 'POST') {
		throw new Error(`Auth: oidcProviders.${id}.attributesRequestMethod must be 'GET' or 'POST'.`);
	}
	if (!p.clientSecret) {
		throw new Error(
			`Auth: oidcProviders.${id} sets \`federateVia: 'cognito'\` but no \`clientSecret\`. Cognito is a confidential client and needs one; use \`federateVia: 'direct'\` for a PKCE-only IdP.`,
		);
	}
	const details: Record<string, string> = {
		client_id: requireNonEmpty(p.clientId, `oidcProviders.${id}.clientId`),
		authorize_scopes: scopesFor('oidc', id, p.scopes),
		oidc_issuer: requireHttpsUrl(p.issuer, `oidcProviders.${id}.issuer`),
		attributes_request_method: method,
	};
	if (p.endpoints) {
		details.authorize_url = requireHttpsUrl(
			p.endpoints.authorization,
			`oidcProviders.${id}.endpoints.authorization`,
		);
		details.token_url = requireHttpsUrl(p.endpoints.token, `oidcProviders.${id}.endpoints.token`);
		details.attributes_url = requireHttpsUrl(p.endpoints.userInfo, `oidcProviders.${id}.endpoints.userInfo`);
		details.jwks_uri = requireHttpsUrl(p.endpoints.jwks, `oidcProviders.${id}.endpoints.jwks`);
	}
	return {
		id,
		kind: 'oidc',
		providerName: id,
		providerType: 'OIDC',
		details,
		secretDetails: { client_secret: secretParameterName(p.clientSecret, `oidcProviders.${id}.clientSecret`) },
		attributeMapping: attributeMappingFor(id, DEFAULT_OIDC_MAPPING, p.attributeMapping, customAttributes),
	};
}

/**
 * The identity providers to register for `options`, in the order of
 * {@link cognitoFederatedProviders}. Throws at synth on an invalid provider
 * (missing credentials, an invalid Cognito provider name, both or neither SAML
 * metadata sources, an unmappable attribute, …).
 */
export function idpRegistrations(options: AuthOptions): IdpRegistration[] {
	const customAttributes = new Set((options.users?.attributes ?? []).map((a) => a.name));
	return cognitoFederatedProviders(options).map(({ id, kind, providerName }) => {
		if (kind === 'social') return socialRegistration(id, providerName, options, customAttributes);
		if (kind === 'saml') {
			const p = options.samlProviders?.[id];
			if (!p) throw new Error(`Auth: samlProviders.${id} is not set.`);
			return samlRegistration(id, p, customAttributes);
		}
		const p = options.oidcProviders?.[id];
		if (p?.federateVia !== 'cognito') throw new Error(`Auth: oidcProviders.${id} is not Cognito-federated.`);
		return cognitoOidcRegistration(id, p, customAttributes);
	});
}

/** Valid Cognito prefix domain: lowercase alphanumerics and hyphens, 1–63 chars, no leading/trailing hyphen. */
export const DOMAIN_PREFIX_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** Words Cognito rejects anywhere in a prefix domain. */
export const RESERVED_DOMAIN_WORDS: readonly string[] = ['aws', 'amazon', 'cognito'];

/** Throws unless `prefix` is a prefix Cognito accepts. */
export function validateDomainPrefix(prefix: unknown, what: string): string {
	if (typeof prefix !== 'string' || !DOMAIN_PREFIX_PATTERN.test(prefix)) {
		throw new Error(
			`Auth: ${what} ${JSON.stringify(prefix)} is not a valid Cognito domain prefix: 1–63 lowercase letters, digits and hyphens, not starting or ending with a hyphen.`,
		);
	}
	const reserved = RESERVED_DOMAIN_WORDS.find((w) => prefix.includes(w));
	if (reserved) throw new Error(`Auth: ${what} '${prefix}' contains '${reserved}', which Cognito reserves.`);
	return prefix;
}

/**
 * Federation-specific synth-time checks that do not depend on a single
 * provider: provider ids unique across the three records, redirect paths under
 * the auth subtree, and no hosted-UI federation on a wrapped (`userPool`) pool.
 */
export function validateFederationOptions(options: AuthOptions): void {
	const seen = new Map<string, string>();
	const records = [
		['socialProviders', options.socialProviders],
		['oidcProviders', options.oidcProviders],
		['samlProviders', options.samlProviders],
	] as const;
	for (const [record, value] of records) {
		for (const [id, entry] of Object.entries(value ?? {})) {
			if (!entry) continue;
			const other = seen.get(id);
			if (other) {
				throw new Error(
					`Auth: provider id '${id}' is configured in both \`${other}\` and \`${record}\`. Provider ids must be unique — they name the sign-in route and the \`signIn:<id>\` action.`,
				);
			}
			seen.set(id, record);
			if (id.includes('/')) throw new Error(`Auth: provider id '${id}' must not contain '/'.`);
		}
	}

	for (const key of ['callbackPath', 'signOutPath'] as const) {
		const path = options.redirects?.[key];
		if (path === undefined) continue;
		if (
			typeof path !== 'string' ||
			!path.startsWith(`${AUTH_ROUTE_PREFIX}/`) ||
			path.length === `${AUTH_ROUTE_PREFIX}/`.length ||
			/[*?#\s]/.test(path)
		) {
			throw new Error(
				`Auth: redirects.${key} must be an explicit path under '${AUTH_ROUTE_PREFIX}/' (no wildcard, query or fragment); got ${JSON.stringify(path)}.`,
			);
		}
	}

	if (options.userPool && cognitoFederatedProviders(options).length > 0) {
		throw new Error(
			"Auth: social, SAML and `federateVia: 'cognito'` providers cannot be combined with `userPool` (an existing pool) — `Auth` would have to create a domain and identity providers on a pool it does not own. Configure federation on that pool yourself, or let `Auth` create the pool.",
		);
	}
}
