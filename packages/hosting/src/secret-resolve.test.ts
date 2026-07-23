// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert';
import { describe, it } from 'node:test';
import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { DEFAULT_SECRET_STORE, secret, secretStoreLocator } from './secret.js';
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
	void it('fetches each key via the injected fetcher + prefix, using the DEFAULT store locator form', async () => {
		const seen: string[] = [];
		const resolved = await resolveSecretsAtSynth(['DOMAIN_PROD'], {
			prefix: '/blocks/secrets',
			fetcher: async (locator) => {
				seen.push(locator);
				return 'prod.example.com';
			},
		});
		// Locator form follows DEFAULT_SECRET_STORE — flip-proof.
		assert.deepStrictEqual(seen, [secretStoreLocator('DOMAIN_PROD', { prefix: '/blocks/secrets' })]);
		assert.strictEqual(resolved.get('DOMAIN_PROD'), 'prod.example.com');
	});

	void it('uses the slash-free name when store: secrets-manager is opted into', async () => {
		const seen: string[] = [];
		await resolveSecretsAtSynth(['DOMAIN_PROD'], {
			prefix: '/blocks/secrets',
			store: 'secrets-manager',
			fetcher: async (locator) => {
				seen.push(locator);
				return 'prod.example.com';
			},
		});
		assert.deepStrictEqual(seen, ['blocks/secrets/DOMAIN_PROD']);
	});

	void it('uses the leading-slash path when store: ssm is opted into', async () => {
		const seen: string[] = [];
		await resolveSecretsAtSynth(['DOMAIN_PROD'], {
			prefix: '/blocks/secrets',
			store: 'ssm',
			fetcher: async (locator) => {
				seen.push(locator);
				return 'prod.example.com';
			},
		});
		assert.deepStrictEqual(seen, ['/blocks/secrets/DOMAIN_PROD']);
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

	void it('SSM (opt-in): injects param NAME + grants ssm:GetParameter + kms:Decrypt, no _STORE hint', () => {
		const { stack, fn } = fnStack();
		wireRuntimeSecret(fn, 'STRIPE_KEY', { prefix: '/blocks/secrets', store: 'ssm' });
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
		// No plaintext value in the template, and no store hint for SSM.
		const json = JSON.stringify(t.toJSON());
		assert.ok(!json.includes('sk_live'));
		assert.ok(!json.includes('HOSTING_SECRET_PARAM_STRIPE_KEY_STORE'));
	});

	void it('secrets-manager (DEFAULT): slash-free locator + _STORE hint + secretsmanager:GetSecretValue', () => {
		const { stack, fn } = fnStack();
		// No `store` passed → the default (Secrets Manager) must apply.
		wireRuntimeSecret(fn, 'STRIPE_KEY', { prefix: '/blocks/secrets' });
		const t = Template.fromStack(stack);
		t.hasResourceProperties('AWS::Lambda::Function', {
			Environment: {
				Variables: Match.objectLike({
					// SM names are slash-free at the root (see secretStoreLocator).
					HOSTING_SECRET_PARAM_STRIPE_KEY: 'blocks/secrets/STRIPE_KEY',
					HOSTING_SECRET_PARAM_STRIPE_KEY_STORE: 'secrets-manager',
				}),
			},
		});
		t.hasResourceProperties('AWS::IAM::Policy', {
			PolicyDocument: {
				Statement: Match.arrayWith([
					Match.objectLike({ Action: 'secretsmanager:GetSecretValue' }),
					Match.objectLike({ Action: 'kms:Decrypt' }),
				]),
			},
		});
		// IAM ARN scopes to this secret via SM's -?????? suffix wildcard.
		assert.ok(JSON.stringify(t.toJSON()).includes('blocks/secrets/STRIPE_KEY-??????'));
		// The default-store wiring equals an explicit secrets-manager wiring.
		assert.strictEqual(DEFAULT_SECRET_STORE, 'secrets-manager');
	});

	void it('with a stage: injects stage locator + _FALLBACK shared locator, grants BOTH ARNs', () => {
		const { stack, fn } = fnStack();
		wireRuntimeSecret(fn, 'STRIPE_KEY', { prefix: '/blocks/secrets', store: 'ssm', stage: 'prod' });
		const t = Template.fromStack(stack);
		t.hasResourceProperties('AWS::Lambda::Function', {
			Environment: {
				Variables: Match.objectLike({
					// primary = stage-specific; fallback = shared.
					HOSTING_SECRET_PARAM_STRIPE_KEY: '/blocks/secrets/prod/STRIPE_KEY',
					HOSTING_SECRET_PARAM_STRIPE_KEY_FALLBACK: '/blocks/secrets/STRIPE_KEY',
				}),
			},
		});
		// The role is granted read on BOTH the stage and the shared parameter ARNs.
		const json = JSON.stringify(t.toJSON());
		assert.ok(json.includes('parameter/blocks/secrets/prod/STRIPE_KEY'), 'stage ARN granted');
		assert.ok(json.includes('parameter/blocks/secrets/STRIPE_KEY'), 'shared ARN granted');
	});

	void it('emits a single kms:Decrypt statement even with a stage fallback (no per-locator dupes)', () => {
		const { stack, fn } = fnStack();
		wireRuntimeSecret(fn, 'STRIPE_KEY', { prefix: '/blocks/secrets', store: 'ssm', stage: 'prod' });
		const policy = JSON.stringify(Template.fromStack(stack).toJSON());
		// stage + shared = two read grants, but the identical kms:Decrypt is hoisted
		// to exactly one statement (was 2N before the dedupe fix).
		const decryptCount = (policy.match(/kms:Decrypt/g) ?? []).length;
		assert.strictEqual(decryptCount, 1, `expected exactly one kms:Decrypt statement, got ${decryptCount}`);
	});

	void it('grants kms:Decrypt once per function across multiple secrets in the same store', () => {
		const { stack, fn } = fnStack();
		wireRuntimeSecret(fn, 'STRIPE_KEY', { prefix: '/blocks/secrets', store: 'ssm' });
		wireRuntimeSecret(fn, 'SENTRY_DSN', { prefix: '/blocks/secrets', store: 'ssm' });
		const policy = JSON.stringify(Template.fromStack(stack).toJSON());
		const decryptCount = (policy.match(/kms:Decrypt/g) ?? []).length;
		assert.strictEqual(decryptCount, 1, `expected one shared kms:Decrypt for the store, got ${decryptCount}`);
	});

	void it('without a stage: no _FALLBACK var, single ARN grant (unchanged)', () => {
		const { stack, fn } = fnStack();
		wireRuntimeSecret(fn, 'STRIPE_KEY', { prefix: '/blocks/secrets', store: 'ssm' });
		const json = JSON.stringify(Template.fromStack(stack).toJSON());
		assert.ok(!json.includes('HOSTING_SECRET_PARAM_STRIPE_KEY_FALLBACK'), 'no fallback var when stageless');
	});
});

void describe('resolveSecretsAtSynth() — per-stage fallback', () => {
	void it('prefers the stage value, else falls back to the shared value', async () => {
		const seen: string[] = [];
		// Fetcher: stage-specific path is "not set", shared path resolves.
		const resolved = await resolveSecretsAtSynth(['DOMAIN'], {
			prefix: '/blocks/secrets',
			store: 'ssm',
			stage: 'pr-123',
			fetcher: async (locator) => {
				seen.push(locator);
				if (locator === '/blocks/secrets/pr-123/DOMAIN') {
					const e = new Error('missing');
					e.name = 'ParameterNotFound';
					throw e;
				}
				return 'shared.example.com';
			},
		});
		// Tried stage first, then shared.
		assert.deepStrictEqual(seen, ['/blocks/secrets/pr-123/DOMAIN', '/blocks/secrets/DOMAIN']);
		assert.strictEqual(resolved.get('DOMAIN'), 'shared.example.com');
	});

	void it('uses the stage value directly when it exists (no fallback call)', async () => {
		const seen: string[] = [];
		const resolved = await resolveSecretsAtSynth(['DOMAIN'], {
			prefix: '/blocks/secrets',
			store: 'ssm',
			stage: 'prod',
			fetcher: async (locator) => {
				seen.push(locator);
				return 'prod.example.com';
			},
		});
		assert.deepStrictEqual(seen, ['/blocks/secrets/prod/DOMAIN']);
		assert.strictEqual(resolved.get('DOMAIN'), 'prod.example.com');
	});

	void it('errors naming both stage and shared when neither is set', async () => {
		await assert.rejects(
			resolveSecretsAtSynth(['DOMAIN'], {
				prefix: '/blocks/secrets',
				store: 'ssm',
				stage: 'prod',
				fetcher: async () => {
					const e = new Error('missing');
					e.name = 'ParameterNotFound';
					throw e;
				},
			}),
			/stage 'prod'.*shared|--stage prod/s,
		);
	});
});
