// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Synth-level contract of the CDK entry: which resources each kind
 * provisions, how shared clusters attach their blocks, and what the stack's
 * binding record says. Harness mirrors bb-distributed-table's cdk test: a stub
 * stack exposing `executionRole` + `defaults` as the ambient CURRENT_BLOCKS_STACK.
 */
import assert from 'node:assert';
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, test } from 'node:test';
import { type BlocksDefaults, BlocksPresets, DEFAULT_NODE_RUNTIME, Scope } from '@aws-blocks/core/cdk';
import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import type { Construct } from 'constructs';
import { BINDINGS_METADATA_KEY } from './constants.js';
import { Database, DatabaseCluster } from './index.cdk.js';
import { _resetDatabaseRegistry } from './registry.js';

class StubBlocksStack extends cdk.Stack {
	public readonly executionRole: cdk.aws_iam.IRole;
	public readonly id: string;
	public defaults: BlocksDefaults = BlocksPresets.sandbox;
	constructor(scope: Construct, id: string) {
		super(scope, id, { env: { account: '123456789012', region: 'us-east-1' } });
		this.id = id;
		(globalThis as { CURRENT_BLOCKS_STACK?: unknown }).CURRENT_BLOCKS_STACK = this;
		this.executionRole = new cdk.aws_iam.Role(this, 'BlocksRole', {
			assumedBy: new cdk.aws_iam.ServicePrincipal('lambda.amazonaws.com'),
		});
		new cdk.aws_lambda.Function(this, 'StubHandler', {
			runtime: DEFAULT_NODE_RUNTIME,
			handler: 'index.handler',
			code: cdk.aws_lambda.Code.fromInline('exports.handler = async () => {};'),
			role: this.executionRole,
		});
	}
}

let n = 0;
function setup(defaults: BlocksDefaults = BlocksPresets.sandbox) {
	const app = new cdk.App();
	const stack = new StubBlocksStack(app, `TestStack${++n}`);
	stack.defaults = defaults;
	return { stack, parent: new Scope(`app${n}`) };
}

beforeEach(() => _resetDatabaseRegistry());

describe('Database (CDK)', () => {
	test('an owned block provisions a DSQL cluster, one migration resource, and records its binding', () => {
		const { stack, parent } = setup();
		const db = new Database(parent, 'db');
		const template = Template.fromStack(stack);
		template.resourceCountIs('AWS::DSQL::Cluster', 1);
		template.hasResource('AWS::DSQL::Cluster', {
			DeletionPolicy: 'Delete',
			Properties: { DeletionProtectionEnabled: false },
		});
		template.resourceCountIs('AWS::RDS::DBCluster', 0);
		const customResources = template.findResources('AWS::CloudFormation::CustomResource');
		const migrations = Object.values(customResources).filter((r) => r.Properties?.blockFullId === db.fullId);
		assert.strictEqual(migrations.length, 1);
		assert.strictEqual(migrations[0].Properties.schemaName, 'public');
		assert.strictEqual(migrations[0].Properties.migrationsHash, 'no-migrations');
		assert.deepStrictEqual(template.toJSON().Metadata[BINDINGS_METADATA_KEY], {
			databases: { [db.fullId]: { cluster: 'default', type: 'distributed' } },
			clusters: {},
		});
		assert.deepStrictEqual(db.cluster, { kind: 'distributed', id: 'default' });
	});

	test('production defaults retain the cluster with deletion protection; removalPolicy overrides the policy', () => {
		const { stack, parent } = setup(BlocksPresets.production);
		new Database(parent, 'db');
		Template.fromStack(stack).hasResource('AWS::DSQL::Cluster', {
			DeletionPolicy: 'Retain',
			Properties: { DeletionProtectionEnabled: true },
		});
		const other = setup(BlocksPresets.production);
		new Database(other.parent, 'db2', { removalPolicy: 'destroy' });
		Template.fromStack(other.stack).hasResource('AWS::DSQL::Cluster', { DeletionPolicy: 'Delete' });
	});

	test('blocks on a shared provisioned cluster share one Aurora cluster and migration Lambda, with chained per-block resources', () => {
		const { stack, parent } = setup();
		const main = new DatabaseCluster(parent, 'main', { type: 'provisioned', minCapacity: 1, maxCapacity: 4 });
		const users = new Database(parent, 'users', { cluster: main });
		const orders = new Database(parent, 'orders', { cluster: main });
		const template = Template.fromStack(stack);
		template.resourceCountIs('AWS::RDS::DBCluster', 1);
		template.hasResourceProperties('AWS::RDS::DBCluster', {
			EnableHttpEndpoint: true,
			StorageEncrypted: true,
			ServerlessV2ScalingConfiguration: { MinCapacity: 1, MaxCapacity: 4 },
			DatabaseName: main.fullId.replace(/[^a-zA-Z0-9]/g, '_'),
		});
		const lambdas = template.findResources('AWS::Lambda::Function', {
			Properties: { Environment: { Variables: { CLUSTER_KIND: 'provisioned' } } },
		});
		assert.strictEqual(Object.keys(lambdas).length, 1, 'one migration Lambda per cluster');
		const crs = Object.entries(template.findResources('AWS::CloudFormation::CustomResource'));
		const byBlock = Object.fromEntries(crs.map(([id, r]) => [r.Properties.blockFullId, { id, ...r }]));
		assert.strictEqual(byBlock[users.fullId].Properties.schemaName, 'users');
		assert.strictEqual(byBlock[orders.fullId].Properties.schemaName, 'orders');
		assert.ok(
			byBlock[orders.fullId].DependsOn.includes(byBlock[users.fullId].id),
			'resources on one cluster run serially',
		);
		assert.deepStrictEqual(template.toJSON().Metadata[BINDINGS_METADATA_KEY], {
			databases: {
				[users.fullId]: { cluster: main.fullId, type: 'provisioned' },
				[orders.fullId]: { cluster: main.fullId, type: 'provisioned' },
			},
			clusters: { [main.fullId]: { type: 'provisioned' } },
		});
	});

	test('a shared distributed cluster is one DSQL cluster; the migration resource carries the app role', () => {
		const { stack, parent } = setup();
		const shared = new DatabaseCluster(parent, 'shared', { type: 'distributed' });
		new Database(parent, 'a', { cluster: shared });
		new Database(parent, 'b', { cluster: shared });
		const template = Template.fromStack(stack);
		template.resourceCountIs('AWS::DSQL::Cluster', 1);
		template.resourceCountIs('AWS::CloudFormation::CustomResource', 2);
		template.hasResourceProperties('AWS::CloudFormation::CustomResource', {
			dbRole: Match.stringLikeRegexp('^blocks_app_'),
			appRoleArn: Match.anyValue(),
		});
	});

	test('migrations are hashed into the block resource so a changed file re-runs it', () => {
		const dir = join(tmpdir(), `bb-database-cdk-${process.pid}`);
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, '001.sql'), 'CREATE TABLE t (id TEXT PRIMARY KEY);');
		try {
			const { stack, parent } = setup();
			new Database(parent, 'db', { migrationsPath: dir });
			const template = Template.fromStack(stack);
			template.hasResourceProperties('AWS::CloudFormation::CustomResource', {
				migrationsHash: Match.stringLikeRegexp('^[0-9a-f]{16}$'),
				// The files travel as an S3 asset: the Lambda is bundled before blocks attach.
				migrationsBucket: Match.anyValue(),
				migrationsKey: Match.stringLikeRegexp('\\.json$'),
			});
			// The staged asset is the block's files as one JSON document.
			const assembly = cdk.Stage.of(stack)?.synth();
			const out = assembly?.directory ?? '';
			const files = readdirSync(out)
				.filter((f) => /^asset\..*\.json$/.test(f))
				.map((f) => JSON.parse(readFileSync(join(out, f), 'utf-8')) as Record<string, string>);
			assert.deepStrictEqual(files, [{ '001.sql': 'CREATE TABLE t (id TEXT PRIMARY KEY);' }]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test('a fromExisting() block provisions nothing and records an external binding', () => {
		const { stack, parent } = setup();
		const ext = DatabaseCluster.fromExisting({ connectionString: 'postgres://u:p@h/db' });
		const db = new Database(parent, 'ext', { cluster: ext });
		const template = Template.fromStack(stack);
		template.resourceCountIs('AWS::DSQL::Cluster', 0);
		template.resourceCountIs('AWS::RDS::DBCluster', 0);
		template.resourceCountIs('AWS::CloudFormation::CustomResource', 0);
		assert.deepStrictEqual(template.toJSON().Metadata[BINDINGS_METADATA_KEY].databases, {
			[db.fullId]: { cluster: 'external', type: 'external' },
		});
	});

	test('runtime methods are synth-guarded', () => {
		const { parent } = setup();
		const db = new Database(parent, 'db');
		assert.throws(() => db.query(), /Database\.query/);
	});

	test('duplicate short ids are rejected at synth', () => {
		const { parent } = setup();
		new Database(parent, 'orders');
		assert.throws(() => new Database(new Scope('other'), 'orders'), /Database id 'orders' is used twice/);
	});
});
