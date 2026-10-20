// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert';
import { describe, test } from 'node:test';
import { BINDINGS_METADATA_KEY } from './constants.js';
import {
	bindingStops,
	type CfnTemplate,
	changeSetStops,
	clusterRemovalPolicy,
	guardDeploy,
	TEMPLATE_BODY_LIMIT,
} from './deploy-guard.js';

const templateWith = (bindings: unknown, resources: NonNullable<CfnTemplate['Resources']> = {}) => ({
	Metadata: { [BINDINGS_METADATA_KEY]: bindings },
	Resources: resources,
});

const dsql = (deletion: 'Retain' | 'Delete') => ({ Type: 'AWS::DSQL::Cluster', DeletionPolicy: deletion });
const remove = (id: string, type = 'AWS::DSQL::Cluster') => ({
	ResourceChange: { Action: 'Remove' as const, ResourceType: type, LogicalResourceId: id },
});

describe('deploy guard: binding record', () => {
	test('a block moving from its owned cluster to a shared one is a stop, with the deployed removal policy', () => {
		const deployed = templateWith(
			{
				databases: { 'app-orders': { cluster: 'default', type: 'distributed', resource: 'OrdersDsql' } },
				clusters: {},
			},
			{ OrdersDsql: dsql('Retain') },
		);
		const next = templateWith({
			databases: { 'app-orders': { cluster: 'app-main', type: 'distributed' } },
			clusters: { 'app-main': { type: 'distributed', resource: 'MainDsql' } },
		});
		const stops = bindingStops(deployed, next);
		assert.strictEqual(stops.length, 1);
		assert.match(stops[0], /Deploy stopped: Database 'app-orders' is bound to its default cluster \(distributed\)/);
		assert.match(stops[0], /cannot move to 'app-main' \(distributed\)/);
		assert.match(stops[0], /removal policy: retain/);
	});

	test('a block moving between two shared clusters is a stop', () => {
		const deployed = templateWith({
			databases: { 'app-orders': { cluster: 'app-a', type: 'distributed' } },
			clusters: {
				'app-a': { type: 'distributed', resource: 'A' },
				'app-b': { type: 'distributed', resource: 'B' },
			},
		});
		const next = templateWith({
			databases: { 'app-orders': { cluster: 'app-b', type: 'distributed' } },
			clusters: {
				'app-a': { type: 'distributed', resource: 'A' },
				'app-b': { type: 'distributed', resource: 'B' },
			},
		});
		assert.match(bindingStops(deployed, next)[0], /is bound to 'app-a' \(distributed\) and cannot move to 'app-b'/);
	});

	test('a first deploy, an unchanged record, and a deleted block pass', () => {
		const next = templateWith({
			databases: { 'app-db': { cluster: 'default', type: 'distributed', resource: 'DbDsql' } },
			clusters: {},
		});
		assert.deepStrictEqual(bindingStops(undefined, next), []);
		assert.deepStrictEqual(bindingStops(next, next), []);
		assert.deepStrictEqual(bindingStops(next, templateWith({ databases: {}, clusters: {} })), []);
	});
});

describe('deploy guard: change-set backstop', () => {
	const deployedBindings = {
		databases: {
			'app-orders': { cluster: 'default', type: 'distributed', resource: 'OrdersDsql' },
			'app-shared': { cluster: 'app-main', type: 'distributed' },
		},
		clusters: { 'app-main': { type: 'distributed', resource: 'MainDsql' } },
	};

	test('deleting a block that owns a retained cluster passes, with a note', () => {
		const deployed = templateWith(deployedBindings, { OrdersDsql: dsql('Retain'), MainDsql: dsql('Retain') });
		const next = templateWith({
			databases: { 'app-shared': deployedBindings.databases['app-shared'] },
			clusters: deployedBindings.clusters,
		});
		const result = changeSetStops([remove('OrdersDsql')], next, deployed);
		assert.deepStrictEqual(result.stops, []);
		assert.match(result.notes[0], /'OrdersDsql' goes with the block that owned it; its data is retained/);
	});

	test('deleting a block whose cluster would be deleted stops', () => {
		const deployed = templateWith(deployedBindings, { OrdersDsql: dsql('Delete'), MainDsql: dsql('Retain') });
		const next = templateWith({
			databases: { 'app-shared': deployedBindings.databases['app-shared'] },
			clusters: deployedBindings.clusters,
		});
		const result = changeSetStops([remove('OrdersDsql')], next, deployed);
		assert.strictEqual(result.stops.length, 1);
		assert.match(result.stops[0], /would remove AWS::DSQL::Cluster 'OrdersDsql'\. Its data would be deleted\./);
		assert.match(result.stops[0], /removalPolicy: 'retain' on the block first/);
	});

	test('removing a cluster whose block is still in the record (a renamed construct) stops even when retained', () => {
		const deployed = templateWith(deployedBindings, { OrdersDsql: dsql('Retain'), MainDsql: dsql('Retain') });
		const next = templateWith({
			...deployedBindings,
			databases: {
				...deployedBindings.databases,
				'app-orders': { cluster: 'default', type: 'distributed', resource: 'OrdersDsqlRenamed' },
			},
		});
		const result = changeSetStops([remove('OrdersDsql')], next, deployed);
		assert.strictEqual(result.stops.length, 1);
		assert.match(result.stops[0], /would be retained \(removal policy: retain\)/);
		assert.match(result.stops[0], /A Database keeps its cluster for life/);
	});

	test('a Replace of a cluster resource stops; other resources and non-replacing modifies pass', () => {
		const deployed = templateWith(deployedBindings, { OrdersDsql: dsql('Retain'), MainDsql: dsql('Retain') });
		const result = changeSetStops(
			[
				{
					ResourceChange: {
						Action: 'Modify',
						Replacement: 'True',
						ResourceType: 'AWS::DSQL::Cluster',
						LogicalResourceId: 'MainDsql',
					},
				},
				{
					ResourceChange: {
						Action: 'Modify',
						Replacement: 'False',
						ResourceType: 'AWS::DSQL::Cluster',
						LogicalResourceId: 'OrdersDsql',
					},
				},
				remove('Fn', 'AWS::Lambda::Function'),
			],
			templateWith(deployedBindings),
			deployed,
		);
		assert.strictEqual(result.stops.length, 1);
		assert.match(result.stops[0], /would replace AWS::DSQL::Cluster 'MainDsql'/);
	});

	test('Aurora clusters stay guarded', () => {
		const deployed = templateWith({ databases: {}, clusters: {} }, { Aurora: { Type: 'AWS::RDS::DBCluster' } });
		const result = changeSetStops(
			[remove('Aurora', 'AWS::RDS::DBCluster')],
			templateWith({ databases: {}, clusters: {} }),
			deployed,
		);
		assert.match(result.stops[0], /would remove AWS::RDS::DBCluster 'Aurora'\. Its data would be deleted/);
	});

	test('helpers', () => {
		assert.strictEqual(clusterRemovalPolicy({ Resources: { A: dsql('Delete') } }), 'delete');
		assert.strictEqual(
			clusterRemovalPolicy({ Resources: { A: { Type: 'AWS::DSQL::Cluster' } } }),
			'delete',
			'no policy means CloudFormation deletes',
		);
		assert.strictEqual(clusterRemovalPolicy({ Resources: { A: dsql('Retain'), B: dsql('Delete') } }), 'retain');
	});
});

/** A scripted CloudFormation + S3 client pair: records every command and answers from a table. */
function fakeClients(deployedTemplate: unknown, changes: unknown[]) {
	const sent: { name: string; input: Record<string, unknown> }[] = [];
	const cloudFormation = {
		async send(command: { constructor: { name: string }; input: Record<string, unknown> }) {
			sent.push({ name: command.constructor.name, input: command.input });
			switch (command.constructor.name) {
				case 'DescribeStacksCommand':
					if (command.input.StackName === 'CDKToolkit') {
						return {
							Stacks: [
								{
									Outputs: [
										{ OutputKey: 'BucketName', OutputValue: 'cdk-assets' },
										{
											OutputKey: 'BucketDomainName',
											OutputValue: 'cdk-assets.s3.us-east-1.amazonaws.com',
										},
									],
								},
							],
						};
					}
					return { Stacks: [{ Parameters: [] }] };
				case 'GetTemplateCommand':
					return { TemplateBody: JSON.stringify(deployedTemplate) };
				case 'CreateChangeSetCommand':
					return {};
				case 'DescribeChangeSetCommand':
					return { Status: 'CREATE_COMPLETE', Changes: changes };
				default:
					return {};
			}
		},
	};
	const s3 = {
		async send(command: { constructor: { name: string }; input: Record<string, unknown> }) {
			sent.push({ name: command.constructor.name, input: command.input });
			return {};
		},
	};
	return { cloudFormation, s3, sent };
}

describe('deploy guard: guardDeploy', () => {
	const deployed = templateWith(
		{ databases: { 'app-db': { cluster: 'default', type: 'distributed', resource: 'DbDsql' } }, clusters: {} },
		{ DbDsql: dsql('Retain') },
	);

	test('a small template goes inline; a stop from the change set is reported', async () => {
		const next = templateWith({ databases: {}, clusters: {} });
		const { cloudFormation, s3, sent } = fakeClients(deployed, [remove('DbDsql')]);
		const result = await guardDeploy({ stackName: 'App', template: next, cloudFormation, s3, pollMs: 1 });
		const create = sent.find((s) => s.name === 'CreateChangeSetCommand');
		assert.ok(create?.input.TemplateBody, 'inline body');
		assert.strictEqual(create?.input.TemplateURL, undefined);
		// The owning block is gone and the deployed policy is Retain: allowed, noted.
		assert.deepStrictEqual(result.stops, []);
		assert.ok(result.notes.some((n) => /goes with the block that owned it/.test(n)));
		assert.ok(
			sent.some((s) => s.name === 'DeleteChangeSetCommand'),
			'the change set is deleted',
		);
		assert.ok(!sent.some((s) => s.name === 'PutObjectCommand'), 'nothing staged');
	});

	test('an oversized template is staged in the CDK assets bucket and passed by TemplateURL, then deleted', async () => {
		const next = {
			...templateWith(deployed.Metadata[BINDINGS_METADATA_KEY], { DbDsql: dsql('Retain') }),
			Padding: 'x'.repeat(TEMPLATE_BODY_LIMIT),
		};
		const { cloudFormation, s3, sent } = fakeClients(deployed, []);
		const result = await guardDeploy({ stackName: 'App', template: next, cloudFormation, s3, pollMs: 1 });
		assert.deepStrictEqual(result.stops, []);
		const put = sent.find((s) => s.name === 'PutObjectCommand');
		assert.strictEqual(put?.input.Bucket, 'cdk-assets');
		assert.match(String(put?.input.Key), /^bb-database-guard\/App\/\d+\.template\.json$/);
		const create = sent.find((s) => s.name === 'CreateChangeSetCommand');
		assert.strictEqual(create?.input.TemplateBody, undefined);
		assert.strictEqual(
			create?.input.TemplateURL,
			`https://cdk-assets.s3.us-east-1.amazonaws.com/${put?.input.Key}`,
		);
		assert.ok(sent.some((s) => s.name === 'DeleteObjectCommand' && s.input.Key === put?.input.Key));
		assert.ok(result.notes.some((n) => /staged at https:\/\/cdk-assets/.test(n)));
	});

	test('a binding stop is reported without creating a change set', async () => {
		const next = templateWith({
			databases: { 'app-db': { cluster: 'app-main', type: 'distributed' } },
			clusters: { 'app-main': { type: 'distributed', resource: 'MainDsql' } },
		});
		const { cloudFormation, s3, sent } = fakeClients(deployed, []);
		const result = await guardDeploy({ stackName: 'App', template: next, cloudFormation, s3 });
		assert.match(result.stops[0], /Database 'app-db' is bound to its default cluster/);
		assert.ok(!sent.some((s) => s.name === 'CreateChangeSetCommand'));
	});

	test('a missing stack is a first deploy', async () => {
		const cloudFormation = {
			async send() {
				throw new Error('Stack with id App does not exist');
			},
		};
		const result = await guardDeploy({ stackName: 'App', template: {}, cloudFormation });
		assert.deepStrictEqual(result.stops, []);
		assert.match(result.notes[0], /first deploy/);
	});
});
