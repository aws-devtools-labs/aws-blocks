// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * `resolveOptions()`: the public `store` + `providers` options → the internal
 * per-family maps every layer reads. Keys must pass through unchanged (they
 * drive construct ids and Cognito provider names), and `federateVia` follows
 * the store.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { customOauth2, github, stubIdp } from './providers.js';
import { resolveOptions } from './resolve-options.js';
import type { AuthOptions, ProviderSecretRef } from './types.js';

const secret: ProviderSecretRef = { fullId: 'app/secret', get: async () => 'value' };
const issuer = 'https://idp.example.com';

describe('resolveOptions — store omitted / cognito', () => {
	it('treats an omitted store as cognito and keeps every other option', () => {
		const resolved = resolveOptions({ emailPassword: { selfSignUp: false }, mfa: 'optional', admin: {} });
		assert.equal(resolved.store, 'cognito');
		assert.deepEqual(resolved.emailPassword, { selfSignUp: false });
		assert.equal(resolved.mfa, 'optional');
		assert.deepEqual(resolved.admin, {});
		assert.equal(resolved.socialProviders, undefined);
		assert.equal(resolved.oidcProviders, undefined);
		assert.equal(resolved.samlProviders, undefined);
		assert.equal('providers' in resolved, false);
		assert.deepEqual(resolveOptions({}), { store: 'cognito' });
	});

	it('maps each social type to its fixed key, without the type tag', () => {
		const resolved = resolveOptions({
			store: 'cognito',
			providers: {
				google: { type: 'google', clientId: 'g', clientSecret: secret, label: 'Google' },
				facebook: { type: 'facebook', clientId: 'f', clientSecret: secret },
				amazon: { type: 'amazon', clientId: 'a', clientSecret: secret, scopes: ['profile'] },
				apple: { type: 'apple', clientId: 'svc', teamId: 't', keyId: 'k', privateKey: secret },
			},
		});
		assert.deepEqual(resolved.socialProviders, {
			google: { clientId: 'g', clientSecret: secret, label: 'Google' },
			facebook: { clientId: 'f', clientSecret: secret },
			amazon: { clientId: 'a', clientSecret: secret, scopes: ['profile'] },
			apple: { clientId: 'svc', teamId: 't', keyId: 'k', privateKey: secret },
		});
		assert.equal(resolved.oidcProviders, undefined);
		assert.equal(resolved.samlProviders, undefined);
	});

	it('passes SAML and OIDC keys through unchanged; OIDC federates via cognito', () => {
		const resolved = resolveOptions({
			providers: {
				'corp-saml': { type: 'saml', metadataUrl: 'https://idp.example.com/metadata', signRequest: true },
				Okta_1: { type: 'oidc', issuer, clientId: 'c', clientSecret: secret, attributesRequestMethod: 'POST' },
			},
		});
		assert.deepEqual(resolved.samlProviders, {
			'corp-saml': { metadataUrl: 'https://idp.example.com/metadata', signRequest: true },
		});
		assert.deepEqual(resolved.oidcProviders, {
			Okta_1: {
				issuer,
				clientId: 'c',
				clientSecret: secret,
				attributesRequestMethod: 'POST',
				federateVia: 'cognito',
			},
		});
		assert.equal(resolved.socialProviders, undefined);
	});

	it('keeps a social key that equals its type (the construct-id-stable case)', () => {
		const resolved = resolveOptions({
			providers: { google: { type: 'google', clientId: 'g', clientSecret: secret } },
		});
		assert.deepEqual(Object.keys(resolved.socialProviders ?? {}), ['google']);
	});

	it('rejects a social entry keyed differently from its type', () => {
		assert.throws(
			() => resolveOptions({ providers: { gmail: { type: 'google', clientId: 'g', clientSecret: secret } } }),
			/providers\.gmail has `type: 'google'`, so its key must be `google`/,
		);
	});

	it('rejects two entries with the same social type', () => {
		assert.throws(
			() =>
				resolveOptions({
					providers: {
						google: { type: 'google', clientId: 'g1', clientSecret: secret },
						work: { type: 'google', clientId: 'g2', clientSecret: secret },
					},
				}),
			/providers\.google and providers\.work all have `type: 'google'`/,
		);
	});

	it('rejects the blocks-only provider types (backstop for untyped callers)', () => {
		for (const entry of [stubIdp(), github({ clientId: 'x', clientSecret: secret })]) {
			const options: unknown = { providers: { p: entry } };
			assert.throws(
				() => resolveOptions(options as AuthOptions),
				/providers\.p has `type: '(stub|oauth2)'`.*store: 'blocks'/,
			);
		}
		const untyped: unknown = { providers: { p: { issuer, clientId: 'c' } } };
		assert.throws(() => resolveOptions(untyped as AuthOptions), /providers\.p has no `type`/);
	});

	it('skips an undefined entry', () => {
		const options: unknown = { providers: { google: undefined } };
		assert.equal(resolveOptions(options as AuthOptions).socialProviders, undefined);
	});
});

describe('resolveOptions — store: blocks', () => {
	it('puts every provider in oidcProviders with federateVia direct, keys unchanged, and disables email + password', () => {
		const gh = github({ clientId: 'gh', clientSecret: secret });
		const custom = customOauth2({
			name: 'acme',
			clientId: 'acme',
			endpoints: { authorization: 'https://a/authorize', token: 'https://a/token', userInfo: 'https://a/me' },
			scopes: ['read'],
			mapClaims: () => ({ providerSub: '1', email: null, name: null }),
		});
		const stub = stubIdp({ users: [{ sub: 'u1', email: 'a@example.com', name: 'A' }] });
		const resolved = resolveOptions({
			store: 'blocks',
			providers: {
				'okta-dev': { type: 'oidc', issuer, clientId: 'c', groupsClaim: 'groups' },
				github: gh,
				acme: custom,
				local: stub,
			},
			users: { groups: ['admin'] },
			allowBearerAuth: true,
		});
		assert.equal(resolved.store, 'blocks');
		assert.equal(resolved.emailPassword, false);
		assert.deepEqual(resolved.users, { groups: ['admin'] });
		assert.equal(resolved.allowBearerAuth, true);
		assert.equal(resolved.socialProviders, undefined);
		assert.equal(resolved.samlProviders, undefined);
		const oidc = resolved.oidcProviders ?? {};
		assert.deepEqual(Object.keys(oidc), ['okta-dev', 'github', 'acme', 'local']);
		assert.deepEqual(oidc['okta-dev'], { issuer, clientId: 'c', groupsClaim: 'groups', federateVia: 'direct' });
		for (const [id, source] of [
			['github', gh],
			['acme', custom],
			['local', stub],
		] as const) {
			const { type: _type, ...untagged } = source;
			assert.deepEqual(oidc[id], { ...untagged, federateVia: 'direct' }, id);
			assert.equal('type' in oidc[id], false, id);
		}
	});

	it('rejects the cognito-only provider types (backstop for untyped callers)', () => {
		for (const type of ['google', 'saml']) {
			const options: unknown = { store: 'blocks', providers: { p: { type, clientId: 'x' } } };
			assert.throws(
				() => resolveOptions(options as AuthOptions),
				new RegExp(`providers\\.p has \`type: '${type}'\`, which needs \`store: 'cognito'\``),
			);
		}
	});
});

describe('provider helpers set type', () => {
	it('stubIdp() is a stub, github() and customOauth2() are oauth2', () => {
		assert.equal(stubIdp().type, 'stub');
		assert.equal(github({ clientId: 'x', clientSecret: secret }).type, 'oauth2');
		assert.equal(
			customOauth2({
				name: 'n',
				clientId: 'c',
				endpoints: { authorization: 'https://a', token: 'https://t', userInfo: 'https://u' },
				scopes: [],
				mapClaims: () => ({ providerSub: '1', email: null, name: null }),
			}).type,
			'oauth2',
		);
	});
});
