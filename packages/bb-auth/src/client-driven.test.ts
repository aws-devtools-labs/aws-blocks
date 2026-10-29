// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The additive options that keep a pool usable by client-driven frontends
 * (an Amplify client library signing in directly against Cognito) next to the
 * block's own server-driven sign-in:
 *
 * - `users.caseSensitive` — Cognito's `UsernameConfiguration.CaseSensitive`.
 *   Unset emits nothing (the zero-config pool stays `AuthCognito`'s); the local
 *   pool matches names the way Cognito does for each setting.
 * - `allowBearerAuth: { clientIds }` and `Auth.fromExisting(…, clientId)` —
 *   extra app clients whose access tokens the guards accept (verification
 *   itself: `index.aws.bearer.test.ts`), validated at synth.
 * - `federatedIdentity` — the IdP subject, read the same way for both
 *   federation engines (end to end: `stub-idp.test.ts`,
 *   `federation-hosted-ui.test.ts`, `index.aws.bearer.test.ts`).
 */

import assert from 'node:assert';
import { rmSync } from 'node:fs';
import { afterEach, beforeEach, describe, test } from 'node:test';
import type { ScopeParent } from '@aws-blocks/core';
import { federatedIdentityOfUsername, poolBearerIdentity, usernameNamesProvider } from './bearer.js';
import { assertBearerClientIds, bearerAuthEnabled, bearerClientIds } from './cdk/contract.js';
import { Auth as MockAuth } from './index.mock.js';
import { cognitoFederatedSubject, identityOf } from './sessions.js';
import { sameSignInName } from './sign-in-mode.js';
import { Browser } from './test-support/aws-harness.js';
import { type CfnResourceJson, synthUnderCdkConditions } from './test-support/cdk-synth.js';
import type { AuthOptions, CodeDeliveryPurpose } from './types.js';

beforeEach(() => rmSync('.bb-data', { recursive: true, force: true }));
afterEach(() => rmSync('.bb-data', { recursive: true, force: true }));

const IMPORTS = "import { Auth } from '@aws-blocks/bb-auth';";
const PASSWORD = 'Passw0rd!';
let n = 0;
const root = (): ScopeParent => ({ id: `clientdriven${process.pid}x${++n}` });

/** The single user pool of a synthesized template. */
function poolOf(build: string): CfnResourceJson {
	const { template } = synthUnderCdkConditions({ imports: IMPORTS, build });
	const pools = Object.values(template.Resources).filter((r) => r.Type === 'AWS::Cognito::UserPool');
	assert.strictEqual(pools.length, 1);
	return pools[0];
}

/** The message a synth-time refusal throws (the probe reports it instead of failing). */
function synthError(options: string): string {
	const { report } = synthUnderCdkConditions({
		imports: IMPORTS,
		build: `try { new Auth(stack, 'auth', ${options}); } catch (e) { report.error = e.message; }`,
	});
	assert.strictEqual(typeof report.error, 'string', `expected synth to refuse ${options}`);
	return String(report.error);
}

describe('users.caseSensitive — the CDK layer', () => {
	test('unset emits no UsernameConfiguration (the zero-config pool is unchanged)', () => {
		const pool = poolOf("new Auth(stack, 'auth')");
		assert.strictEqual(pool.Properties?.UsernameConfiguration, undefined);
	});

	test('false / true map to UsernameConfiguration.CaseSensitive', () => {
		for (const value of [false, true]) {
			const pool = poolOf(`new Auth(stack, 'auth', { users: { caseSensitive: ${value} } })`);
			assert.deepStrictEqual(pool.Properties?.UsernameConfiguration, { CaseSensitive: value });
		}
	});

	test('a non-boolean is refused like every other option of the wrong type', () => {
		assert.match(
			synthError("{ users: { caseSensitive: 'no' } }"),
			/`users\.caseSensitive` must be `true` or `false`/,
		);
	});
});

describe('users.caseSensitive — the local user pool', () => {
	function mockAuth(options: AuthOptions) {
		const codes = new Map<CodeDeliveryPurpose, string>();
		const auth = new MockAuth(root(), 'auth', {
			...options,
			codeDelivery: async (_username: string, code: string, purpose: CodeDeliveryPurpose) => {
				codes.set(purpose, code);
			},
		});
		return { auth, code: () => codes.get('signUp') ?? '' };
	}

	async function signInStatus(auth: MockAuth, login: string): Promise<string> {
		try {
			return (await new Browser().request((ctx) => auth.signIn(login, PASSWORD, ctx))).status;
		} catch (e) {
			return e instanceof Error ? e.name : String(e);
		}
	}

	test('false: a username signs in in any case, and is unique ignoring case', async () => {
		const { auth, code } = mockAuth({ users: { caseSensitive: false } });
		await auth.signUp('Alice', PASSWORD);
		await auth.confirmSignUp('alice', code());
		assert.strictEqual(await signInStatus(auth, 'ALICE'), 'signedIn');
		const b = new Browser();
		await b.request((ctx) => auth.signIn('alice', PASSWORD, ctx));
		const user = await b.request((ctx) => auth.requireAuth(ctx));
		assert.strictEqual(user.username, 'Alice', 'the stored username keeps the case it was created with');
		await assert.rejects(auth.signUp('aLiCe', PASSWORD), { name: 'UsernameExistsException' });
	});

	test('false: on an email sign-in pool the email matches in any case', async () => {
		const { auth, code } = mockAuth({ users: { signInWith: ['email'], caseSensitive: false } });
		await auth.signUp('Ada@Example.com', PASSWORD);
		await auth.confirmSignUp('ada@example.com', code());
		assert.strictEqual(await signInStatus(auth, 'ADA@EXAMPLE.COM'), 'signedIn');
		await assert.rejects(auth.signUp('ada@example.COM', PASSWORD), { name: 'UsernameExistsException' });
	});

	test('unset (Cognito’s default): names match exactly', async () => {
		const { auth, code } = mockAuth({});
		await auth.signUp('Bob', PASSWORD);
		await auth.confirmSignUp('Bob', code());
		assert.strictEqual(await signInStatus(auth, 'Bob'), 'signedIn');
		assert.notStrictEqual(await signInStatus(auth, 'bob'), 'signedIn');
		// A different case is a different user.
		await auth.signUp('bob', PASSWORD);
	});

	test('sameSignInName', () => {
		assert.strictEqual(sameSignInName('Alice', 'alice', true), false);
		assert.strictEqual(sameSignInName('Alice', 'alice', false), true);
		assert.strictEqual(sameSignInName(undefined, 'alice', false), false);
	});
});

describe('allowBearerAuth: { clientIds } — option resolution and synth checks', () => {
	const ref = (clientId?: string) => ({
		__brand: 'ExternalUserPoolRef' as const,
		userPoolId: 'us-east-1_Abc',
		clientId,
	});

	test('enabled by `true` or an object; extra ids from clientIds and fromExisting, de-duplicated', () => {
		assert.strictEqual(bearerAuthEnabled({}), false);
		assert.strictEqual(bearerAuthEnabled({ allowBearerAuth: false }), false);
		assert.strictEqual(bearerAuthEnabled({ allowBearerAuth: true }), true);
		assert.strictEqual(bearerAuthEnabled({ allowBearerAuth: {} }), true);
		assert.deepStrictEqual(bearerClientIds({ allowBearerAuth: true }), []);
		assert.deepStrictEqual(bearerClientIds({ allowBearerAuth: { clientIds: ['a1', 'b2', 'a1'] } }), ['a1', 'b2']);
		assert.deepStrictEqual(bearerClientIds({ allowBearerAuth: true, userPool: ref('c3') }), ['c3']);
		assert.deepStrictEqual(bearerClientIds({ userPool: ref('c3') }), [], 'only with bearer auth on');
	});

	test('synth refuses an id that cannot be a Cognito client id; a CDK token is accepted', () => {
		const refuse = (options: AuthOptions, pattern: RegExp) =>
			assert.throws(() => assertBearerClientIds('app-auth', options), pattern);
		refuse({ allowBearerAuth: { clientIds: [''] } }, /clientIds\[0\]` must be a Cognito app-client id/);
		refuse({ allowBearerAuth: { clientIds: ['has space'] } }, /must be a Cognito app-client id/);
		refuse({ allowBearerAuth: true, userPool: ref('has space') }, /fromExisting.*must be a Cognito app-client id/);
		// A token's value is known only at deploy time: accepted, and forwarded through config.
		assertBearerClientIds('app-auth', { allowBearerAuth: { clientIds: ['${Token[TOKEN.123]}'] } });
		assertBearerClientIds('app-auth', { allowBearerAuth: true, userPool: ref('${Token[TOKEN.9]}') });
		// fromExisting's id was ignored before: it is checked only once bearer auth uses it.
		assertBearerClientIds('app-auth', { userPool: ref('has space') });
		assertBearerClientIds('app-auth', { allowBearerAuth: { clientIds: ['1example23456789abcdefghij'] } });
	});

	test('the extra ids reach the runtime through config — CDK tokens resolved at deploy time', () => {
		const KEY = /^BLOCKS_AUTH_COGNITO_.*_BEARER_CLIENT_IDS$/;
		const configOf = (build: string) => synthUnderCdkConditions({ imports: IMPORTS, build }).config;
		const keyOf = (config: Record<string, unknown>) => Object.keys(config).filter((k) => KEY.test(k));

		// A literal list: joined as is.
		const literal = configOf(
			"new Auth(stack, 'auth', { allowBearerAuth: { clientIds: ['1example23456789abcdefghij', 'second0client'] } })",
		);
		assert.deepStrictEqual(
			keyOf(literal).map((k) => literal[k]),
			['1example23456789abcdefghij,second0client'],
		);

		// An app client created in the same CDK app: a deploy-time reference, not a string.
		const token = configOf(`
			const extra = new cdk.aws_cognito.UserPool(stack, 'other').addClient('web');
			new Auth(stack, 'auth', { allowBearerAuth: { clientIds: [extra.userPoolClientId] } });
		`);
		const [tokenKey] = keyOf(token);
		assert.ok(tokenKey, 'the bearer client ids are registered');
		assert.match(
			JSON.stringify(token[tokenKey]),
			/Fn::Join|Ref/,
			'a CloudFormation reference, resolved at deploy time',
		);

		// fromExisting with a token client id, bearer auth on.
		const imported = configOf(`
			const p = new cdk.aws_cognito.UserPool(stack, 'gen2');
			const c = p.addClient('web');
			new Auth(stack, 'auth', { userPool: Auth.fromExisting(p.userPoolId, c.userPoolClientId), allowBearerAuth: true });
		`);
		assert.strictEqual(keyOf(imported).length, 1);
		assert.match(JSON.stringify(imported[keyOf(imported)[0]]), /Ref/);

		// No extra ids → no key (every other configuration's config is unchanged).
		assert.deepStrictEqual(keyOf(configOf("new Auth(stack, 'auth', { allowBearerAuth: true })")), []);
		assert.deepStrictEqual(keyOf(configOf("new Auth(stack, 'auth')")), []);
	});

	test('the CDK layer applies the checks, and refuses clientIds without a pool', () => {
		assert.match(synthError("{ allowBearerAuth: { clientIds: ['bad id'] } }"), /must be a Cognito app-client id/);
		assert.match(
			synthError(
				"{ emailPassword: false, oidcProviders: { okta: { issuer: 'https://dev-1.okta.com', clientId: '0oa1' } }, allowBearerAuth: { clientIds: ['${Token[TOKEN.1]}'] } }",
			),
			/has no user pool/,
			'a token on a pool-less configuration is refused too',
		);
		assert.match(
			synthError(
				"{ emailPassword: false, oidcProviders: { okta: { issuer: 'https://dev-1.okta.com', clientId: '0oa1' } }, allowBearerAuth: { clientIds: ['abc123'] } }",
			),
			/has no user pool/,
		);
		// Accepted: a pool with an extra client.
		poolOf("new Auth(stack, 'auth', { allowBearerAuth: { clientIds: ['1example23456789abcdefghij'] } })");
	});

	test('an unknown key under allowBearerAuth is refused with a hint', () => {
		assert.match(
			synthError("{ allowBearerAuth: { clientId: ['abc'] } }"),
			/unknown option:\n {2}- `allowBearerAuth\.clientId`/,
		);
	});
});

describe('federatedIdentity — derivation', () => {
	test('a direct session: the provider key and the IdP subject', () => {
		const identity = identityOf({
			kind: 'direct',
			provider: 'okta',
			issuer: 'https://dev-1.okta.com',
			subject: '00u1',
			username: 'Alice',
			groups: [],
			attributes: {},
			authTime: 0,
			expiresAt: 0,
		});
		assert.deepStrictEqual(identity.federatedIdentity, { providerId: 'okta', sub: '00u1' });
	});

	test('a Cognito-federated session: identities[].userId, else the username suffix; none for password', () => {
		assert.strictEqual(
			cognitoFederatedSubject({ identities: [{ userId: '1001', providerName: 'Google', primary: 'true' }] }, 'x'),
			'1001',
		);
		assert.strictEqual(
			cognitoFederatedSubject(
				{
					identities: [
						{ userId: 'a', primary: 'false' },
						{ userId: 'b', primary: true },
					],
				},
				'Google_a',
			),
			'b',
			'the primary linked identity wins',
		);
		assert.strictEqual(cognitoFederatedSubject({}, 'Google_1234'), '1234');
		assert.strictEqual(cognitoFederatedSubject({}, 'alice'), '');
	});

	test('from a username: only a configured Cognito-federated provider’s prefix counts', () => {
		const options: AuthOptions = {
			socialProviders: { google: { clientId: 'g', clientSecret: { fullId: 's', get: async () => '' } } },
		};
		assert.deepStrictEqual(federatedIdentityOfUsername('Google_1234', options), {
			providerId: 'google',
			sub: '1234',
		});
		assert.deepStrictEqual(federatedIdentityOfUsername('google_1234', options), {
			providerId: 'google',
			sub: '1234',
		});
		assert.strictEqual(federatedIdentityOfUsername('Facebook_1', options), undefined);
		assert.strictEqual(federatedIdentityOfUsername('Google_', options), undefined);
	});
});

describe('federatedIdentity — bearer tokens from an extra client', () => {
	// (Pure functions: only one federated `Auth` fits in a process, because
	// the sign-in routes are process-global.)
	const google = { google: { clientId: 'g', clientSecret: { fullId: 'unused', get: async () => 'unused' } } };
	const claims = { username: 'Google_1234567890', sub: 'sub-1', exp: 2_000_000_000, iat: 1_000_000_000 };
	const ref = { __brand: 'ExternalUserPoolRef', userPoolId: 'us-east-1_Pool', clientId: 'c1' } as const;

	test('the username is trusted to name a provider only where no password user can own it', () => {
		assert.strictEqual(usernameNamesProvider('hostedUi', { socialProviders: google }), true);
		assert.strictEqual(usernameNamesProvider('native', { socialProviders: google }), false);
		assert.strictEqual(usernameNamesProvider('extra', { socialProviders: google }), false, 'username pool');
		assert.strictEqual(
			usernameNamesProvider('extra', { users: { signInWith: ['email'] }, socialProviders: google }),
			true,
			'generated usernames',
		);
		assert.strictEqual(
			usernameNamesProvider('extra', {
				userPool: ref,
				users: { signInWith: ['email'] },
				socialProviders: google,
			}),
			false,
			'imported pool: its sign-in shape is unknown',
		);
	});

	test('a password user named `Google_<id>` on a username pool is not reported as that Google user', () => {
		const spoof = poolBearerIdentity(claims, 'extra', { socialProviders: google });
		assert.ok(spoof);
		assert.strictEqual(spoof.signInProvider, 'password');
		assert.strictEqual(spoof.federatedIdentity, undefined);

		const real = poolBearerIdentity(claims, 'extra', { users: { signInWith: ['email'] }, socialProviders: google });
		assert.ok(real);
		assert.strictEqual(real.signInProvider, 'google');
		assert.deepStrictEqual(real.federatedIdentity, { providerId: 'google', sub: '1234567890' });
	});
});
