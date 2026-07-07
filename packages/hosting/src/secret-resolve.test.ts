// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert';
import { describe, it } from 'node:test';
import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { secret } from './secret.js';
import {
	collectSynthSecretKeys,
	partitionEnvironment,
	resolveDomainNames,
	resolveSecretsAtSynth,
	wireRuntimeSecret,
} from './secret-resolve.js';

void describe('partitionEnvironment()', () => {
	void it('splits plain / runtime-secret / exposeAsEnv', () => {
		const { plain, runtimeSecrets, exposeSecrets } = partitionEnvironment({
			FLAG: 'on',
			STRIPE_KEY: secret('STRIPE_KEY'),
			LEGACY: secret('LEGACY', { exposeAsEnv: true }),
		});
		assert.deepStrictEqual(plain, { FLAG: 'on' });
		assert.deepStrictEqual(
			runtimeSecrets.map((s) => s.key),
			['STRIPE_KEY'],
		);
		assert.deepStrictEqual(
			exposeSecrets.map((s) => s.key),
			['LEGACY'],
		);
	});

	void it('rejects an env key / secret key mismatch', () => {
		assert.throws(
			() => partitionEnvironment({ STRIPE_KEY: secret('OTHER') }),
			/must match the environment variable name/,
		);
	});
});

void describe('resolveSecretsAtSynth()', () => {
	void it('fetches each key via the injected fetcher + prefix', async () => {
		const seen: string[] = [];
		const resolved = await resolveSecretsAtSynth(['DOMAIN_PROD'], {
			prefix: '/blocks/secrets',
			fetcher: async (locator) => {
				seen.push(locator);
				return 'prod.example.com';
			},
		});
		assert.deepStrictEqual(seen, ['/blocks/secrets/DOMAIN_PROD']);
		assert.strictEqual(resolved.get('DOMAIN_PROD'), 'prod.example.com');
	});

	void it('maps a not-found error (either store) to an actionable message', async () => {
		await assert.rejects(
			resolveSecretsAtSynth(['X'], {
				fetcher: async () => {
					const e = new Error('nope');
					e.name = 'ResourceNotFoundException';
					throw e;
				},
			}),
			/secret set X <value>/,
		);
	});
});

void describe('resolveDomainNames()', () => {
	void it('replaces markers with resolved literals, preserving shape', () => {
		const resolved = new Map([['DOMAIN_PROD', 'prod.example.com']]);
		assert.strictEqual(resolveDomainNames(secret('DOMAIN_PROD'), resolved), 'prod.example.com');
		assert.deepStrictEqual(resolveDomainNames(['www.example.com', secret('DOMAIN_PROD')], resolved), [
			'www.example.com',
			'prod.example.com',
		]);
	});

	void it('collectSynthSecretKeys gathers domain + exposeAsEnv, deduped', () => {
		const keys = collectSynthSecretKeys(
			['example.com', secret('DOMAIN_PROD')],
			[secret('LEGACY', { exposeAsEnv: true }), secret('DOMAIN_PROD', { exposeAsEnv: true })],
		);
		assert.deepStrictEqual([...keys].sort(), ['DOMAIN_PROD', 'LEGACY']);
	});
});

void describe('wireRuntimeSecret() — IAM + env per store', () => {
	function fnStack() {
		const stack = new cdk.Stack(new cdk.App(), 'S', { env: { account: '111111111111', region: 'us-east-1' } });
		const fn = new lambda.Function(stack, 'Fn', {
			runtime: lambda.Runtime.NODEJS_20_X,
			handler: 'index.handler',
			code: lambda.Code.fromInline('exports.handler=()=>{}'),
		});
		return { stack, fn };
	}

	void it('SSM (default): injects param NAME + grants ssm:GetParameter + kms:Decrypt', () => {
		const { stack, fn } = fnStack();
		wireRuntimeSecret(fn, 'STRIPE_KEY', { prefix: '/blocks/secrets' });
		const t = Template.fromStack(stack);
		t.hasResourceProperties('AWS::Lambda::Function', {
			Environment: {
				Variables: Match.objectLike({ HOSTING_SECRET_PARAM_STRIPE_KEY: '/blocks/secrets/STRIPE_KEY' }),
			},
		});
		t.hasResourceProperties('AWS::IAM::Policy', {
			PolicyDocument: {
				Statement: Match.arrayWith([
					Match.objectLike({ Action: 'ssm:GetParameter' }),
					Match.objectLike({ Action: 'kms:Decrypt' }),
				]),
			},
		});
		// No plaintext value in the template.
		assert.ok(!JSON.stringify(t.toJSON()).includes('sk_live'));
	});

	void it('secrets-manager: adds _STORE hint + grants secretsmanager:GetSecretValue', () => {
		const { stack, fn } = fnStack();
		wireRuntimeSecret(fn, 'STRIPE_KEY', { prefix: '/blocks/secrets', store: 'secrets-manager' });
		const t = Template.fromStack(stack);
		t.hasResourceProperties('AWS::Lambda::Function', {
			Environment: {
				Variables: Match.objectLike({
					HOSTING_SECRET_PARAM_STRIPE_KEY: '/blocks/secrets/STRIPE_KEY',
					HOSTING_SECRET_PARAM_STRIPE_KEY_STORE: 'secrets-manager',
				}),
			},
		});
		t.hasResourceProperties('AWS::IAM::Policy', {
			PolicyDocument: {
				Statement: Match.arrayWith([Match.objectLike({ Action: 'secretsmanager:GetSecretValue' })]),
			},
		});
	});
});
