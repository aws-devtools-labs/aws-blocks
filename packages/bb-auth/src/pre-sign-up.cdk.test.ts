// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Decision Q10, CDK side: `validateUser` provisions the pool's Cognito
 * PreSignUp trigger — and nothing else changes. Real synth under
 * `--conditions=cdk` (see `test-support/cdk-synth.ts`), plus a real
 * `BlocksStack` app (`test-support/blocks-app-synth.ts`) for the dependency
 * cycle the trigger would otherwise create.
 *
 * With the option unset the template is untouched: that is pinned by the
 * frozen fixtures (`resource-identity.cdk.test.ts`,
 * `property-snapshot.cdk.test.ts`) and the D4 guard tests, none of which set
 * it; the first test below checks the absence directly.
 */

import assert from 'node:assert';
import { rmSync } from 'node:fs';
import { after, describe, test } from 'node:test';
import { ownsPreSignUpTrigger, preSignUpTriggerConfigKey } from './cdk/contract.js';
import { synthBlocksApp } from './test-support/blocks-app-synth.js';
import { type CfnResourceJson, type CfnTemplateJson, synthUnderCdkConditions } from './test-support/cdk-synth.js';
import { freshAppDir } from './test-support/guard-synth.js';

const IMPORTS = "import { Auth } from '@aws-blocks/bb-auth';";
const VALIDATE = "validateUser: async () => { throw new Error('no'); }";

function synth(build: string) {
	return synthUnderCdkConditions({ imports: IMPORTS, build });
}

function byType(template: CfnTemplateJson, type: string): [string, CfnResourceJson][] {
	return Object.entries(template.Resources).filter(([, r]) => r.Type === type);
}

function onlyOne(template: CfnTemplateJson, type: string): [string, CfnResourceJson] {
	const found = byType(template, type);
	assert.strictEqual(found.length, 1, `expected one ${type}, found ${found.map(([id]) => id).join(', ')}`);
	return found[0] as [string, CfnResourceJson];
}

function logicalIdOf(template: CfnTemplateJson, pathSuffix: string): string {
	const hit = Object.entries(template.Resources).find(([, r]) =>
		String(r.Metadata?.['aws:cdk:path'] ?? '').endsWith(pathSuffix),
	);
	assert.ok(hit, `no resource at …${pathSuffix}`);
	return hit[0];
}

type Statement = { Action: string | string[]; Resource: unknown };
function statementsOf(policy: CfnResourceJson): Statement[] {
	return (policy.Properties?.PolicyDocument as { Statement: Statement[] }).Statement;
}
function cognitoStatements(policy: CfnResourceJson): Statement[] {
	return statementsOf(policy).filter((s) => [s.Action].flat().some((a) => a.startsWith('cognito-idp:')));
}

/** Every logical id a resource refers to: `Ref`, `Fn::GetAtt`, `Fn::Sub` and `DependsOn`. */
function referencesOf(resource: CfnResourceJson, ids: ReadonlySet<string>): Set<string> {
	const out = new Set<string>();
	const walk = (v: unknown): void => {
		if (Array.isArray(v)) {
			for (const x of v) walk(x);
			return;
		}
		if (typeof v !== 'object' || v === null) return;
		for (const [k, x] of Object.entries(v)) {
			if (k === 'Ref' && typeof x === 'string' && ids.has(x)) out.add(x);
			else if (k === 'Fn::GetAtt' && Array.isArray(x) && typeof x[0] === 'string' && ids.has(x[0])) out.add(x[0]);
			else if (k === 'Fn::Sub') {
				const text = Array.isArray(x) ? x[0] : x;
				if (typeof text === 'string') {
					for (const m of text.matchAll(/\$\{([A-Za-z0-9]+)(?:\.[^}]*)?\}/g))
						if (m[1] && ids.has(m[1])) out.add(m[1]);
				}
				walk(x);
			} else walk(x);
		}
	};
	walk(resource.Properties);
	for (const d of [resource.DependsOn ?? []].flat()) if (typeof d === 'string' && ids.has(d)) out.add(d);
	return out;
}

/** A dependency cycle in the template (as CloudFormation would see it), or `null`. */
function findCycle(template: CfnTemplateJson): string[] | null {
	const ids = new Set(Object.keys(template.Resources));
	const edges = new Map([...ids].map((id) => [id, referencesOf(template.Resources[id] as CfnResourceJson, ids)]));
	const state = new Map<string, 'visiting' | 'done'>();
	const stack: string[] = [];
	const visit = (id: string): string[] | null => {
		state.set(id, 'visiting');
		stack.push(id);
		for (const next of edges.get(id) ?? []) {
			if (state.get(next) === 'visiting') return [...stack.slice(stack.indexOf(next)), next];
			if (!state.has(next)) {
				const cycle = visit(next);
				if (cycle) return cycle;
			}
		}
		stack.pop();
		state.set(id, 'done');
		return null;
	};
	for (const id of ids) {
		if (state.has(id)) continue;
		const cycle = visit(id);
		if (cycle) return cycle;
	}
	return null;
}

describe('Q10: validateUser provisions the PreSignUp trigger (CDK)', () => {
	const unset = synth("new Auth(stack, 'auth', { admin: {} })");
	const set = synth(`new Auth(stack, 'auth', { admin: {}, ${VALIDATE} })`);

	test('unset: no trigger, no permission, the pool grants on the shared role default policy', () => {
		const [, pool] = onlyOne(unset.template, 'AWS::Cognito::UserPool');
		assert.strictEqual(pool.Properties?.LambdaConfig, undefined);
		assert.deepStrictEqual(byType(unset.template, 'AWS::Lambda::Permission'), []);
		assert.ok(!JSON.stringify(unset.template).includes('pre-sign-up'));
		assert.ok(!JSON.stringify(unset.template).includes('pool-access'));
		const defaultPolicy =
			unset.template.Resources[logicalIdOf(unset.template, '/BlocksRole/DefaultPolicy/Resource')];
		assert.ok(defaultPolicy);
		assert.strictEqual(cognitoStatements(defaultPolicy).length, 2);
	});

	test('set: LambdaConfig.PreSignUp is the shared backend Lambda', () => {
		const [, pool] = onlyOne(set.template, 'AWS::Cognito::UserPool');
		const handler = logicalIdOf(set.template, '/Handler/Resource');
		assert.deepStrictEqual(pool.Properties?.LambdaConfig, { PreSignUp: { 'Fn::GetAtt': [handler, 'Arn'] } });
	});

	test('set: one invoke permission, for cognito-idp, scoped to this pool (SourceArn) and account', () => {
		const [id, permission] = onlyOne(set.template, 'AWS::Lambda::Permission');
		assert.match(String(permission.Metadata?.['aws:cdk:path']), /\/auth\/pre-sign-up-permission$/);
		const pool = logicalIdOf(set.template, '/auth/pool/Resource');
		const handler = logicalIdOf(set.template, '/Handler/Resource');
		assert.deepStrictEqual(
			permission.Properties,
			{
				Action: 'lambda:InvokeFunction',
				FunctionName: { 'Fn::GetAtt': [handler, 'Arn'] },
				Principal: 'cognito-idp.amazonaws.com',
				SourceAccount: { Ref: 'AWS::AccountId' },
				SourceArn: { 'Fn::GetAtt': [pool, 'Arn'] },
			},
			id,
		);
	});

	test('set: the same pool grants, moved to a separate pool-access policy on the same role', () => {
		const pool = logicalIdOf(set.template, '/auth/pool/Resource');
		const role = logicalIdOf(set.template, '/BlocksRole/Resource');
		const defaultPolicy = set.template.Resources[logicalIdOf(set.template, '/BlocksRole/DefaultPolicy/Resource')];
		assert.ok(defaultPolicy);
		assert.deepStrictEqual(cognitoStatements(defaultPolicy), []);
		const poolAccess = set.template.Resources[logicalIdOf(set.template, '/auth/pool-access/Resource')];
		assert.ok(poolAccess);
		assert.deepStrictEqual(poolAccess.Properties?.Roles, [{ Ref: role }]);
		const unsetDefault =
			unset.template.Resources[logicalIdOf(unset.template, '/BlocksRole/DefaultPolicy/Resource')];
		assert.ok(unsetDefault);
		// Byte-identical statements (same actions, same pool ARN — no wildcard).
		assert.deepStrictEqual(statementsOf(poolAccess), cognitoStatements(unsetDefault));
		for (const s of statementsOf(poolAccess)) assert.deepStrictEqual(s.Resource, { 'Fn::GetAtt': [pool, 'Arn'] });
	});

	test('set: nothing else changes — pool properties other than LambdaConfig, and every other resource', () => {
		const [unsetPoolId, unsetPool] = onlyOne(unset.template, 'AWS::Cognito::UserPool');
		const [setPoolId, setPool] = onlyOne(set.template, 'AWS::Cognito::UserPool');
		assert.strictEqual(setPoolId, unsetPoolId, 'the pool keeps its logical id (no replacement)');
		const { LambdaConfig: _ignored, ...setRest } = setPool.Properties ?? {};
		assert.deepStrictEqual(setRest, unsetPool.Properties);
		assert.deepStrictEqual(setPool.DependsOn, unsetPool.DependsOn);
		const added = Object.keys(set.template.Resources).filter((id) => !(id in unset.template.Resources));
		const removed = Object.keys(unset.template.Resources).filter((id) => !(id in set.template.Resources));
		assert.deepStrictEqual(removed, []);
		assert.deepStrictEqual(
			added
				.map((id) =>
					String(set.template.Resources[id]?.Metadata?.['aws:cdk:path']).replace(/^\/?TestStack\//, ''),
				)
				.sort(),
			['auth/pool-access/Resource', 'auth/pre-sign-up-permission'],
		);
		// One new config key: the trigger-owner flag the runtime registers its handler from (R2-1).
		assert.deepStrictEqual(
			set.config,
			{ ...unset.config, [preSignUpTriggerConfigKey('TestStack-auth')]: 'true' },
			'only the trigger-owner flag is added',
		);
	});

	test('set: the template has no dependency cycle (unset has none either)', () => {
		assert.strictEqual(findCycle(unset.template), null);
		assert.deepStrictEqual(findCycle(set.template), null);
	});

	test('the cycle detector does see the cycle the default policy would form', () => {
		// Same template, with the pool grants put back on the role's default policy.
		const template: CfnTemplateJson = structuredClone(set.template);
		const pool = logicalIdOf(template, '/auth/pool/Resource');
		const defaultPolicy = template.Resources[logicalIdOf(template, '/BlocksRole/DefaultPolicy/Resource')];
		assert.ok(defaultPolicy);
		statementsOf(defaultPolicy).push({ Action: 'cognito-idp:SignUp', Resource: { 'Fn::GetAtt': [pool, 'Arn'] } });
		const cycle = findCycle(template);
		assert.ok(cycle, 'expected a cycle');
		assert.ok(cycle.includes(pool));
	});

	test('two blocks on one shared Lambda: one trigger and one permission each, no id collision', () => {
		const { template } = synth(
			`new Auth(stack, 'a', { ${VALIDATE} }); new Auth(stack, 'b', { ${VALIDATE} }); new Auth(stack, 'c');`,
		);
		const permissions = byType(template, 'AWS::Lambda::Permission');
		assert.strictEqual(permissions.length, 2);
		const sourcePools = permissions.map(
			([, p]) => (p.Properties?.SourceArn as { 'Fn::GetAtt': string[] })['Fn::GetAtt'][0],
		);
		assert.deepStrictEqual(
			sourcePools.sort(),
			[logicalIdOf(template, '/a/pool/Resource'), logicalIdOf(template, '/b/pool/Resource')].sort(),
		);
		const c = template.Resources[logicalIdOf(template, '/c/pool/Resource')];
		assert.strictEqual(c?.Properties?.LambdaConfig, undefined);
		assert.strictEqual(findCycle(template), null);
	});

	test('a wrapped pool (userPool) gets no trigger, and a synth warning says why', () => {
		const result = synth(
			`new Auth(stack, 'auth', { userPool: Auth.fromExisting('us-east-1_existing', 'client-1'), ${VALIDATE} })`,
		);
		assert.deepStrictEqual(byType(result.template, 'AWS::Lambda::Permission'), []);
		assert.deepStrictEqual(byType(result.template, 'AWS::Cognito::UserPool'), []);
		const warning = result.warnings.find((w) => w.message.includes('ValidateUserExternalPool'));
		assert.ok(warning, JSON.stringify(result.warnings));
		assert.match(warning.message, /no PreSignUp trigger is attached/);
	});

	test('R2-1: only the trigger owner gets the runtime flag that registers its handler', () => {
		const { config } = synth(
			`new Auth(stack, 'owner', { ${VALIDATE} }); new Auth(stack, 'plain');` +
				` new Auth(stack, 'wrapper', { userPool: Auth.fromExisting('us-east-1_existing', 'client-1'), admin: {} });` +
				` new Auth(stack, 'wrapval', { userPool: Auth.fromExisting('us-east-1_existing', 'client-1'), ${VALIDATE} });` +
				` new Auth(stack, 'poolless', { emailPassword: false, oidcProviders: { okta: { issuer: 'https://dev-1.okta.com', clientId: '0oa1' } }, ${VALIDATE} });`,
		);
		const flags = Object.keys(config).filter((k) => k.endsWith('_PRE_SIGN_UP_TRIGGER'));
		assert.strictEqual(flags.length, 1, flags.join(', '));
		const [flag] = flags;
		assert.match(flag ?? '', /^BLOCKS_AUTH_COGNITO_.*_OWNER_PRE_SIGN_UP_TRIGGER$/);
		assert.strictEqual(config[flag ?? ''], 'true');
	});

	test('R2-1: the flag key is the one the runtime reads', () => {
		assert.strictEqual(
			preSignUpTriggerConfigKey('my-app-auth'),
			'BLOCKS_AUTH_COGNITO_MY_APP_AUTH_PRE_SIGN_UP_TRIGGER',
		);
		assert.strictEqual(ownsPreSignUpTrigger({ validateUser: async () => {} }), true);
		assert.strictEqual(ownsPreSignUpTrigger({}), false);
		assert.strictEqual(
			ownsPreSignUpTrigger({
				userPool: { __brand: 'ExternalUserPoolRef', userPoolId: 'p' },
				validateUser: async () => {},
			}),
			false,
		);
	});

	test('no pool (directly federated OIDC only): no trigger', () => {
		const { template } = synth(
			`new Auth(stack, 'auth', { emailPassword: false, oidcProviders: { okta: { issuer: 'https://dev-1.okta.com', clientId: '0oa1' } }, ${VALIDATE} })`,
		);
		assert.deepStrictEqual(byType(template, 'AWS::Lambda::Permission'), []);
		assert.deepStrictEqual(byType(template, 'AWS::Cognito::UserPool'), []);
	});

	test('social federation + validateUser: trigger on the pool, still no cycle', () => {
		const { template } = synthUnderCdkConditions({
			imports: `${IMPORTS}\nimport { AppSetting } from '@aws-blocks/bb-app-setting';`,
			build: `new Auth(stack, 'auth', { socialProviders: { google: { clientId: 'g', clientSecret: new AppSetting(stack, 'g-secret', { secret: true }) } }, ${VALIDATE} })`,
		});
		const [, pool] = onlyOne(template, 'AWS::Cognito::UserPool');
		assert.ok(pool.Properties?.LambdaConfig);
		assert.strictEqual(findCycle(template), null);
	});
});

describe('Q10: a real BlocksStack app with validateUser synthesizes with no cycle', () => {
	const dirs: string[] = [];
	after(() => {
		for (const d of dirs) rmSync(d, { recursive: true, force: true });
	});

	test('pool → shared Lambda → role → pool is broken', () => {
		const appDir = freshAppDir();
		dirs.push(appDir);
		const result = synthBlocksApp({ build: `new Auth(stack, 'auth', { admin: {}, ${VALIDATE} });`, appDir });
		assert.ok(result.ok, result.stderr);
		assert.ok(result.template);
		const [, pool] = onlyOne(result.template, 'AWS::Cognito::UserPool');
		const target = (pool.Properties?.LambdaConfig as { PreSignUp: { 'Fn::GetAtt': string[] } }).PreSignUp[
			'Fn::GetAtt'
		];
		const fn = result.template.Resources[target[0] ?? ''];
		// The default compute's function, which runs as the shared `BlocksRole`.
		assert.strictEqual(fn?.Type, 'AWS::Lambda::Function');
		const role = (fn.Properties?.Role as { 'Fn::GetAtt': string[] })['Fn::GetAtt'][0] ?? '';
		assert.match(role, /^BlocksRole/);
		assert.strictEqual(findCycle(result.template), null);
	});
});
