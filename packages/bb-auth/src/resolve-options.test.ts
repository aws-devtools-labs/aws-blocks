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

	it('rejects a second entry of one social type (its key cannot also be the type)', () => {
		assert.throws(
			() =>
				resolveOptions({
					providers: {
						google: { type: 'google', clientId: 'g1', clientSecret: secret },
						work: { type: 'google', clientId: 'g2', clientSecret: secret },
					},
				}),
			/providers\.work has `type: 'google'`, so its key must be `google`/,
		);
	});

	it('rejects the blocks-only provider types (backstop for untyped callers)', () => {
		for (const entry of [stubIdp(), github({ clientId: 'x', clientSecret: secret })]) {
			const options: unknown = { providers: { p: entry } };
			assert.throws(
				() => resolveOptions(options as AuthOptions),
				/providers\.p has `type: '(stub|oauth2)'`.*store: 'builtin'/,
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

describe('resolveOptions — store: builtin', () => {
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
			store: 'builtin',
			providers: {
				'okta-dev': { type: 'oidc', issuer, clientId: 'c', groupsClaim: 'groups' },
				github: gh,
				acme: custom,
				local: stub,
			},
			users: { groups: ['admin'] },
			allowBearerAuth: true,
		});
		assert.equal(resolved.store, 'builtin');
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
			const options: unknown = { store: 'builtin', providers: { p: { type, clientId: 'x' } } };
			assert.throws(
				() => resolveOptions(options as AuthOptions),
				new RegExp(`providers\\.p has \`type: '${type}'\`, which needs \`store: 'cognito'\``),
			);
		}
	});

	it('an unknown type is not a provider type, not a store mismatch', () => {
		for (const type of ['github', 'okta']) {
			const options: unknown = { store: 'builtin', providers: { p: { type, clientId: 'x' } } };
			assert.throws(
				() => resolveOptions(options as AuthOptions),
				(e: Error) => {
					assert.match(
						e.message,
						new RegExp(`providers\\.p has \`type: '${type}'\`, which is not a provider type`),
					);
					assert.match(e.message, /`github\(\)`.*`customOauth2\(\)`.*`type: 'oidc'`/);
					assert.doesNotMatch(e.message, /needs `store: 'cognito'`/);
					return true;
				},
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

describe('resolveOptions — backstops for untyped callers', () => {
	it('rejects an unknown store', () => {
		const options: unknown = { store: 'cognit0' };
		assert.throws(
			() => resolveOptions(options as AuthOptions),
			/`store` must be 'cognito' \(the default\) or 'builtin', got the string "cognit0"/,
		);
	});

	it('never echoes a long string as the store or a provider type (it may be a misplaced secret)', () => {
		const token = 'misplaced-token-'.padEnd(40, '0');
		const cases: [unknown, RegExp][] = [
			[{ store: token }, /got a string \(40 characters\)\.$/],
			[
				{ store: 'builtin', providers: { p: { type: token, clientId: 'c' } } },
				/providers\.p has `type` set to a string \(40 characters\), which is not a provider type/,
			],
			[
				{ providers: { p: { type: token, issuer, clientId: 'c', clientSecret: secret } } },
				/providers\.p has `type` set to a string \(40 characters\), which is not a provider type/,
			],
		];
		for (const [options, expected] of cases) {
			assert.throws(
				() => resolveOptions(options as AuthOptions),
				(e: Error) => {
					assert.match(e.message, expected);
					assert.ok(!e.message.includes(token), e.message);
					return true;
				},
			);
		}
	});

	it('rejects the replaced provider maps on either store, even next to providers', () => {
		for (const options of [
			{ emailPassword: false, oidcProviders: {} },
			{ providers: {}, socialProviders: {}, samlProviders: {} },
			{ store: 'builtin', providers: { local: stubIdp() }, oidcProviders: {} },
		]) {
			const untyped: unknown = options;
			assert.throws(() => resolveOptions(untyped as AuthOptions), /replaced by `providers`/);
		}
	});

	it('rejects options only a user pool gives meaning to on store: builtin', () => {
		for (const [key, value] of [
			['userPool', { __brand: 'ExternalUserPoolRef', userPoolId: 'us-east-1_x' }],
			['admin', {}],
			['mfa', 'required'],
			['passkeys', { relyingPartyId: 'example.com', origins: [] }],
			['emailPassword', true],
			['emailPassword', {}],
			['codeDelivery', async () => {}],
			['hostedUi', { domainPrefix: 'x' }],
			['featurePlan', 'essentials'],
			['email', { fromAddress: 'a@example.com' }],
			['totpVerification', 'rfc6238'],
		] as const) {
			const options: unknown = { store: 'builtin', providers: { local: stubIdp() }, [key]: value };
			assert.throws(
				() => resolveOptions(options as AuthOptions),
				new RegExp(
					`\`${key}\` needs \`store: 'cognito'\` \\(the default\\): a \`store: 'builtin'\` block has no user pool`,
				),
				key,
			);
		}
		const users: unknown = {
			store: 'builtin',
			providers: { local: stubIdp() },
			users: { groups: [], attributes: [] },
		};
		assert.throws(() => resolveOptions(users as AuthOptions), /`users\.attributes` needs `store: 'cognito'`/);
	});

	it('names every user-pool option of a store: builtin block in one message, in option order', () => {
		const options: unknown = {
			store: 'builtin',
			providers: { local: stubIdp() },
			admin: {},
			mfa: 'required',
			users: { groups: ['admin'], signInWith: ['email'] },
		};
		assert.throws(() => resolveOptions(options as AuthOptions, 'sso'), {
			message:
				"Auth 'sso': `mfa`, `admin`, `users.signInWith` need `store: 'cognito'` (the default): " +
				"a `store: 'builtin'` block has no user pool. Remove it, or drop `store: 'builtin'`.",
		});
	});

	it('ignores a users key set to undefined on store: builtin, and does not crash on a non-object users', () => {
		const options: unknown = {
			store: 'builtin',
			providers: { local: stubIdp() },
			users: { groups: ['a'], signInWith: undefined, attributes: undefined },
		};
		assert.deepEqual(resolveOptions(options as AuthOptions).users, { groups: ['a'] });
		const text: unknown = { store: 'builtin', providers: { local: stubIdp() }, users: 'x' };
		assert.doesNotThrow(() => resolveOptions(text as AuthOptions));
	});

	it('reads own keys only, as the option validation does: an inherited store is not the store', () => {
		const inherited: unknown = Object.assign(Object.create({ store: 'builtin' }), { mfa: 'optional' });
		const resolved = resolveOptions(inherited as AuthOptions);
		assert.equal(resolved.store, 'cognito');
		assert.equal(resolved.mfa, 'optional');
	});

	it('quotes a provider id that is not an identifier, as the option validation does', () => {
		const cases: [unknown, RegExp][] = [
			[
				{ providers: { 'my-gmail': { type: 'google', clientId: 'g', clientSecret: secret } } },
				/Auth: providers\["my-gmail"\] has `type: 'google'`, so its key must be `google`/,
			],
			[
				{ store: 'builtin', providers: { 'my-idp': { type: 'saml', metadataUrl: 'https://p' } } },
				/Auth: providers\["my-idp"\] has `type: 'saml'`, which needs/,
			],
			[{ providers: { 'my-idp': { type: 'odic', issuer } } }, /Auth: providers\["my-idp"\] has `type: 'odic'`/],
		];
		for (const [options, expected] of cases) assert.throws(() => resolveOptions(options as AuthOptions), expected);
	});

	it('an unknown, missing or non-string type on the default store is not a provider type', () => {
		for (const [type, shown] of [
			['odic', "`type: 'odic'`"],
			[undefined, 'no `type`'],
			[1, '`type: 1`'],
			[Object.create(null), 'a `type` that is not a string'],
		] as const) {
			const options: unknown = { providers: { p: { type, issuer, clientId: 'c', clientSecret: secret } } };
			assert.throws(
				() => resolveOptions(options as AuthOptions),
				(e: Error) => {
					assert.ok(
						e.message.startsWith(`Auth: providers.p has ${shown}, which is not a provider type.`),
						e.message,
					);
					assert.doesNotMatch(e.message, /cannot federate/);
					return true;
				},
				shown,
			);
		}
		const builtin: unknown = { store: 'builtin', providers: { p: { type: 1, issuer, clientId: 'c' } } };
		assert.throws(
			() => resolveOptions(builtin as AuthOptions),
			/providers\.p has `type: 1`, which is not a provider type/,
		);
	});

	it('emailPassword: false on the default store needs a provider or a wrapped pool (no way to sign in otherwise)', () => {
		for (const options of [{ emailPassword: false }, { emailPassword: false, providers: { google: undefined } }]) {
			assert.throws(() => resolveOptions(options as AuthOptions, 'auth'), {
				message:
					"Auth 'auth': `emailPassword: false` with no `providers` leaves no way to sign in. Configure a provider or re-enable email + password.",
			});
		}
		const okta = { type: 'oidc', issuer, clientId: 'c', clientSecret: secret } as const;
		assert.doesNotThrow(() => resolveOptions({ emailPassword: false, providers: { okta } }));
		const wrapped: unknown = {
			emailPassword: false,
			userPool: { __brand: 'ExternalUserPoolRef', userPoolId: 'us-east-1_x' },
		};
		assert.doesNotThrow(() => resolveOptions(wrapped as AuthOptions));
		assert.doesNotThrow(() => resolveOptions({}));
	});

	it('keeps only users.groups on store: builtin', () => {
		const resolved = resolveOptions({
			store: 'builtin',
			providers: { local: stubIdp() },
			users: { groups: ['a'] },
		});
		assert.deepEqual(resolved.users, { groups: ['a'] });
		assert.equal('users' in resolveOptions({ store: 'builtin', providers: { local: stubIdp() } }), false);
	});

	it('a store: builtin block with providers omitted, or only undefined entries, has no provider', () => {
		for (const providers of [undefined, { local: undefined }]) {
			const options: unknown = { store: 'builtin', providers };
			assert.throws(
				() => resolveOptions(options as AuthOptions),
				/`store: 'builtin'` needs at least one provider/,
				JSON.stringify(providers),
			);
		}
		const mixed: unknown = { store: 'builtin', providers: { gone: undefined, local: stubIdp() } };
		assert.deepEqual(Object.keys(resolveOptions(mixed as AuthOptions).oidcProviders ?? {}), ['local']);
	});

	it('an entry with no type on store: builtin is not a provider type', () => {
		const options: unknown = { store: 'builtin', providers: { okta: { issuer, clientId: 'c' } } };
		assert.throws(
			() => resolveOptions(options as AuthOptions),
			/providers\.okta has no `type`, which is not a provider type/,
		);
	});

	it('accepts emailPassword: false on store: builtin (what the block is anyway)', () => {
		const resolved = resolveOptions({ store: 'builtin', providers: { local: stubIdp() }, emailPassword: false });
		assert.equal(resolved.emailPassword, false);
	});

	it('rejects a store: builtin block with no provider', () => {
		assert.throws(
			() => resolveOptions({ store: 'builtin', providers: {} }),
			/`store: 'builtin'` needs at least one provider/,
		);
	});

	it("prefixes every error with the block id when given (as the option validation does), else 'Auth:'", () => {
		assert.throws(() => resolveOptions({ store: 'builtin', providers: {} }, 'sso'), {
			message: /^Auth 'sso': `store: 'builtin'` needs/,
		});
		const untyped: unknown = { store: 'cognit0' };
		assert.throws(() => resolveOptions(untyped as AuthOptions, 'auth'), {
			message: /^Auth 'auth': `store` must be/,
		});
		assert.throws(() => resolveOptions(untyped as AuthOptions), { message: /^Auth: `store` must be/ });
	});

	it("a leftover federateVia on an entry is replaced by the store's (cognito)", () => {
		const options: unknown = {
			providers: { okta: { type: 'oidc', issuer, clientId: 'c', clientSecret: secret, federateVia: 'direct' } },
		};
		assert.equal(resolveOptions(options as AuthOptions).oidcProviders?.okta?.federateVia, 'cognito');
	});
});
