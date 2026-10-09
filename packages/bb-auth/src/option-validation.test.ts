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
import { assertKnownAuthOptions, findInvalidAuthOptions, findUnknownAuthOptions } from './option-validation.js';
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
	});

	test('an unsupported social provider points at oidcProviders', () => {
		assert.deepStrictEqual(only({ socialProviders: { github: { clientId: 'g', clientSecret: secret } } }), [
			'socialProviders.github',
			'socialProviders supports google, facebook, amazon and apple. Configure any other IdP under `oidcProviders` (`github()` for GitHub).',
		]);
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
		const [, hint] = only({ scopes: ['openid'] });
		assert.match(hint ?? '', /one of `socialProviders\.google\.scopes`, .*…/);
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
		[
			'socialProviders (closed set)',
			{ socialProviders: { gogle: {} } },
			'socialProviders.gogle',
			/socialProviders\.google/,
		],
		[
			'socialProviders.google',
			{ socialProviders: { google: { clientId: 'g', clientSecrt: secret } } },
			'socialProviders.google.clientSecrt',
			/socialProviders\.google\.clientSecret/,
		],
		[
			'socialProviders.apple',
			{ socialProviders: { apple: { clientId: 'a', teamID: 't', keyId: 'k', privateKey: secret } } },
			'socialProviders.apple.teamID',
			/socialProviders\.apple\.teamId/,
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
				oidcProviders: { 'my-corp_IdP.1': { issuer: 'https://idp.example.com', clientId: 'c' } },
				samlProviders: { emailPasword: { metadataUrl: 'https://p.example.com/saml' } },
			}),
			[],
		);
	});

	test('an unknown key inside an OIDC provider entry', () => {
		assert.deepStrictEqual(
			only({ oidcProviders: { okta: { issuer: 'https://o', clientId: 'c', clientSecrt: secret } } }),
			['oidcProviders.okta.clientSecrt', 'did you mean `oidcProviders.okta.clientSecret`?'],
		);
		assert.deepStrictEqual(
			only({
				oidcProviders: { okta: { issuer: 'https://o', clientId: 'c', endpoints: { jwk: 'https://o/jwks' } } },
			})[0],
			'oidcProviders.okta.endpoints.jwk',
		);
	});

	test('a provider id that is not an identifier is quoted in the path', () => {
		assert.strictEqual(
			only({ oidcProviders: { 'google-extras': { issuer: 'i', clientId: 'c', lable: 'x' } } })[0],
			'oidcProviders["google-extras"].lable',
		);
	});

	test('an unknown key inside a SAML provider entry', () => {
		assert.deepStrictEqual(only({ samlProviders: { partner: { metadataURL: 'https://p' } } }), [
			'samlProviders.partner.metadataURL',
			'did you mean `samlProviders.partner.metadataUrl`?',
		]);
	});

	test('federateVia selects the engine: an option of the other engine names the engine it needs', () => {
		assert.deepStrictEqual(
			only({
				oidcProviders: {
					entra: {
						issuer: 'https://e',
						clientId: 'c',
						federateVia: 'cognito',
						clientSecret: secret,
						groupsClaim: 'groups',
					},
				},
			}),
			['oidcProviders.entra.groupsClaim', "`groupsClaim` is not accepted with `federateVia: 'cognito'`"],
		);
		assert.match(
			only({
				oidcProviders: { okta: { issuer: 'https://o', clientId: 'c', attributesRequestMethod: 'POST' } },
			})[1] ?? '',
			/`attributesRequestMethod` is not accepted on a directly federated provider/,
		);
	});

	test('factory-built providers and their nested settings', () => {
		const users = [{ sub: 'u-1', email: 'a@example.com', name: 'A', extra: { groups: ['admin'], anything: 1 } }];
		assert.deepStrictEqual(
			issues({ oidcProviders: { corp: stubIdp({ users, onAuthorize: () => undefined }) } }),
			[],
		);
		assert.deepStrictEqual(
			only({
				oidcProviders: {
					corp: { ...stubIdp(), stubIdp: { users: [{ sub: 's', email: 'e', name: 'n', emial: 'x' }] } },
				},
			})[0],
			'oidcProviders.corp.stubIdp.users[0].emial',
		);
		const gh = github({ clientId: 'Iv1', clientSecret: secret });
		assert.deepStrictEqual(issues({ oidcProviders: { github: gh } }), []);
		assert.deepStrictEqual(
			only({
				oidcProviders: {
					github: { ...gh, oauth2: { ...gh.oauth2, endpoints: { ...gh.oauth2.endpoints, userinfo: 'x' } } },
				},
			}),
			[
				'oidcProviders.github.oauth2.endpoints.userinfo',
				'did you mean `oidcProviders.github.oauth2.endpoints.userInfo`?',
			],
		);
	});
});

describe('valid configurations pass', () => {
	test('a full configuration using every option, with real reference objects', () => {
		const scope = root();
		const appSecret = new AppSetting(scope, 'idp-secret', { secret: true });
		const logger = new Logger(scope, 'logger', { level: 'error' });
		const full = {
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
			socialProviders: {
				google: {
					clientId: 'g',
					clientSecret: appSecret,
					scopes: ['email'],
					attributeMapping: { email: 'email' },
					label: 'G',
				},
				facebook: { clientId: 'f', clientSecret: secret },
				amazon: { clientId: 'a', clientSecret: secret },
				apple: { clientId: 'a', teamId: 't', keyId: 'k', privateKey: appSecret },
			},
			oidcProviders: {
				okta: {
					issuer: 'https://okta.example.com',
					clientId: 'o',
					clientSecret: appSecret,
					federateVia: 'direct',
					groupsClaim: 'groups',
					scopes: ['openid'],
					label: 'Okta',
					attributeMapping: { name: 'name' },
					endpoints: { authorization: 'a', token: 't', userInfo: 'u', jwks: 'j' },
				},
				entra: {
					issuer: 'https://login.example.com',
					clientId: 'e',
					federateVia: 'cognito',
					clientSecret: secret,
					attributesRequestMethod: 'POST',
				},
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
			samlProviders: { partner: { metadataUrl: 'https://p.example.com', signRequest: true, label: 'P' } },
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
			allowBearerAuth: true,
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
				socialProviders: { google: { clientId: 'g', clientSecret: appSecret } },
				oidcProviders: { okta: { issuer: 'https://o', clientId: 'c', clientSecret: { ...secret, extra: 1 } } },
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
		['samlProviders.partner.signRequest', (v) => ({ samlProviders: { partner: { signRequest: v } } })],
		[
			'oidcProviders.corp.stubIdp.unsafeAllowDeployed',
			(v) => ({ oidcProviders: { corp: { ...stubIdp(), stubIdp: { unsafeAllowDeployed: v } } } }),
		],
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
		['allowBearerAuth', (v) => ({ allowBearerAuth: v })],
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
		}
		const expected = 'must be `true`, `false` or an options object, got';
		assert.deepStrictEqual(invalid({ emailPassword: 0 }), [['emailPassword', `${expected} the number 0`]]);
		assert.deepStrictEqual(invalid({ emailPassword: [] }), [['emailPassword', `${expected} an array`]]);
		assert.deepStrictEqual(invalid({ passkeys: 'false' }), [['passkeys', `${expected} the string "false"`]]);
		assert.deepStrictEqual(invalid({ passkeys: null }), [['passkeys', `${expected} \`null\``]]);
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
			/\ninvalid option values:\n {2}- `emailPassword\.selfSignUp` must be `true` or `false`, got the number 0\n {2}- `emailPassword\.autoSignIn` must be `true` or `false`, got the string "yes"\n {2}- `allowBearerAuth` must be `true` or `false`, got the number 1\n/,
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
