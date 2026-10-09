// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The IdP-registration custom-resource handler, exercised on the paths that
 * only run at deploy time and that no synth can show: reading and merging the
 * secret details from SSM (with retry and actionable errors), the create /
 * update upsert, and the type-safe delete. Clients are fakes — no AWS.
 */

import assert from 'node:assert';
import { describe, test } from 'node:test';
import { type CfnEvent, createHandler, type IdpLike, type SsmLike } from './idp-registration-lambda.js';

interface Call {
	name: string;
	input: Record<string, unknown>;
}

/** A Cognito fake holding the pool's providers by name → type; records every command. */
function cognitoFake(initial: Record<string, string> = {}) {
	const providers = new Map(Object.entries(initial));
	const calls: Call[] = [];
	const notFound = () => Object.assign(new Error('not found'), { name: 'ResourceNotFoundException' });
	const idp: IdpLike = {
		send: async (command) => {
			const input: Record<string, unknown> = { ...command.input };
			const name = String(input.ProviderName);
			calls.push({ name: command.constructor.name, input });
			switch (command.constructor.name) {
				case 'DescribeIdentityProviderCommand': {
					const type = providers.get(name);
					if (type === undefined) throw notFound();
					return { IdentityProvider: { ProviderType: type } };
				}
				case 'CreateIdentityProviderCommand':
					providers.set(name, String(input.ProviderType));
					return {};
				case 'UpdateIdentityProviderCommand':
					if (!providers.has(name)) throw notFound();
					return {};
				case 'DeleteIdentityProviderCommand':
					if (!providers.delete(name)) throw notFound();
					return {};
				default:
					throw new Error(`unexpected ${command.constructor.name}`);
			}
		},
	};
	return { idp, calls, providers };
}

function ssmReturning(values: Record<string, string>): SsmLike & { reads: string[] } {
	const reads: string[] = [];
	return {
		reads,
		send: async (command) => {
			const name = String(command.input.Name);
			reads.push(name);
			assert.strictEqual(command.input.WithDecryption, true);
			if (!(name in values)) throw Object.assign(new Error('missing'), { name: 'ParameterNotFound' });
			return { Parameter: { Value: values[name] } };
		},
	};
}

const fast = { retries: 3, retryDelayMs: 1 };

const google: CfnEvent['ResourceProperties'] = {
	UserPoolId: 'us-west-2_pool',
	ProviderName: 'Google',
	ProviderType: 'Google',
	ProviderDetails: { client_id: 'g-client', authorize_scopes: 'openid email profile' },
	SecretDetails: { client_secret: '/app-google-secret' },
	AttributeMapping: { email: 'email' },
};

const apple: CfnEvent['ResourceProperties'] = {
	UserPoolId: 'us-west-2_pool',
	ProviderName: 'SignInWithApple',
	ProviderType: 'SignInWithApple',
	ProviderDetails: { client_id: 'com.example.web', team_id: 'T', key_id: 'K', authorize_scopes: 'email name' },
	SecretDetails: { private_key: '/app-apple-key' },
};

describe('IdP registration handler', () => {
	test('Create: reads each secret detail by name and registers the provider with the merged details', async () => {
		const ssm = ssmReturning({ '/app-google-secret': 'G-SECRET' });
		const cognito = cognitoFake();
		const res = await createHandler(ssm, cognito.idp, fast)({ RequestType: 'Create', ResourceProperties: google });
		assert.strictEqual(res.PhysicalResourceId, 'us-west-2_pool|Google|Google');
		const create = cognito.calls.find((c) => c.name === 'CreateIdentityProviderCommand');
		assert.ok(create);
		assert.deepStrictEqual(create.input.ProviderDetails, {
			client_id: 'g-client',
			authorize_scopes: 'openid email profile',
			client_secret: 'G-SECRET',
		});
		assert.strictEqual(create.input.ProviderType, 'Google');
		assert.deepStrictEqual(create.input.AttributeMapping, { email: 'email' });
	});

	test("Sign in with Apple: the secret detail is 'private_key', and the type is SignInWithApple", async () => {
		const cognito = cognitoFake();
		await createHandler(
			ssmReturning({ '/app-apple-key': '-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----' }),
			cognito.idp,
			fast,
		)({ RequestType: 'Create', ResourceProperties: apple });
		const create = cognito.calls.find((c) => c.name === 'CreateIdentityProviderCommand');
		assert.ok(create);
		assert.strictEqual(create.input.ProviderType, 'SignInWithApple');
		const details = create.input.ProviderDetails as Record<string, string>;
		assert.match(details.private_key, /BEGIN PRIVATE KEY/);
		assert.ok(!('client_secret' in details));
	});

	test('Create when the provider already exists with the same type (an earlier failed run): updates it', async () => {
		const cognito = cognitoFake({ Google: 'Google' });
		await createHandler(
			ssmReturning({ '/app-google-secret': 'S' }),
			cognito.idp,
			fast,
		)({
			RequestType: 'Create',
			ResourceProperties: google,
		});
		assert.deepStrictEqual(
			cognito.calls.map((c) => c.name),
			['DescribeIdentityProviderCommand', 'UpdateIdentityProviderCommand'],
		);
	});

	test('Update: re-reads the secret (rotation) and updates in place', async () => {
		const cognito = cognitoFake({ Google: 'Google' });
		await createHandler(
			ssmReturning({ '/app-google-secret': 'ROTATED' }),
			cognito.idp,
			fast,
		)({
			RequestType: 'Update',
			PhysicalResourceId: 'us-west-2_pool|Google|Google',
			ResourceProperties: google,
		});
		const update = cognito.calls.find((c) => c.name === 'UpdateIdentityProviderCommand');
		assert.strictEqual((update?.input.ProviderDetails as Record<string, string>).client_secret, 'ROTATED');
	});

	test('Update when the provider vanished out of band: recreates it', async () => {
		const cognito = cognitoFake();
		await createHandler(
			ssmReturning({ '/app-google-secret': 'S' }),
			cognito.idp,
			fast,
		)({
			RequestType: 'Update',
			PhysicalResourceId: 'us-west-2_pool|Google|Google',
			ResourceProperties: google,
		});
		assert.strictEqual(cognito.providers.get('Google'), 'Google');
	});

	test('a name held by a provider of another type fails with the two-deploy remedy', async () => {
		const cognito = cognitoFake({ okta: 'SAML' });
		await assert.rejects(
			createHandler(
				ssmReturning({ '/okta': 'S' }),
				cognito.idp,
				fast,
			)({
				RequestType: 'Create',
				ResourceProperties: {
					UserPoolId: 'p',
					ProviderName: 'okta',
					ProviderType: 'OIDC',
					SecretDetails: { client_secret: '/okta' },
				},
			}),
			/already exists on the pool with type SAML.*remove the provider in one deploy/,
		);
	});

	test('Delete: removes the provider this resource registered', async () => {
		const cognito = cognitoFake({ Google: 'Google' });
		await createHandler(
			ssmReturning({}),
			cognito.idp,
			fast,
		)({
			RequestType: 'Delete',
			PhysicalResourceId: 'us-west-2_pool|Google|Google',
			ResourceProperties: google,
		});
		assert.strictEqual(cognito.providers.has('Google'), false);
	});

	test('Delete: leaves a same-named provider of another type alone (it belongs to the replacement)', async () => {
		const cognito = cognitoFake({ okta: 'SAML' });
		await createHandler(
			ssmReturning({}),
			cognito.idp,
			fast,
		)({
			RequestType: 'Delete',
			PhysicalResourceId: 'p|okta|OIDC',
			ResourceProperties: { UserPoolId: 'p', ProviderName: 'okta', ProviderType: 'OIDC' },
		});
		assert.strictEqual(cognito.providers.get('okta'), 'SAML');
		assert.ok(!cognito.calls.some((c) => c.name === 'DeleteIdentityProviderCommand'));
	});

	test('Delete of an already-absent provider succeeds (never blocks a stack delete)', async () => {
		const res = await createHandler(
			ssmReturning({}),
			cognitoFake().idp,
			fast,
		)({
			RequestType: 'Delete',
			PhysicalResourceId: 'us-west-2_pool|Google|Google',
			ResourceProperties: google,
		});
		assert.strictEqual(res.PhysicalResourceId, 'us-west-2_pool|Google|Google');
	});

	test('a missing secret parameter fails with an actionable message naming it (after retrying)', async () => {
		const ssm = ssmReturning({});
		await assert.rejects(
			createHandler(ssm, cognitoFake().idp, fast)({ RequestType: 'Create', ResourceProperties: google }),
			/secret parameter "\/app-google-secret" for identity provider "Google" was not found.*put-parameter/,
		);
		assert.strictEqual(ssm.reads.length, fast.retries);
	});

	test('an empty secret value fails before calling Cognito', async () => {
		const cognito = cognitoFake();
		await assert.rejects(
			createHandler(
				ssmReturning({ '/app-google-secret': '' }),
				cognito.idp,
				fast,
			)({
				RequestType: 'Create',
				ResourceProperties: google,
			}),
			/is empty/,
		);
		assert.deepStrictEqual(cognito.calls, []);
	});

	test('an unknown provider type is rejected', async () => {
		await assert.rejects(
			createHandler(
				ssmReturning({}),
				cognitoFake().idp,
				fast,
			)({
				RequestType: 'Create',
				ResourceProperties: { UserPoolId: 'p', ProviderName: 'gh', ProviderType: 'GitHub' },
			}),
			/unsupported identity provider type "GitHub"/,
		);
	});
});
