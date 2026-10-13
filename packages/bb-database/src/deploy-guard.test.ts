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
	orphanedClusterCost,
} from './deploy-guard.js';

const templateWith = (bindings: unknown, resources: NonNullable<CfnTemplate['Resources']> = {}) => ({
	Metadata: { [BINDINGS_METADATA_KEY]: bindings },
	Resources: resources,
});

describe('deploy guard', () => {
	test('a block moving between clusters is a stop, with the deployed removal policy', () => {
		const deployed = templateWith(
			{ databases: { 'app-orders': { cluster: 'default', type: 'distributed' } }, clusters: {} },
			{ Dsql: { Type: 'AWS::DSQL::Cluster', DeletionPolicy: 'Retain' } },
		);
		const next = templateWith({
			databases: { 'app-orders': { cluster: 'app-main', type: 'provisioned' } },
			clusters: { 'app-main': { type: 'provisioned' } },
		});
		const stops = bindingStops(deployed, next);
		assert.strictEqual(stops.length, 1);
		assert.match(stops[0], /Deploy stopped: Database 'app-orders' is bound to its default cluster \(distributed\)/);
		assert.match(stops[0], /removal policy: retain/);
	});

	test('a first deploy or an unchanged record passes', () => {
		const next = templateWith({
			databases: { 'app-db': { cluster: 'default', type: 'distributed' } },
			clusters: {},
		});
		assert.deepStrictEqual(bindingStops(undefined, next), []);
		assert.deepStrictEqual(bindingStops(next, next), []);
	});

	test('the change-set backstop flags Remove and Replace on cluster resources only', () => {
		const template = {
			Resources: {
				Aurora: {
					Type: 'AWS::RDS::DBCluster',
					Properties: { ServerlessV2ScalingConfiguration: { MinCapacity: 1 } },
				},
			},
		};
		const stops = changeSetStops(
			[
				{
					ResourceChange: {
						Action: 'Remove',
						ResourceType: 'AWS::RDS::DBCluster',
						LogicalResourceId: 'Aurora',
					},
				},
				{
					ResourceChange: {
						Action: 'Modify',
						Replacement: 'True',
						ResourceType: 'AWS::DSQL::Cluster',
						LogicalResourceId: 'Dsql',
					},
				},
				{
					ResourceChange: {
						Action: 'Modify',
						Replacement: 'False',
						ResourceType: 'AWS::DSQL::Cluster',
						LogicalResourceId: 'Dsql2',
					},
				},
				{
					ResourceChange: {
						Action: 'Remove',
						ResourceType: 'AWS::Lambda::Function',
						LogicalResourceId: 'Fn',
					},
				},
			],
			template,
			'delete',
		);
		assert.strictEqual(stops.length, 2);
		assert.match(
			stops[0],
			/would remove AWS::RDS::DBCluster 'Aurora'\. Its data would be deleted\. Leaving it orphaned costs about \$87\.60\/month at 1 ACU/,
		);
		assert.match(stops[1], /would replace AWS::DSQL::Cluster 'Dsql'/);
	});

	test('helpers', () => {
		assert.strictEqual(
			clusterRemovalPolicy({ Resources: { A: { Type: 'AWS::DSQL::Cluster', DeletionPolicy: 'Delete' } } }),
			'delete',
		);
		assert.strictEqual(clusterRemovalPolicy({ Resources: { A: { Type: 'AWS::DSQL::Cluster' } } }), 'retain');
		assert.strictEqual(
			orphanedClusterCost(undefined),
			'about $43.80/month at 0.5 ACU (us-east-1 list price, estimate)',
		);
	});
});
