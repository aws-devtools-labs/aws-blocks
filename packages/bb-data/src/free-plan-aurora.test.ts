// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { PredeployContext, SynthesizedStack } from '@aws-blocks/core/scripts';
import { type FreePlanAuroraVerdict, freePlanAuroraVerdict, type TemplateResource } from './free-plan-aurora.js';
import { predeploy } from './predeploy.js';

const aurora = (properties: Record<string, unknown> = {}, extra: Partial<TemplateResource> = {}): TemplateResource => ({
	Type: 'AWS::RDS::DBCluster',
	Properties: { Engine: 'aurora-postgresql', ...properties },
	...extra,
});

describe('freePlanAuroraVerdict', () => {
	const cases: Array<[string, TemplateResource, FreePlanAuroraVerdict]> = [
		['an Aurora PostgreSQL cluster without express configuration', aurora(), 'blocked'],
		['an Aurora MySQL cluster without express configuration', aurora({ Engine: 'aurora-mysql' }), 'blocked'],
		['an Aurora cluster with express configuration off', aurora({ WithExpressConfiguration: false }), 'blocked'],
		[
			'an Aurora cluster with express configuration off as a string',
			aurora({ WithExpressConfiguration: 'false' }),
			'blocked',
		],
		['an Aurora cluster with express configuration', aurora({ WithExpressConfiguration: true }), 'allowed'],
		[
			'an Aurora cluster with express configuration as a string',
			aurora({ WithExpressConfiguration: 'true' }),
			'allowed',
		],
		['an RDS Multi-AZ DB cluster (not Aurora)', aurora({ Engine: 'postgres' }), 'allowed'],
		[
			'a resource of another type',
			{ Type: 'AWS::RDS::DBInstance', Properties: { Engine: 'aurora-postgresql' } },
			'allowed',
		],
		['an engine from a parameter', aurora({ Engine: { Ref: 'Engine' } }), 'undecided'],
		[
			'express configuration from a condition',
			aurora({ WithExpressConfiguration: { 'Fn::If': ['Free', true, false] } }),
			'undecided',
		],
		['a conditional Aurora cluster', aurora({}, { Condition: 'CreateDatabase' }), 'undecided'],
	];
	for (const [name, resource, expected] of cases) {
		it(`${expected}: ${name}`, () => {
			assert.equal(freePlanAuroraVerdict(resource), expected);
		});
	}
});

describe('predeploy (Free-plan Aurora check)', () => {
	/** The account the credential check verified, and another one. */
	const CALLER = '111111111111';
	const OTHER = '222222222222';

	/** A one-stack assembly with the given resources, environment-agnostic unless `account` is given. */
	const stack = (resources: Record<string, TemplateResource>, account?: string): SynthesizedStack => ({
		stackName: 'shop-prod',
		template: { Resources: resources },
		...(account ? { account } : {}),
		nestedStacks: {},
	});

	/** Run the hook as `npm run deploy` does, on a Free-plan account unless `context` says otherwise. */
	async function check(stacks: SynthesizedStack[], context: Partial<PredeployContext> = {}) {
		let synthCalls = 0;
		const result = await predeploy({
			stage: 'production',
			projectRoot: '/app',
			invocation: 'npm run deploy',
			account: { id: CALLER, plan: 'FREE' },
			synth: async () => {
				synthCalls++;
				return stacks;
			},
			...context,
		});
		return { ...result, synthCalls };
	}

	it('stops a Free-plan deploy and names every blocked cluster by construct path, or logical id', async () => {
		const { stops = [], warnings } = await check([
			stack({
				ShopCluster: aurora({}, { Metadata: { 'aws:cdk:path': 'shop-prod/shop/cluster/Resource' } }),
				RawCluster: aurora(),
				Express: aurora({ WithExpressConfiguration: true }),
			}),
		]);
		assert.equal(warnings, undefined);
		assert.equal(stops.length, 1);
		const [message = ''] = stops;
		assert.match(message, /^`npm run deploy` stopped before deploying/);
		const listed = message.split('\n').filter((line) => line.startsWith('    shop-prod: '));
		assert.deepEqual(listed, ['    shop-prod: shop-prod/shop/cluster/Resource', '    shop-prod: RawCluster']);
		assert.match(message, /Then re-run `npm run deploy`\.$/);
	});

	it('stops a stack that names the verified account', async () => {
		const { stops = [] } = await check([stack({ Cluster: aurora() }, CALLER)]);
		assert.match(stops[0] ?? '', /shop-prod \(account 111111111111\): Cluster/);
	});

	it('warns and continues for a stack that deploys to another account, whose plan was not read', async () => {
		const { stops, warnings = [] } = await check([stack({ Cluster: aurora() }, OTHER)]);
		assert.equal(stops, undefined);
		assert.equal(warnings.length, 1);
		assert.match(warnings[0] ?? '', /in stacks that name another account/);
		assert.match(warnings[0] ?? '', /\n {4}shop-prod \(account 222222222222\): Cluster\n/);
	});

	it('does not stop a stack that names an account when the verified account is unknown', async () => {
		const { stops, warnings = [] } = await check([stack({ Cluster: aurora() }, CALLER)], {
			account: { id: null, plan: 'FREE' },
		});
		assert.equal(stops, undefined);
		assert.match(warnings[0] ?? '', /in stacks that name another account/);
	});

	it('still stops an environment-agnostic stack when the verified account is unknown', async () => {
		const { stops = [] } = await check([stack({ Cluster: aurora() })], { account: { id: null, plan: 'FREE' } });
		assert.match(stops[0] ?? '', /stopped before deploying/);
	});

	it('warns and continues when the outcome is decided at deploy time', async () => {
		const { stops, warnings = [] } = await check([stack({ Cluster: aurora({ Engine: { Ref: 'Engine' } }) })], {
			stage: 'sandbox',
			invocation: 'npm run sandbox',
		});
		assert.equal(stops, undefined);
		assert.equal(warnings.length, 1);
		assert.match(warnings[0] ?? '', /`npm run sandbox` continues:\n {4}shop-prod: Cluster\n/);
	});

	it('names the command by stage when the runner gives no invocation', async () => {
		const { stops = [] } = await check([stack({ Cluster: aurora() })], { stage: 'sandbox', invocation: undefined });
		assert.match(stops[0] ?? '', /^`npm run sandbox` stopped before deploying/);
	});

	it('stops when one cluster is blocked even if another is undecided', async () => {
		const { stops = [] } = await check([
			stack({ Blocked: aurora(), Undecided: aurora({}, { Condition: 'Maybe' }) }),
		]);
		assert.equal(stops.length, 1);
	});

	for (const plan of ['PAID', null] as const) {
		it(`does nothing, and reads no template, when the plan is ${plan ?? 'unavailable'}`, async () => {
			const stacks = [stack({ Cluster: aurora(), Undecided: aurora({ Engine: { Ref: 'Engine' } }) })];
			assert.deepEqual(await check(stacks, { account: { id: CALLER, plan } }), { synthCalls: 0 });
		});
	}

	it('does nothing when the runner reports no account (a core that does not pass one)', async () => {
		assert.deepEqual(await check([stack({ Cluster: aurora() })], { account: undefined }), { synthCalls: 0 });
	});

	it('does nothing on a Free plan when the assembly has no Aurora cluster', async () => {
		const result = await check([
			stack({ Fn: { Type: 'AWS::Lambda::Function' }, MultiAz: aurora({ Engine: 'postgres' }) }),
		]);
		assert.deepEqual(result, { warnings: [], synthCalls: 1 });
	});

	describe('nested stacks', () => {
		/** A parent stack whose nested stack `Child` holds an Aurora cluster. */
		const parent = (childResource: TemplateResource, account?: string): SynthesizedStack => ({
			stackName: 'Parent',
			template: { Resources: { Child: childResource } },
			...(account ? { account } : {}),
			nestedStacks: {
				Child: {
					template: {
						Resources: { Db: aurora({}, { Metadata: { 'aws:cdk:path': 'Parent/Child/Db/Resource' } }) },
					},
					nestedStacks: {},
				},
			},
		});
		const nestedStack: TemplateResource = { Type: 'AWS::CloudFormation::Stack' };

		it('stops on an Aurora cluster in a nested stack', async () => {
			const { stops = [] } = await check([parent(nestedStack)]);
			assert.match(stops[0] ?? '', /^ {4}Parent: Parent\/Child\/Db\/Resource$/m);
		});

		it('warns instead of stopping when an enclosing nested stack is conditional', async () => {
			const { stops, warnings = [] } = await check([parent({ ...nestedStack, Condition: 'CreateDb' })]);
			assert.equal(stops, undefined);
			assert.match(warnings[0] ?? '', /decided at deploy time[\s\S]*Parent: Parent\/Child\/Db\/Resource/);
		});

		it('gives nested stacks the target account of their parent', async () => {
			const { warnings = [] } = await check([parent(nestedStack, OTHER)]);
			assert.match(warnings[0] ?? '', /Parent \(account 222222222222\): Parent\/Child\/Db\/Resource/);
		});
	});
});
