// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Unknown and misplaced `Auth` options are rejected at construction (D1b).
 *
 * TypeScript does no excess-property check on the inferred `Auth<const O>`
 * options literal, so without this a typo (`emailPasword`) or a misplaced
 * option (top-level `preferredChallenge`) compiled and was silently ignored.
 *
 * The drift guard — the validator's known keys can't diverge from `types.ts` —
 * is compile-time: every shape node in `option-validation.ts` is declared
 * `satisfies ShapeOf<…>` against its interface, so the package build fails when
 * `types.ts` gains or loses an option without the validator being updated, or
 * when an options group is declared `'value'` instead of being walked.
 * `types-test.ts` case 18 pins the top-level key set explicitly as well.
 *
 * A provider entry's keys also depend on the block's `store`: a key the same
 * `type` accepts on the other store is a store conflict naming the store it
 * needs. A `type` the store does not accept is `resolveOptions()`'s to reject.
 */

import assert from 'node:assert';
import { rmSync } from 'node:fs';
import { afterEach, describe, test } from 'node:test';
import { AppSetting } from '@aws-blocks/bb-app-setting';
import { Logger } from '@aws-blocks/bb-logger';
import type { ScopeParent } from '@aws-blocks/core';
import * as cdk from 'aws-cdk-lib';
import { Auth as AwsAuth } from './index.aws.js';
import { Auth as CdkAuth } from './index.cdk.js';
import { Auth, customOauth2, github, relayOrigin, stubIdp } from './index.mock.js';
import {
	assertKnownAuthOptions,
	findInvalidAuthOptions,
	findPasswordOnlyOptions,
	findStoreConflicts,
	findUnknownAuthOptions,
} from './option-validation.js';
import type { AppSettingRef, AuthMockOptions } from './types.js';

afterEach(() => rmSync('.bb-data', { recursive: true, force: true }));

let n = 0;
const root = (): ScopeParent => ({ id: `optval${process.pid}x${++n}` });
const secret: AppSettingRef = { fullId: 'provider-secret', get: async () => 's3cret' };

/** Options as an untyped JavaScript caller passes them (test plumbing). */
function untyped(options: unknown): AuthMockOptions {
	return options as AuthMockOptions;
}

/** The `[path, hint]` pairs the validator reports for `options`. */
function issues(options: Record<string, unknown>): [string, string | undefined][] {
	return findUnknownAuthOptions(options).map((u) => [u.path, u.hint]);
}

/** The single issue for `options`. */
function only(options: Record<string, unknown>): [string, string | undefined] {
	const found = issues(options);
	assert.strictEqual(found.length, 1, JSON.stringify(found));
	return found[0];
}

describe('unknown options — top level', () => {
	test('a typo is reported with the intended option', () => {
		assert.deepStrictEqual(only({ emailPasword: false }), ['emailPasword', 'did you mean `emailPassword`?']);
		assert.deepStrictEqual(only({ allowBearerAuthentication: true })[0], 'allowBearerAuthentication');
		assert.deepStrictEqual(only({ featureplan: 'lite' }), ['featureplan', 'did you mean `featurePlan`?']);
		assert.deepStrictEqual(only({ onSignin: async () => {} }), ['onSignin', 'did you mean `onSignIn`?']);
	});

	test('a key with no close match is reported without a suggestion', () => {
		assert.deepStrictEqual(only({ zzzzzzzz: 1 }), ['zzzzzzzz', undefined]);
		assert.throws(() => assertKnownAuthOptions('auth', { zzzzzzzz: 1 }), /unknown option:\n {2}- `zzzzzzzz`\n/);
	});

	test('a removed provider map is unknown, and the hint names what replaced it', () => {
		assert.deepStrictEqual(only({ socialProviders: { github: { clientId: 'g', clientSecret: secret } } }), [
			'socialProviders',
			"replaced by `providers`: move each entry there, keyed as before, with its `type` (`'google'`, `'facebook'`, `'amazon'`, `'apple'`).",
		]);
		assert.deepStrictEqual(only({ oidcProviders: { okta: { issuer: 'https://o', clientId: 'c' } } }), [
			'oidcProviders',
			"replaced by `providers`: move each entry there, keyed as before, with `type: 'oidc'`. A directly federated provider, `github()`, `customOauth2()` and `stubIdp()` go in a block with `store: 'builtin'`.",
		]);
		assert.deepStrictEqual(only({ samlProviders: { partner: { metadataUrl: 'https://p' } } }), [
			'samlProviders',
			"replaced by `providers`: move each entry there, keyed as before, with `type: 'saml'`.",
		]);
	});

	test("a provider's leftover federateVia is unknown, and the hint names the store", () => {
		const okta = { type: 'oidc', issuer: 'https://o', clientId: 'c', clientSecret: secret };
		for (const [store, federateVia] of [
			[undefined, 'cognito'],
			['builtin', 'direct'],
		]) {
			assert.deepStrictEqual(only({ store, providers: { okta: { ...okta, federateVia } } }), [
				'providers.okta.federateVia',
				"replaced by the block's `store`: remove it. `'cognito'` (the default) federates through Cognito; `store: 'builtin'` federates directly.",
			]);
		}
	});

	test('every unknown key is reported, in order', () => {
		assert.deepStrictEqual(
			issues({ emailPasword: false, users: { groupz: [] }, sesion: {} }).map(([p]) => p),
			['emailPasword', 'users.groupz', 'sesion'],
		);
	});

	test('a key set to undefined is still reported (it is still a typo)', () => {
		assert.deepStrictEqual(only({ emailPasword: undefined })[0], 'emailPasword');
	});
});

describe('misplaced options', () => {
	test('top-level preferredChallenge points at users.preferredChallenge', () => {
		assert.deepStrictEqual(only({ preferredChallenge: 'EMAIL_OTP' }), [
			'preferredChallenge',
			'it is not an option here; did you mean `users.preferredChallenge`?',
		]);
	});

	test('other options one level too high or too low', () => {
		assert.match(only({ groups: ['admins'] })[1] ?? '', /`users\.groups`/);
		assert.match(only({ ttlSeconds: 60 })[1] ?? '', /`session\.ttlSeconds`/);
		assert.match(only({ selfSignUp: false })[1] ?? '', /`emailPassword\.selfSignUp`/);
		assert.match(only({ relyingPartyId: 'example.com' })[1] ?? '', /`passkeys\.relyingPartyId`/);
		assert.match(only({ emailPassword: { mfa: 'required' } })[1] ?? '', /did you mean `mfa`\?/);
		assert.match(only({ users: { session: {} } })[1] ?? '', /did you mean `session`\?/);
	});

	test('misplaced and misspelled points at the closest option elsewhere', () => {
		assert.match(only({ preferedChallenge: 'EMAIL_OTP' })[1] ?? '', /did you mean `users\.preferredChallenge`\?/);
	});

	test('a key valid in many places lists a few of them', () => {
		const [, hint] = only({ name: 'x' });
		assert.match(
			hint ?? '',
			/^it is not an option here; did you mean one of `[^`]+\.name`, `[^`]+\.name`, `[^`]+\.name`\?$/,
		);
		assert.match(only({ scopes: ['openid'] })[1] ?? '', /did you mean `providers\.<id>\.scopes`\?/);
	});
});

describe('nested typos rank the keys under the same parent first', () => {
	const cases: [Record<string, unknown>, string, string][] = [
		// Each typo is also an exact key somewhere else; the sibling is the one meant.
		[{ mfa: { mode: 'optional', type: ['TOTP'] } }, 'mfa.type', 'did you mean `mfa.types`?'],
		[
			{ users: { attributes: [{ name: 'plan', types: 'string' }] } },
			'users.attributes[0].types',
			'did you mean `users.attributes[0].type`?',
		],
		[
			{ allowBearerAuth: { clientId: ['c'] } },
			'allowBearerAuth.clientId',
			'did you mean `allowBearerAuth.clientIds`?',
		],
		[
			{ providers: { google: { type: 'google', clientIds: 'g', clientSecret: secret } } },
			'providers.google.clientIds',
			'did you mean `providers.google.clientId`?',
		],
	];
	for (const [options, path, hint] of cases) {
		test(`${path} → ${hint}`, () => {
			assert.deepStrictEqual(only(options), [path, hint]);
		});
	}

	test('with no close sibling, a misplaced key still points where it belongs', () => {
		assert.deepStrictEqual(only({ mfa: { mode: 'optional', groups: ['admins'] } }), [
			'mfa.groups',
			'it is not an option here; did you mean `users.groups`?',
		]);
	});
});

describe('unknown options — nested groups', () => {
	const cases: [string, Record<string, unknown>, string, RegExp][] = [
		[
			'emailPassword',
			{ emailPassword: { selfSignup: false } },
			'emailPassword.selfSignup',
			/emailPassword\.selfSignUp/,
		],
		[
			'emailPassword.passwordPolicy',
			{ emailPassword: { passwordPolicy: { minLenght: 12 } } },
			'emailPassword.passwordPolicy.minLenght',
			/emailPassword\.passwordPolicy\.minLength/,
		],
		[
			'users',
			{ users: { preferedChallenge: 'EMAIL_OTP' } },
			'users.preferedChallenge',
			/users\.preferredChallenge/,
		],
		[
			'users.deviceTracking',
			{ users: { deviceTracking: { challengeRequiredOnNewDevise: true } } },
			'users.deviceTracking.challengeRequiredOnNewDevise',
			/users\.deviceTracking\.challengeRequiredOnNewDevice/,
		],
		[
			'users.attributes[]',
			{ users: { attributes: [{ name: 'a' }, { name: 'b', mutabel: false }] } },
			'users.attributes[1].mutabel',
			/users\.attributes\[1\]\.mutable/,
		],
		[
			'users.groups[]',
			{ users: { groups: ['admins', { name: 'readers', precidence: 1 }] } },
			'users.groups[1].precidence',
			/users\.groups\[1\]\.precedence/,
		],
		['session', { session: { ttlSecond: 60 } }, 'session.ttlSecond', /session\.ttlSeconds/],
		['redirects', { redirects: { callbackPth: '/x' } }, 'redirects.callbackPth', /redirects\.callbackPath/],
		['mfa', { mfa: { mdoe: 'required' } }, 'mfa.mdoe', /mfa\.mode/],
		['passkeys', { passkeys: { relyingPartId: 'x' } }, 'passkeys.relyingPartId', /passkeys\.relyingPartyId/],
		['admin', { admin: { action: ['groups'] } }, 'admin.action', /admin\.actions/],
		['hostedUi', { hostedUi: { domainPrefx: 'x' } }, 'hostedUi.domainPrefx', /hostedUi\.domainPrefix/],
		['email', { email: { fromAdress: 'no-reply@example.com' } }, 'email.fromAdress', /email\.fromAddress/],
		[
			"providers (type: 'google')",
			{ providers: { google: { type: 'google', clientId: 'g', clientSecrt: secret } } },
			'providers.google.clientSecrt',
			/providers\.google\.clientSecret/,
		],
		[
			"providers (type: 'apple')",
			{ providers: { apple: { type: 'apple', clientId: 'a', teamID: 't', keyId: 'k', privateKey: secret } } },
			'providers.apple.teamID',
			/providers\.apple\.teamId/,
		],
	];
	for (const [group, options, path, hint] of cases) {
		test(group, () => {
			const [foundPath, foundHint] = only(options);
			assert.strictEqual(foundPath, path);
			assert.match(foundHint ?? '', hint);
		});
	}
});

describe('provider records — values are checked, user-chosen ids are not', () => {
	test('any provider id is accepted', () => {
		assert.deepStrictEqual(
			issues({
				providers: {
					'my-corp_IdP.1': {
						type: 'oidc',
						issuer: 'https://idp.example.com',
						clientId: 'c',
						clientSecret: secret,
					},
					emailPasword: { type: 'saml', metadataUrl: 'https://p.example.com/saml' },
				},
			}),
			[],
		);
		assert.deepStrictEqual(
			issues({
				store: 'builtin',
				providers: { 'my-corp_IdP.1': { type: 'oidc', issuer: 'https://idp.example.com', clientId: 'c' } },
			}),
			[],
		);
	});

	test('an unknown key inside an OIDC provider entry', () => {
		assert.deepStrictEqual(
			only({
				store: 'builtin',
				providers: { okta: { type: 'oidc', issuer: 'https://o', clientId: 'c', clientSecrt: secret } },
			}),
			['providers.okta.clientSecrt', 'did you mean `providers.okta.clientSecret`?'],
		);
		assert.deepStrictEqual(
			only({
				store: 'builtin',
				providers: {
					okta: { type: 'oidc', issuer: 'https://o', clientId: 'c', endpoints: { jwk: 'https://o/jwks' } },
				},
			})[0],
			'providers.okta.endpoints.jwk',
		);
	});

	test('stubIdp.unsafeAllowDeployed is not an option: a stub is local and sandbox only', () => {
		assert.strictEqual(
			only({
				store: 'builtin',
				providers: { corp: { ...stubIdp(), stubIdp: { unsafeAllowDeployed: true } } },
			})[0],
			'providers.corp.stubIdp.unsafeAllowDeployed',
		);
	});

	test('a provider id that is not an identifier is quoted in the path', () => {
		assert.strictEqual(
			only({
				store: 'builtin',
				providers: { 'google-extras': { type: 'oidc', issuer: 'i', clientId: 'c', lable: 'x' } },
			})[0],
			'providers["google-extras"].lable',
		);
	});

	test('an unknown key inside a SAML provider entry', () => {
		assert.deepStrictEqual(only({ providers: { partner: { type: 'saml', metadataURL: 'https://p' } } }), [
			'providers.partner.metadataURL',
			'did you mean `providers.partner.metadataUrl`?',
		]);
	});

	test('a key another provider type accepts names the type it is not accepted on', () => {
		assert.deepStrictEqual(
			only({
				store: 'builtin',
				providers: { okta: { type: 'oidc', issuer: 'https://o', clientId: 'c', metadataUrl: 'https://m' } },
			}),
			['providers.okta.metadataUrl', "`metadataUrl` is not accepted on a `type: 'oidc'` provider"],
		);
		assert.deepStrictEqual(
			only({ providers: { partner: { type: 'saml', metadataUrl: 'https://m', clientId: 'c' } } }),
			['providers.partner.clientId', "`clientId` is not accepted on a `type: 'saml'` provider"],
		);
		assert.deepStrictEqual(only({ store: 'builtin', providers: { corp: { ...stubIdp(), oauth2: {} } } }), [
			'providers.corp.oauth2',
			"`oauth2` is not accepted on a `type: 'stub'` provider",
		]);
	});

	test('factory-built providers and their nested settings', () => {
		const users = [{ sub: 'u-1', email: 'a@example.com', name: 'A', extra: { groups: ['admin'], anything: 1 } }];
		assert.deepStrictEqual(
			issues({ store: 'builtin', providers: { corp: stubIdp({ users, onAuthorize: () => undefined }) } }),
			[],
		);
		assert.deepStrictEqual(
			only({
				store: 'builtin',
				providers: {
					corp: { ...stubIdp(), stubIdp: { users: [{ sub: 's', email: 'e', name: 'n', emial: 'x' }] } },
				},
			})[0],
			'providers.corp.stubIdp.users[0].emial',
		);
		const gh = github({ clientId: 'Iv1', clientSecret: secret });
		assert.deepStrictEqual(issues({ store: 'builtin', providers: { github: gh } }), []);
		assert.deepStrictEqual(
			only({
				store: 'builtin',
				providers: {
					github: { ...gh, oauth2: { ...gh.oauth2, endpoints: { ...gh.oauth2.endpoints, userinfo: 'x' } } },
				},
			}),
			[
				'providers.github.oauth2.endpoints.userinfo',
				'did you mean `providers.github.oauth2.endpoints.userInfo`?',
			],
		);
	});
});

/** The `[path, message]` pairs the validator reports as store conflicts in `options`. */
function conflicts(options: Record<string, unknown>): [string, string][] {
	return findStoreConflicts(options).map((c) => [c.path, c.message]);
}

describe('the store selects which provider options apply', () => {
	const okta = { type: 'oidc', issuer: 'https://o', clientId: 'c' };
	const needsBuiltin =
		"needs `store: 'builtin'` (a directly federated provider). Remove it, or move the provider to a `store: 'builtin'` block.";
	const needsCognito =
		"needs `store: 'cognito'`, the default (a provider federated through Cognito). Remove it, or move the provider to a block without `store: 'builtin'`.";

	test("groupsClaim on a 'cognito' block's oidc provider needs store: 'builtin'", () => {
		for (const store of [undefined, 'cognito']) {
			const options = { store, providers: { okta: { ...okta, clientSecret: secret, groupsClaim: 'groups' } } };
			assert.deepStrictEqual(issues(options), []);
			assert.deepStrictEqual(conflicts(options), [['providers.okta.groupsClaim', needsBuiltin]]);
		}
		assert.deepStrictEqual(
			conflicts({ store: 'builtin', providers: { okta: { ...okta, groupsClaim: 'groups' } } }),
			[],
		);
	});

	test("attributesRequestMethod on a 'builtin' block's oidc provider needs store: 'cognito'", () => {
		const options = { store: 'builtin', providers: { okta: { ...okta, attributesRequestMethod: 'POST' } } };
		assert.deepStrictEqual(issues(options), []);
		assert.deepStrictEqual(conflicts(options), [['providers.okta.attributesRequestMethod', needsCognito]]);
		assert.deepStrictEqual(
			conflicts({ providers: { okta: { ...okta, clientSecret: secret, attributesRequestMethod: 'POST' } } }),
			[],
		);
	});

	test("a 'cognito' block's oidc provider needs a clientSecret; a 'builtin' one does not", () => {
		const message =
			"is required with `store: 'cognito'` (the default): Cognito federates OIDC as a confidential client. " +
			"Add one, or move the provider to a `store: 'builtin'` block for a public (PKCE-only) client.";
		assert.deepStrictEqual(conflicts({ providers: { okta } }), [['providers.okta.clientSecret', message]]);
		assert.deepStrictEqual(
			conflicts({ store: 'cognito', providers: { 'my-idp': { ...okta, clientSecret: undefined } } }),
			[['providers["my-idp"].clientSecret', message]],
		);
		assert.deepStrictEqual(conflicts({ providers: { okta: { ...okta, clientSecret: secret } } }), []);
		assert.deepStrictEqual(conflicts({ store: 'builtin', providers: { okta } }), []);
	});

	test("allowBearerAuth as an object needs store: 'cognito'; a boolean is fine on both", () => {
		const providers = { okta };
		assert.deepStrictEqual(conflicts({ store: 'builtin', providers, allowBearerAuth: { clientIds: ['c'] } }), [
			[
				'allowBearerAuth',
				"as an object (extra Cognito app clients) needs `store: 'cognito'`. A `store: 'builtin'` block takes `true` or `false`.",
			],
		]);
		assert.deepStrictEqual(conflicts({ store: 'builtin', providers, allowBearerAuth: true }), []);
		assert.deepStrictEqual(conflicts({ allowBearerAuth: { clientIds: ['c'] } }), []);
	});

	test('the message names each conflict with its path, the store and why', () => {
		let text = '';
		try {
			assertKnownAuthOptions('auth', {
				providers: { okta: { ...okta, groupsClaim: 'groups' } },
			});
		} catch (e) {
			text = e instanceof Error ? e.message : String(e);
		}
		assert.strictEqual(
			text,
			"Auth 'auth': options conflict with `store: 'cognito'`:\n" +
				`  - \`providers.okta.groupsClaim\` ${needsBuiltin}\n` +
				"  - `providers.okta.clientSecret` is required with `store: 'cognito'` (the default): Cognito federates OIDC as a confidential client. Add one, or move the provider to a `store: 'builtin'` block for a public (PKCE-only) client.\n" +
				"A `'cognito'` block (the default) federates through a Cognito user pool and a `store: 'builtin'` block verifies its providers itself, so each accepts different provider options. See AuthOptions for the supported options.",
		);
		assert.throws(
			() =>
				new Auth(
					root(),
					'auth',
					untyped({ store: 'builtin', providers: { okta: { ...okta, attributesRequestMethod: 'GET' } } }),
				),
			/^Error: Auth 'auth': option conflicts with `store: 'builtin'`:\n {2}- `providers\.okta\.attributesRequestMethod` needs `store: 'cognito'`/,
		);
	});

	test('unknown options are listed before store conflicts', () => {
		assert.throws(
			() => assertKnownAuthOptions('auth', { sesion: {}, providers: { okta } }),
			/^Error: Auth 'auth': unknown option:\n.*\noption conflicts with `store: 'cognito'`:\n/s,
		);
	});
});

describe('the resolver owns the store value and the type a store accepts', () => {
	// The validator walks no entry whose `type` its store does not accept, so the
	// resolver (called right after it in every constructor) reports the real cause.
	function message(options: unknown): string {
		assert.deepStrictEqual(findUnknownAuthOptions(options), [], JSON.stringify(options));
		assert.deepStrictEqual(findStoreConflicts(options), [], JSON.stringify(options));
		try {
			new Auth(root(), 'auth', untyped(options));
		} catch (e) {
			return e instanceof Error ? e.message : String(e);
		}
		assert.fail('expected the constructor to throw');
	}

	test("a social or SAML type on store: 'builtin' needs store: 'cognito'", () => {
		assert.match(
			message({
				store: 'builtin',
				providers: { google: { type: 'google', clientId: 'g', clientSecret: secret, typo: 1 } },
			}),
			/providers\.google has `type: 'google'`, which needs `store: 'cognito'`/,
		);
		assert.match(
			message({ store: 'builtin', providers: { partner: { type: 'saml', metadataURL: 'https://p' } } }),
			/providers\.partner has `type: 'saml'`, which needs `store: 'cognito'`/,
		);
	});

	test("stubIdp() / github() on the default store need store: 'builtin'", () => {
		assert.match(
			message({ providers: { corp: stubIdp() } }),
			/providers\.corp has `type: 'stub'`.*need `store: 'builtin'`/,
		);
		assert.match(
			message({ providers: { github: github({ clientId: 'Iv1', clientSecret: secret }) } }),
			/providers\.github has `type: 'oauth2'`/,
		);
	});

	test('an unknown or missing type, or a social provider keyed differently from its type', () => {
		assert.match(
			message({ providers: { github: { type: 'github', clientId: 'g', clientSecret: secret } } }),
			/providers\.github has `type: 'github'`, which a Cognito user pool cannot federate/,
		);
		assert.match(message({ providers: { okta: { issuer: 'https://o' } } }), /providers\.okta has no `type`/);
		assert.match(
			message({ providers: { gogle: { type: 'google', clientId: 'g', clientSecret: secret } } }),
			/its key must be `google`/,
		);
	});

	test('an unknown store value: provider entries are not walked, the resolver names the store', () => {
		assert.match(
			message({ store: 'direct', providers: { okta: { type: 'oidc', issuer: 'https://o', clientId: 'c' } } }),
			/`store` must be 'cognito' \(the default\) or 'builtin', got "direct"/,
		);
	});
});

describe('valid configurations pass', () => {
	test("a full 'cognito' configuration using every option, with real reference objects", () => {
		const scope = root();
		const appSecret = new AppSetting(scope, 'idp-secret', { secret: true });
		const logger = new Logger(scope, 'logger', { level: 'error' });
		const full = {
			store: 'cognito',
			emailPassword: {
				selfSignUp: true,
				passwordPolicy: {
					minLength: 12,
					requireUppercase: true,
					requireLowercase: true,
					requireDigits: true,
					requireSymbols: true,
				},
				autoSignIn: true,
				revealExistingUsers: false,
			},
			providers: {
				google: {
					type: 'google',
					clientId: 'g',
					clientSecret: appSecret,
					scopes: ['email'],
					attributeMapping: { email: 'email' },
					label: 'G',
				},
				facebook: { type: 'facebook', clientId: 'f', clientSecret: secret },
				amazon: { type: 'amazon', clientId: 'a', clientSecret: secret },
				apple: { type: 'apple', clientId: 'a', teamId: 't', keyId: 'k', privateKey: appSecret },
				entra: {
					type: 'oidc',
					issuer: 'https://login.example.com',
					clientId: 'e',
					clientSecret: secret,
					attributesRequestMethod: 'POST',
					scopes: ['openid'],
					label: 'Entra',
					attributeMapping: { name: 'name' },
					endpoints: { authorization: 'a', token: 't', userInfo: 'u', jwks: 'j' },
				},
				partner: { type: 'saml', metadataUrl: 'https://p.example.com', signRequest: true, label: 'P' },
			},
			mfa: { mode: 'optional', types: ['TOTP'] },
			passkeys: {
				relyingPartyId: 'example.com',
				origins: ['https://example.com'],
				userVerification: 'preferred',
			},
			users: {
				signInWith: ['email'],
				attributes: [{ name: 'dept', type: 'String', mutable: true, required: false }],
				groups: ['admins', { name: 'readers', description: 'R', precedence: 1 }],
				authFlow: 'USER_AUTH',
				preferredChallenge: 'PASSWORD',
				deviceTracking: { challengeRequiredOnNewDevice: true, deviceOnlyRememberedOnUserPrompt: true },
			},
			validateUser: async () => {},
			session: { ttlSeconds: 60, crossDomain: false, freshAgeSeconds: 30 },
			redirects: {
				callbackPath: '/aws-blocks/auth/callback',
				signOutPath: '/aws-blocks/auth/signout',
				postSignInPath: '/',
				postSignOutPath: '/',
				allowedRelayOrigins: [relayOrigin('myapp://auth')],
			},
			hostedUi: { domainPrefix: 'my-app' },
			admin: { actions: ['groups', 'lifecycle'] },
			allowBearerAuth: { clientIds: ['native'] },
			email: {
				fromAddress: 'no-reply@example.com',
				fromName: 'Example',
				replyTo: 'support@example.com',
				sesRegion: 'us-east-1',
				sesVerifiedDomain: 'example.com',
				configurationSetName: 'auth-mail',
			},
			userPool: Auth.fromExisting('us-east-1_abc', 'client'),
			onSignIn: async () => {},
			onSignOut: async () => {},
			removalPolicy: 'retain',
			deletionProtection: true,
			featurePlan: 'essentials',
			logger,
			codeDelivery: async () => {},
		} satisfies AuthMockOptions;
		assert.deepStrictEqual(issues(full), []);
		assert.deepStrictEqual(conflicts(full), []);
		assert.doesNotThrow(() => assertKnownAuthOptions('auth', full));
	});

	test("a full store: 'builtin' configuration using every option it accepts", () => {
		const scope = root();
		const appSecret = new AppSetting(scope, 'idp-secret', { secret: true });
		const logger = new Logger(scope, 'logger', { level: 'error' });
		const full = {
			store: 'builtin',
			providers: {
				okta: {
					type: 'oidc',
					issuer: 'https://okta.example.com',
					clientId: 'o',
					clientSecret: appSecret,
					groupsClaim: 'groups',
					scopes: ['openid'],
					label: 'Okta',
					attributeMapping: { name: 'name' },
					endpoints: { authorization: 'a', token: 't', userInfo: 'u', jwks: 'j' },
				},
				public: { type: 'oidc', issuer: 'https://pkce.example.com', clientId: 'p' },
				github: github({ clientId: 'Iv1', clientSecret: secret }),
				custom: customOauth2({
					name: 'custom',
					clientId: 'c',
					endpoints: { authorization: 'a', token: 't', userInfo: 'u' },
					scopes: ['read'],
					mapClaims: () => ({ providerSub: 's', email: null, name: null }),
				}),
				stub: stubIdp({ users: [{ sub: 's', email: 'e', name: 'n' }], groupsClaim: 'groups', label: 'Stub' }),
			},
			users: { groups: ['admins'] },
			validateUser: async () => {},
			session: { ttlSeconds: 60, crossDomain: false, freshAgeSeconds: 30 },
			redirects: {
				callbackPath: '/aws-blocks/auth/callback',
				allowedRelayOrigins: [relayOrigin('myapp://auth')],
			},
			allowBearerAuth: true,
			onSignIn: async () => {},
			onSignOut: async () => {},
			removalPolicy: 'retain',
			deletionProtection: true,
			logger,
		} satisfies AuthMockOptions;
		assert.deepStrictEqual(issues(full), []);
		assert.deepStrictEqual(conflicts(full), []);
		assert.doesNotThrow(() => assertKnownAuthOptions('auth', full));
	});

	test('the shorthand forms of each group pass', () => {
		for (const options of [
			{},
			{ emailPassword: true },
			{ emailPassword: false },
			{ mfa: 'required' },
			{ passkeys: false },
			{ users: { groups: [] } },
		]) {
			assert.deepStrictEqual(issues(options), [], JSON.stringify(options));
		}
		assert.doesNotThrow(() => assertKnownAuthOptions('auth', undefined));
	});

	test('reference objects are not walked: an AppSetting / fromExisting ref with extra members passes', () => {
		const appSecret = new AppSetting(root(), 'secret', { secret: true });
		assert.deepStrictEqual(
			issues({
				userPool: CdkAuth.fromExisting('us-east-1_abc'),
				providers: {
					google: { type: 'google', clientId: 'g', clientSecret: appSecret },
					okta: { type: 'oidc', issuer: 'https://o', clientId: 'c', clientSecret: { ...secret, extra: 1 } },
				},
			}),
			[],
		);
	});
});

/** The `[path, message]` pairs the validator reports for wrong-typed values in `options`. */
function invalid(options: Record<string, unknown>): [string, string][] {
	return findInvalidAuthOptions(options).map((v) => [v.path, v.message]);
}

describe('boolean options are type-checked, not only key-checked', () => {
	// Every option typed `boolean`. A non-boolean value used to pass the key
	// check and was then read by truthiness or `!== false`, so `selfSignUp: 0`
	// enabled self-service sign-up (`selfSignUpEnabled`: `0 !== false`).
	const booleans: [string, (value: unknown) => Record<string, unknown>][] = [
		['emailPassword.selfSignUp', (v) => ({ emailPassword: { selfSignUp: v } })],
		['emailPassword.autoSignIn', (v) => ({ emailPassword: { autoSignIn: v } })],
		['emailPassword.revealExistingUsers', (v) => ({ emailPassword: { revealExistingUsers: v } })],
		[
			'emailPassword.passwordPolicy.requireUppercase',
			(v) => ({ emailPassword: { passwordPolicy: { requireUppercase: v } } }),
		],
		[
			'emailPassword.passwordPolicy.requireLowercase',
			(v) => ({ emailPassword: { passwordPolicy: { requireLowercase: v } } }),
		],
		[
			'emailPassword.passwordPolicy.requireDigits',
			(v) => ({ emailPassword: { passwordPolicy: { requireDigits: v } } }),
		],
		[
			'emailPassword.passwordPolicy.requireSymbols',
			(v) => ({ emailPassword: { passwordPolicy: { requireSymbols: v } } }),
		],
		['providers.partner.signRequest', (v) => ({ providers: { partner: { type: 'saml', signRequest: v } } })],
		['users.attributes[0].mutable', (v) => ({ users: { attributes: [{ name: 'dept', mutable: v }] } })],
		['users.attributes[0].required', (v) => ({ users: { attributes: [{ name: 'dept', required: v }] } })],
		[
			'users.deviceTracking.challengeRequiredOnNewDevice',
			(v) => ({ users: { deviceTracking: { challengeRequiredOnNewDevice: v } } }),
		],
		[
			'users.deviceTracking.deviceOnlyRememberedOnUserPrompt',
			(v) => ({ users: { deviceTracking: { deviceOnlyRememberedOnUserPrompt: v } } }),
		],
		['session.crossDomain', (v) => ({ session: { crossDomain: v } })],
		['users.caseSensitive', (v) => ({ users: { caseSensitive: v } })],
		['deletionProtection', (v) => ({ deletionProtection: v })],
	];

	for (const [path, build] of booleans) {
		test(path, () => {
			for (const ok of [true, false, undefined]) {
				assert.deepStrictEqual(invalid(build(ok)), [], `${path}: ${String(ok)}`);
			}
			assert.deepStrictEqual(invalid(build(0)), [[path, 'must be `true` or `false`, got the number 0']]);
			assert.deepStrictEqual(invalid(build('false')), [
				[path, 'must be `true` or `false`, got the string "false"'],
			]);
			assert.deepStrictEqual(invalid(build(null)), [[path, 'must be `true` or `false`, got `null`']]);
			assert.deepStrictEqual(invalid(build({})), [[path, 'must be `true` or `false`, got an object']]);
		});
	}

	test('a group with a boolean shorthand takes a boolean or an object, nothing else', () => {
		for (const ok of [true, false, undefined, {}]) {
			assert.deepStrictEqual(invalid({ emailPassword: ok }), [], `emailPassword: ${JSON.stringify(ok)}`);
			assert.deepStrictEqual(invalid({ passkeys: ok }), [], `passkeys: ${JSON.stringify(ok)}`);
			assert.deepStrictEqual(invalid({ allowBearerAuth: ok }), [], `allowBearerAuth: ${JSON.stringify(ok)}`);
		}
		const expected = 'must be `true`, `false` or an options object, got';
		assert.deepStrictEqual(invalid({ allowBearerAuth: 0 }), [['allowBearerAuth', `${expected} the number 0`]]);
		assert.deepStrictEqual(invalid({ allowBearerAuth: 'false' }), [
			['allowBearerAuth', `${expected} the string "false"`],
		]);
		assert.deepStrictEqual(invalid({ emailPassword: 0 }), [['emailPassword', `${expected} the number 0`]]);
		assert.deepStrictEqual(invalid({ emailPassword: [] }), [['emailPassword', `${expected} an array`]]);
		assert.deepStrictEqual(invalid({ passkeys: 'false' }), [['passkeys', `${expected} the string "false"`]]);
		assert.deepStrictEqual(invalid({ passkeys: null }), [['passkeys', `${expected} \`null\``]]);
		// What an untyped caller can pass that JSON cannot.
		assert.deepStrictEqual(invalid({ allowBearerAuth: () => true }), [
			['allowBearerAuth', `${expected} a function`],
		]);
		assert.deepStrictEqual(invalid({ allowBearerAuth: Symbol('on') }), [
			['allowBearerAuth', `${expected} a symbol`],
		]);
		assert.deepStrictEqual(invalid({ deletionProtection: 1n }), [
			['deletionProtection', 'must be `true` or `false`, got the number 1'],
		]);
		assert.deepStrictEqual(invalid({ deletionProtection: 'x'.repeat(50) }), [
			['deletionProtection', `must be \`true\` or \`false\`, got the string "${'x'.repeat(40)}…"`],
		]);
	});

	test("on store: 'builtin', allowBearerAuth takes a boolean; any other non-object is invalid, not a conflict", () => {
		const providers = { local: stubIdp() };
		for (const ok of [true, false, undefined]) {
			assert.deepStrictEqual(invalid({ store: 'builtin', providers, allowBearerAuth: ok }), [], String(ok));
			assert.deepStrictEqual(findStoreConflicts({ store: 'builtin', providers, allowBearerAuth: ok }), []);
		}
		assert.deepStrictEqual(invalid({ store: 'builtin', providers, allowBearerAuth: 'true' }), [
			['allowBearerAuth', 'must be `true`, `false` or an options object, got the string "true"'],
		]);
		assert.deepStrictEqual(findStoreConflicts({ store: 'builtin', providers, allowBearerAuth: 'true' }), []);
	});

	test('options that are not booleans are not type-checked', () => {
		assert.deepStrictEqual(
			invalid({ mfa: 'required', featurePlan: 'lite', session: { ttlSeconds: 60 }, users: { groups: [] } }),
			[],
		);
	});

	test('a value under an unknown key is reported as unknown only', () => {
		assert.deepStrictEqual(invalid({ emailPasword: { selfSignUp: 0 } }), []);
		assert.deepStrictEqual(only({ emailPasword: { selfSignUp: 0 } })[0], 'emailPasword');
	});

	test('every wrong-typed value is reported, in order, after the unknown options', () => {
		const options = { emailPassword: { selfSignUp: 0, autoSignIn: 'yes' }, sesion: {}, allowBearerAuth: 1 };
		assert.deepStrictEqual(
			invalid(options).map(([p]) => p),
			['emailPassword.selfSignUp', 'emailPassword.autoSignIn', 'allowBearerAuth'],
		);
		let text = '';
		try {
			assertKnownAuthOptions('auth', options);
		} catch (e) {
			text = e instanceof Error ? e.message : String(e);
		}
		assert.match(text, /^Auth 'auth': unknown option:\n {2}- `sesion`: did you mean `session`\?\n/);
		assert.match(
			text,
			/\ninvalid option values:\n {2}- `emailPassword\.selfSignUp` must be `true` or `false`, got the number 0\n {2}- `emailPassword\.autoSignIn` must be `true` or `false`, got the string "yes"\n {2}- `allowBearerAuth` must be `true`, `false` or an options object, got the number 1\n/,
		);
		assert.match(text, /cannot be silently ignored/);
		assert.match(text, /cannot silently turn a setting on or off/);
	});
});

describe('every entry rejects unknown options at construction', () => {
	const bad = untyped({ emailPasword: false, users: { preferedChallenge: 'EMAIL_OTP' } });

	function message(construct: () => unknown): string {
		try {
			construct();
		} catch (e) {
			return e instanceof Error ? e.message : String(e);
		}
		assert.fail('expected the constructor to throw');
	}

	function assertMessage(text: string) {
		assert.match(text, /^Auth 'auth': unknown options:/);
		assert.match(text, /- `emailPasword`: did you mean `emailPassword`\?/);
		assert.match(text, /- `users\.preferedChallenge`: did you mean `users\.preferredChallenge`\?/);
		assert.match(text, /cannot be silently ignored/);
	}

	test('mock (default entry)', () => {
		assertMessage(message(() => new Auth(root(), 'auth', bad)));
	});

	test('AWS runtime entry', () => {
		assertMessage(message(() => new AwsAuth(root(), 'auth', bad)));
	});

	test('CDK entry (fails synth)', () => {
		const stack = Object.assign(new cdk.Stack(new cdk.App(), 'OptValStack'), { id: 'OptValStack' });
		// Test plumbing: a bare stack is an acceptable CDK parent.
		assertMessage(message(() => new CdkAuth(stack as unknown as ScopeParent, 'auth', bad)));
	});

	describe('a non-boolean selfSignUp is rejected by every entry (it used to enable self-service sign-up)', () => {
		const zero = untyped({ emailPassword: { selfSignUp: 0 } });
		const expected =
			/^Auth 'auth': invalid option value:\n {2}- `emailPassword\.selfSignUp` must be `true` or `false`, got the number 0\n.*cannot silently turn a setting on or off/s;

		test('mock (default entry)', () => {
			assert.match(
				message(() => new Auth(root(), 'auth', zero)),
				expected,
			);
		});

		test('AWS runtime entry', () => {
			assert.match(
				message(() => new AwsAuth(root(), 'auth', zero)),
				expected,
			);
		});

		test('CDK entry (fails synth)', () => {
			const stack = Object.assign(new cdk.Stack(new cdk.App(), 'OptValBoolStack'), { id: 'OptValBoolStack' });
			// Test plumbing: a bare stack is an acceptable CDK parent.
			assert.match(
				message(() => new CdkAuth(stack as unknown as ScopeParent, 'auth', zero)),
				expected,
			);
		});
	});

	test('the check runs before the block registers, so the id stays free', () => {
		const scope = root();
		message(() => new Auth(scope, 'auth', bad));
		assert.doesNotThrow(() => new Auth(scope, 'auth', {}));
	});

	test('a non-object options value is refused', () => {
		assert.match(
			message(() => assertKnownAuthOptions('auth', 'emailPassword')),
			/options must be an object, got string/,
		);
		assert.match(
			message(() => assertKnownAuthOptions('auth', [])),
			/got an array/,
		);
	});
});

describe('emailPassword: false with an email + password only option is rejected at construction', () => {
	const okta = { type: 'oidc', issuer: 'https://dev-1.okta.com', clientId: '0oa1', clientSecret: secret };
	const passkeys = { relyingPartyId: 'example.com', origins: ['https://example.com'] };

	function message(construct: () => unknown): string {
		try {
			construct();
		} catch (e) {
			return e instanceof Error ? e.message : String(e);
		}
		assert.fail('expected the constructor to throw');
	}

	test('each conflicting option is named, with emailPassword: false', () => {
		assert.deepStrictEqual(findPasswordOnlyOptions({ emailPassword: false, mfa: 'required' }), ["mfa: 'required'"]);
		assert.deepStrictEqual(findPasswordOnlyOptions({ emailPassword: false, mfa: { mode: 'optional' } }), [
			"mfa: 'optional'",
		]);
		assert.deepStrictEqual(
			findPasswordOnlyOptions({
				emailPassword: false,
				mfa: 'optional',
				passkeys,
				users: { deviceTracking: { challengeRequiredOnNewDevice: true } },
			}),
			["mfa: 'optional'", 'passkeys', 'users.deviceTracking'],
		);
	});

	test('the message names both options and the fix', () => {
		const text = message(() =>
			assertKnownAuthOptions('auth', { emailPassword: false, providers: { okta }, mfa: 'required' }),
		);
		assert.strictEqual(
			text,
			"Auth 'auth': `mfa: 'required'` needs email + password sign-in, which `emailPassword: false` disables. " +
				'MFA, passkeys and device tracking apply only to email + password users; federated users get them from their identity provider. ' +
				'Remove the option, or re-enable email + password.',
		);
		assert.match(
			message(() => assertKnownAuthOptions('auth', { emailPassword: false, providers: { okta }, passkeys })),
			/^Auth 'auth': `passkeys` needs email \+ password sign-in, which `emailPassword: false` disables\./,
		);
		assert.match(
			message(() =>
				assertKnownAuthOptions('auth', {
					emailPassword: false,
					providers: { okta },
					mfa: 'optional',
					passkeys,
				}),
			),
			/^Auth 'auth': `mfa: 'optional'`, `passkeys` need email \+ password sign-in/,
		);
	});

	test('combinations that are not contradictions pass', () => {
		for (const options of [
			{ emailPassword: false, providers: { okta } },
			{ emailPassword: false, providers: { okta }, mfa: 'off' },
			{ emailPassword: false, providers: { okta }, mfa: { types: ['TOTP'] } },
			{ emailPassword: false, providers: { okta }, mfa: { mode: 'off', types: ['TOTP'] } },
			{ emailPassword: false, providers: { okta }, passkeys: false },
			{ emailPassword: false, providers: { okta }, users: { groups: ['admins'] } },
			{ mfa: 'required' },
			{ emailPassword: true, mfa: 'optional', users: { authFlow: 'USER_AUTH' }, passkeys },
			{ emailPassword: {}, mfa: { mode: 'required', types: ['TOTP'] } },
		]) {
			assert.deepStrictEqual(findPasswordOnlyOptions(options), [], JSON.stringify(options));
			assert.doesNotThrow(() => assertKnownAuthOptions('auth', options), JSON.stringify(options));
		}
	});

	test("passkeys without users.authFlow: 'USER_AUTH' is rejected in every layer, not only at synth", () => {
		for (const options of [{ passkeys }, { users: { authFlow: 'USER_PASSWORD_AUTH' }, passkeys }]) {
			assert.strictEqual(
				message(() => assertKnownAuthOptions('auth', options)),
				"Auth 'auth': passkeys requires `users.authFlow: 'USER_AUTH'`. Passkeys ride on the USER_AUTH choice-based flow.",
				JSON.stringify(options),
			);
		}
		assert.doesNotThrow(() => assertKnownAuthOptions('auth', { passkeys: false }));
	});

	test('unknown and wrong-typed options are reported first', () => {
		assert.match(
			message(() => assertKnownAuthOptions('auth', { emailPassword: false, mfa: 'required', sesion: {} })),
			/^Auth 'auth': unknown option:/,
		);
	});

	const conflicting = untyped({ emailPassword: false, providers: { okta }, mfa: 'required' });
	const expected =
		/^Auth 'auth': `mfa: 'required'` needs email \+ password sign-in, which `emailPassword: false` disables/;

	test('mock (default entry): fails in npm run dev, not at the call site', () => {
		assert.match(
			message(() => new Auth(root(), 'auth', conflicting)),
			expected,
		);
	});

	test('AWS runtime entry', () => {
		assert.match(
			message(() => new AwsAuth(root(), 'auth', conflicting)),
			expected,
		);
	});

	test('CDK entry (fails synth)', () => {
		const stack = Object.assign(new cdk.Stack(new cdk.App(), 'OptValPwStack'), { id: 'OptValPwStack' });
		// Test plumbing: a bare stack is an acceptable CDK parent.
		assert.match(
			message(() => new CdkAuth(stack as unknown as ScopeParent, 'auth', conflicting)),
			expected,
		);
	});
});
