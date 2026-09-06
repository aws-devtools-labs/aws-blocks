// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert';
import { describe, it } from 'node:test';
import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { Secret } from 'aws-cdk-lib/aws-secretsmanager';
import { StringParameter } from 'aws-cdk-lib/aws-ssm';
import { config, secret } from './secret.js';
import {
	_setSynthExistsChecker,
	assertMarkersExistAtSynth,
	collectSynthMarkers,
	partitionEnvironment,
	resolveDomainNames,
	resolveSecretsAtSynth,
	wireByo,
	wireManagedValue,
} from './secret-resolve.js';

void describe('assertMarkersExistAtSynth() — deploy-time existence check', () => {
	const notFound = (name: string) => {
		const e = new Error('missing') as Error & { name: string };
		e.name = name;
		return e;
	};

	void it('throws UnresolvedSecretError when a marker is not set', async () => {
		_setSynthExistsChecker(async () => {
			throw notFound('ResourceNotFoundException');
		});
		try {
			await assert.rejects(assertMarkersExistAtSynth([secret('MISSING_KEY')]), /MISSING_KEY.*not set/s);
		} finally {
			_setSynthExistsChecker(null);
		}
	});

	void it('resolves when every marker exists', async () => {
		_setSynthExistsChecker(async () => {}); // exists
		try {
			await assert.doesNotReject(assertMarkersExistAtSynth([secret('A'), config('B')]));
		} finally {
			_setSynthExistsChecker(null);
		}
	});

	void it('never fetches the value — the checker gets a locator + store, not the value', async () => {
		const seen: Array<{ locator: string; store: string }> = [];
		_setSynthExistsChecker(async (locator, store) => {
			seen.push({ locator, store });
		});
		try {
			await assertMarkersExistAtSynth([secret('TOKEN'), config('FLAGS')]);
			assert.equal(seen.length, 2);
			assert.ok(seen.some((s) => s.store === 'secrets-manager' && s.locator.includes('TOKEN')));
			assert.ok(seen.some((s) => s.store === 'ssm' && s.locator.includes('FLAGS')));
		} finally {
			_setSynthExistsChecker(null);
		}
	});

	void it('skips (does not throw) when existence cannot be determined — e.g. no credentials', async () => {
		_setSynthExistsChecker(async () => {
			throw notFound('CredentialsProviderError'); // not a NotFound → indeterminate
		});
		try {
			await assert.doesNotReject(assertMarkersExistAtSynth([secret('X')]));
		} finally {
			_setSynthExistsChecker(null);
		}
	});

	void it('accepts the shared default when the stage-specific value is absent', async () => {
		const calls: string[] = [];
		_setSynthExistsChecker(async (locator) => {
			calls.push(locator);
			if (locator.includes('/beta/')) throw notFound('ParameterNotFound'); // stage missing
			// shared default (no /beta/ segment) exists
		});
		try {
			await assert.doesNotReject(
				assertMarkersExistAtSynth([config('SHARED')], { configStore: { stage: 'beta' } }),
			);
			assert.ok(calls.length >= 2, 'should probe the stage locator then fall back to the shared one');
		} finally {
			_setSynthExistsChecker(null);
		}
	});

	void it('is a no-op for an empty marker list', async () => {
		let called = false;
		_setSynthExistsChecker(async () => {
			called = true;
		});
		try {
			await assertMarkersExistAtSynth([]);
			assert.equal(called, false);
		} finally {
			_setSynthExistsChecker(null);
		}
	});
});

void describe('wireManagedValue() — JSON parse flag for schema markers', () => {
	const stubSchema = {
		'~standard': { version: 1 as const, vendor: 'test', validate: (value: unknown) => ({ value }) },
	};

	void it('injects HOSTING_CONFIG_JSON_<KEY> only when the marker declares a schema', () => {
		const stack = new cdk.Stack(new cdk.App(), 'S', { env: { account: '111111111111', region: 'us-east-1' } });
		const fn = new lambda.Function(stack, 'Fn', {
			runtime: lambda.Runtime.NODEJS_20_X,
			handler: 'index.handler',
			code: lambda.Code.fromInline('exports.handler=()=>{}'),
		});
		wireManagedValue(fn, config('FLAGS', { schema: stubSchema }), { configStore: { prefix: '/blocks/config' } });
		wireManagedValue(fn, config('PLAIN'), { configStore: { prefix: '/blocks/config' } });
		const t = Template.fromStack(stack);
		t.hasResourceProperties('AWS::Lambda::Function', {
			Environment: { Variables: Match.objectLike({ HOSTING_CONFIG_JSON_FLAGS: '1' }) },
		});
		// PLAIN has no schema → no JSON flag.
		t.hasResourceProperties('AWS::Lambda::Function', {
			Environment: { Variables: Match.not(Match.objectLike({ HOSTING_CONFIG_JSON_PLAIN: Match.anyValue() })) },
		});
	});
});

void describe('partitionEnvironment()', () => {
	void it('splits plain / managed (secret+config) / BYO', () => {
		const stack = new cdk.Stack(new cdk.App(), 'S');
		const byoSecret = Secret.fromSecretNameV2(stack, 'S1', 'prod/stripe');
		const byoParam = StringParameter.fromStringParameterName(stack, 'P1', '/prod/flag');
		const { plain, managed, byo } = partitionEnvironment({
			FLAG: 'on',
			STRIPE_KEY: secret('STRIPE_KEY'),
			FEATURE_FLAGS: config('FEATURE_FLAGS'),
			BYO_SECRET: byoSecret,
			BYO_PARAM: byoParam,
		});
		assert.deepStrictEqual(plain, { FLAG: 'on' });
		assert.deepStrictEqual(managed.map((m) => `${m.key}:${m.kind}`).sort(), [
			'FEATURE_FLAGS:config',
			'STRIPE_KEY:secret',
		]);
		assert.deepStrictEqual(byo.map((b) => `${b.key}:${b.kind}`).sort(), ['BYO_PARAM:config', 'BYO_SECRET:secret']);
	});

	void it('rejects an env key / marker key mismatch', () => {
		assert.throws(
			() => partitionEnvironment({ STRIPE_KEY: secret('OTHER') }),
			/must match the environment variable name/,
		);
	});
});

void describe('resolveSecretsAtSynth()', () => {
	void it('config marker → SSM leading-slash locator under configStore.prefix', async () => {
		const seen: string[] = [];
		const resolved = await resolveSecretsAtSynth([config('DOMAIN_PROD')], {
			configStore: { prefix: '/blocks/config' },
			fetcher: async (loc) => {
				seen.push(loc);
				return 'prod.example.com';
			},
		});
		assert.deepStrictEqual(seen, ['/blocks/config/DOMAIN_PROD']);
		assert.strictEqual(resolved.get('DOMAIN_PROD'), 'prod.example.com');
	});

	void it('secret marker → Secrets Manager slash-free locator under secretStore.prefix', async () => {
		const seen: string[] = [];
		await resolveSecretsAtSynth([secret('API_KEY')], {
			secretStore: { prefix: '/blocks/secrets' },
			fetcher: async (loc) => {
				seen.push(loc);
				return 'k';
			},
		});
		assert.deepStrictEqual(seen, ['blocks/secrets/API_KEY']);
	});

	void it('not-found → actionable message naming the function + CLI', async () => {
		await assert.rejects(
			resolveSecretsAtSynth([config('X')], {
				fetcher: async () => {
					const e = new Error('nope');
					e.name = 'ResourceNotFoundException';
					throw e;
				},
			}),
			(err: unknown) => {
				const e = err as { message?: string; resolution?: string };
				assert.match(e.message ?? '', /config 'X' is referenced/);
				assert.match(e.resolution ?? '', /config set X/);
				return true;
			},
		);
	});
});

void describe('resolveDomainNames() / collectSynthMarkers()', () => {
	void it('replaces markers with resolved literals; collects domain markers deduped', () => {
		const resolved = new Map([['DOMAIN_PROD', 'prod.example.com']]);
		assert.strictEqual(resolveDomainNames(config('DOMAIN_PROD'), resolved), 'prod.example.com');
		const markers = collectSynthMarkers(['example.com', config('DOMAIN_PROD'), config('DOMAIN_PROD')]);
		assert.deepStrictEqual(
			markers.map((m) => m.key),
			['DOMAIN_PROD'],
		);
	});
});

void describe('wireManagedValue() — IAM + env per kind', () => {
	function fnStack() {
		const stack = new cdk.Stack(new cdk.App(), 'S', { env: { account: '111111111111', region: 'us-east-1' } });
		const fn = new lambda.Function(stack, 'Fn', {
			runtime: lambda.Runtime.NODEJS_20_X,
			handler: 'index.handler',
			code: lambda.Code.fromInline('exports.handler=()=>{}'),
		});
		return { stack, fn };
	}

	void it('secret → Secrets Manager: HOSTING_SECRET_PARAM_* + secretsmanager:GetSecretValue + kms', () => {
		const { stack, fn } = fnStack();
		wireManagedValue(fn, secret('STRIPE_KEY'), { secretStore: { prefix: '/blocks/secrets' } });
		const t = Template.fromStack(stack);
		t.hasResourceProperties('AWS::Lambda::Function', {
			Environment: {
				Variables: Match.objectLike({ HOSTING_SECRET_PARAM_STRIPE_KEY: 'blocks/secrets/STRIPE_KEY' }),
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
	});

	void it('config → SSM: HOSTING_CONFIG_PARAM_* (leading slash) + ssm:GetParameter', () => {
		const { stack, fn } = fnStack();
		wireManagedValue(fn, config('FEATURE_FLAGS'), { configStore: { prefix: '/blocks/config' } });
		const t = Template.fromStack(stack);
		t.hasResourceProperties('AWS::Lambda::Function', {
			Environment: {
				Variables: Match.objectLike({ HOSTING_CONFIG_PARAM_FEATURE_FLAGS: '/blocks/config/FEATURE_FLAGS' }),
			},
		});
		t.hasResourceProperties('AWS::IAM::Policy', {
			PolicyDocument: { Statement: Match.arrayWith([Match.objectLike({ Action: 'ssm:GetParameter' })]) },
		});
	});

	void it('stage: injects fallback env + grants both ARNs; single kms:Decrypt', () => {
		const { stack, fn } = fnStack();
		wireManagedValue(fn, config('FLAGS'), { configStore: { prefix: '/blocks/config', stage: 'prod' } });
		const json = JSON.stringify(Template.fromStack(stack).toJSON());
		assert.ok(json.includes('/blocks/config/prod/FLAGS'), 'stage locator');
		assert.ok(json.includes('HOSTING_CONFIG_PARAM_FLAGS_FALLBACK'), 'fallback env');
		assert.strictEqual((json.match(/kms:Decrypt/g) ?? []).length, 1);
	});

	void it('injects the per-kind cache TTL when configured', () => {
		const { stack, fn } = fnStack();
		wireManagedValue(fn, config('FLAGS'), { configStore: { prefix: '/p', cacheTtlSeconds: 30 } });
		const json = JSON.stringify(Template.fromStack(stack).toJSON());
		assert.ok(json.includes('"HOSTING_CONFIG_CACHE_TTL":"30"'), 'config TTL env');
	});
});

void describe('wireByo() — existing handles', () => {
	function fnStack() {
		const stack = new cdk.Stack(new cdk.App(), 'S', { env: { account: '111111111111', region: 'us-east-1' } });
		const fn = new lambda.Function(stack, 'Fn', {
			runtime: lambda.Runtime.NODEJS_20_X,
			handler: 'index.handler',
			code: lambda.Code.fromInline('exports.handler=()=>{}'),
		});
		return { stack, fn };
	}

	void it('BYO ISecret → grant + HOSTING_SECRET_PARAM_* = secretName', () => {
		const { stack, fn } = fnStack();
		const s = Secret.fromSecretNameV2(stack, 'S1', 'prod/stripe');
		wireByo(fn, { key: 'STRIPE_KEY', kind: 'secret', handle: s });
		const t = Template.fromStack(stack);
		t.hasResourceProperties('AWS::Lambda::Function', {
			Environment: { Variables: Match.objectLike({ HOSTING_SECRET_PARAM_STRIPE_KEY: 'prod/stripe' }) },
		});
		t.hasResourceProperties('AWS::IAM::Policy', {
			PolicyDocument: {
				Statement: Match.arrayWith([
					Match.objectLike({ Action: Match.arrayWith(['secretsmanager:GetSecretValue']) }),
				]),
			},
		});
	});

	void it('BYO IParameter → grant + HOSTING_CONFIG_PARAM_* = parameterName', () => {
		const { stack, fn } = fnStack();
		const p = StringParameter.fromStringParameterName(stack, 'P1', '/prod/flag');
		wireByo(fn, { key: 'FLAG', kind: 'config', handle: p });
		const t = Template.fromStack(stack);
		t.hasResourceProperties('AWS::Lambda::Function', {
			Environment: { Variables: Match.objectLike({ HOSTING_CONFIG_PARAM_FLAG: '/prod/flag' }) },
		});
	});
});
