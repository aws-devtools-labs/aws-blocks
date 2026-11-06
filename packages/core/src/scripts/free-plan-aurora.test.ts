// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import type { TemplateResource } from './cloud-assembly.js';
import {
	assertFreePlanAurora,
	type FreePlanAuroraCheckOptions,
	type FreePlanAuroraVerdict,
	freePlanAuroraVerdict,
} from './free-plan-aurora.js';

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

describe('assertFreePlanAurora', () => {
	/** The account the credential check verified, and another one. */
	const CALLER = '111111111111';
	const OTHER = '222222222222';
	let dir: string;
	let warnings: string[];

	/** A one-stack assembly with the given resources, environment-agnostic unless `environment` is given. */
	function assembly(resources: Record<string, TemplateResource>, environment?: string): string {
		writeFileSync(
			join(dir, 'manifest.json'),
			JSON.stringify({
				artifacts: {
					App: {
						type: 'aws:cloudformation:stack',
						environment: environment ?? 'aws://unknown-account/unknown-region',
						properties: { templateFile: 'App.template.json', stackName: 'shop-prod' },
					},
				},
			}),
		);
		writeFileSync(join(dir, 'App.template.json'), JSON.stringify({ Resources: resources }));
		return dir;
	}

	const check = (assemblyDir: string, options: Partial<FreePlanAuroraCheckOptions> = {}) =>
		assertFreePlanAurora({
			accountPlan: 'FREE',
			account: CALLER,
			assemblyDir,
			invocation: 'npm run deploy',
			...options,
		});

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), 'blocks-free-plan-aurora-'));
		warnings = [];
		mock.method(console, 'warn', (...args: unknown[]) => warnings.push(args.join(' ')));
	});

	afterEach(() => {
		mock.restoreAll();
		rmSync(dir, { recursive: true, force: true });
	});

	it('stops a Free-plan deploy and names every blocked cluster by construct path, or logical id', () => {
		const assemblyDir = assembly({
			ShopCluster: aurora({}, { Metadata: { 'aws:cdk:path': 'shop-prod/shop/cluster/Resource' } }),
			RawCluster: aurora(),
			Express: aurora({ WithExpressConfiguration: true }),
		});
		assert.throws(
			() => check(assemblyDir),
			(error: Error) => {
				assert.match(error.message, /^`npm run deploy` stopped before deploying/);
				const listed = error.message.split('\n').filter((line) => line.startsWith('    shop-prod: '));
				assert.deepEqual(listed, [
					'    shop-prod: shop-prod/shop/cluster/Resource',
					'    shop-prod: RawCluster',
				]);
				assert.match(error.message, /Then re-run `npm run deploy`\.$/);
				return true;
			},
		);
	});

	it('stops a stack that names the verified account', () => {
		const assemblyDir = assembly({ Cluster: aurora() }, `aws://${CALLER}/eu-north-1`);
		assert.throws(() => check(assemblyDir), /shop-prod \(account 111111111111\): Cluster/);
	});

	it('warns and continues for a stack that deploys to another account, whose plan was not read', () => {
		const assemblyDir = assembly({ Cluster: aurora() }, `aws://${OTHER}/eu-north-1`);
		check(assemblyDir);
		assert.equal(warnings.length, 1);
		assert.match(warnings[0] ?? '', /in stacks that name another account/);
		assert.match(warnings[0] ?? '', /\n {4}shop-prod \(account 222222222222\): Cluster\n/);
	});

	it('does not stop a stack that names an account when the verified account is unknown', () => {
		const assemblyDir = assembly({ Cluster: aurora() }, `aws://${CALLER}/eu-north-1`);
		check(assemblyDir, { account: null });
		assert.equal(warnings.length, 1);
		assert.match(warnings[0] ?? '', /in stacks that name another account/);
	});

	it('still stops an environment-agnostic stack when the verified account is unknown', () => {
		assert.throws(() => check(assembly({ Cluster: aurora() }), { account: null }), /stopped before deploying/);
	});

	it('warns and continues when the outcome is decided at deploy time', () => {
		const assemblyDir = assembly({ Cluster: aurora({ Engine: { Ref: 'Engine' } }) });
		check(assemblyDir, { invocation: 'npm run sandbox' });
		assert.equal(warnings.length, 1);
		assert.match(warnings[0] ?? '', /`npm run sandbox` continues:\n {4}shop-prod: Cluster\n/);
	});

	it('stops when one cluster is blocked even if another is undecided', () => {
		const assemblyDir = assembly({ Blocked: aurora(), Undecided: aurora({}, { Condition: 'Maybe' }) });
		assert.throws(() => check(assemblyDir));
	});

	for (const accountPlan of ['PAID', null] as const) {
		it(`does nothing when the plan is ${accountPlan ?? 'unavailable'}`, () => {
			const assemblyDir = assembly({ Cluster: aurora(), Undecided: aurora({ Engine: { Ref: 'Engine' } }) });
			check(assemblyDir, { accountPlan });
			assert.deepEqual(warnings, []);
		});
	}

	it('does nothing on a Free plan when the assembly has no Aurora cluster', () => {
		const assemblyDir = assembly({
			Fn: { Type: 'AWS::Lambda::Function' },
			MultiAz: aurora({ Engine: 'postgres' }),
		});
		check(assemblyDir);
		assert.deepEqual(warnings, []);
	});
});
