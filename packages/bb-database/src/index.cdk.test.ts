// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { isDeepStrictEqual } from 'node:util';
import { AppSetting } from '@aws-cdk-blocks/bb-app-setting';
import { type BlocksDefaults, BlocksPresets, DEFAULT_NODE_RUNTIME, Scope } from '@aws-cdk-blocks/core/cdk';
import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import type { Construct } from 'constructs';
import { MIGRATION_SERVICE_TIMEOUT_SECONDS, MIGRATION_TOTAL_TIMEOUT_MINUTES } from './constants.js';
import { MIGRATION_VALIDATION_ERROR_NAME } from './errors.js';
import { Database, DatabaseCluster, LegacyDatabaseCluster } from './index.cdk.js';
import { migrations } from './test-support/fixtures.js';
import { freshScope, installLocalTestHooks } from './test-support/lifecycle.js';

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
	// No esbuild run per test: the migration Lambda's code becomes a placeholder asset; the migrations
	// themselves travel as a plain file asset, which is still staged.
	const app = new cdk.App({ context: { 'aws:cdk:bundling-stacks': [] } });
	const stack = new StubBlocksStack(app, `TestStack${++n}`);
	stack.defaults = defaults;
	// After the stack: a Scope without a parent attaches to CURRENT_BLOCKS_STACK.
	return { stack, parent: freshScope('app', (id) => new Scope(id)) };
}

const migrationResources = (template: Template) => template.findResources('AWS::CloudFormation::CustomResource');
const functionsByHandler = (template: Template, handler: string) =>
	template.findResources('AWS::Lambda::Function', { Properties: { Handler: handler } });

installLocalTestHooks();

describe('Database (CDK)', () => {
	test('an owned block provisions a DSQL cluster and one migration resource', () => {
		const { stack, parent } = setup();
		const db = new Database(parent, 'db');
		const template = Template.fromStack(stack);
		template.resourceCountIs('AWS::DSQL::Cluster', 1);
		template.hasResource('AWS::DSQL::Cluster', {
			DeletionPolicy: 'Delete',
			Properties: { DeletionProtectionEnabled: false },
		});
		template.resourceCountIs('AWS::RDS::DBCluster', 0);
		const migrations = Object.values(migrationResources(template)).filter(
			(r) => r.Properties.blockFullId === db.fullId,
		);
		assert.strictEqual(migrations.length, 1);
		assert.strictEqual(migrations[0].Properties.schemaName, 'public');
		assert.strictEqual(migrations[0].Properties.migrationsHash, 'no-migrations');
		assert.deepStrictEqual(db.cluster, { kind: 'dsql', id: 'default' });
	});

	test('production defaults retain the cluster with deletion protection', () => {
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

	test('the DSQL cluster carries Tags.of() tags, including the app tag, under its existing logical id', () => {
		const { stack } = setup();
		// A fixed scope id: the logical id comes from the construct path.
		const parent = new Scope('ledger');
		new Database(parent, 'db');
		cdk.Tags.of(stack).add('app', 'ledger', { priority: 1000 });
		cdk.Tags.of(parent).add('cost-center', 'payments');
		const clusters = Template.fromStack(stack).findResources('AWS::DSQL::Cluster');
		// A changed logical id would replace the cluster.
		assert.deepStrictEqual(Object.keys(clusters), [`${stack.id}ledgerdbDsqlCluster`]);
		const [cluster] = Object.values(clusters);
		assert.deepStrictEqual(cluster.Properties, {
			DeletionProtectionEnabled: false,
			Tags: [
				{ Key: 'app', Value: 'ledger' },
				{ Key: 'cost-center', Value: 'payments' },
			],
		});
	});

	test('an owned DSQL cluster has the logical id DistributedDatabase declared, so an upgraded app keeps its cluster', () => {
		const { stack } = setup();
		const db = new Database(new Scope('ledger'), 'db');
		// How `DistributedDatabase` declared its cluster: a child of the stack named `<fullId>DsqlCluster`.
		const earlierStack = new cdk.Stack(new cdk.App(), 'Earlier');
		const earlier = new cdk.CfnResource(earlierStack, `${db.fullId}DsqlCluster`, { type: 'AWS::DSQL::Cluster' });
		const earlierId = earlierStack.getLogicalId(earlier);
		// The block's `fullId` starts with the stack's id.
		assert.strictEqual(earlierId, `${stack.id}ledgerdbDsqlCluster`);

		const template = Template.fromStack(stack);
		assert.deepStrictEqual(Object.keys(template.findResources('AWS::DSQL::Cluster')), [earlierId]);
		// Everything that names the cluster follows the id.
		const [migration] = Object.values(migrationResources(template));
		assert.deepStrictEqual(migration.Properties.clusterEndpoint, { 'Fn::GetAtt': [earlierId, 'Endpoint'] });
		assert.ok(migration.DependsOn.includes(earlierId));
	});

	test('two owned blocks whose ids differ only in punctuation fail at synth, by name', () => {
		const { stack } = setup();
		const parent = new Scope('ledger');
		new Database(parent, 'db-a');
		assert.throws(
			() => {
				new Database(parent, 'dba');
				Template.fromStack(stack);
			},
			(e: unknown) => e instanceof Error && /ledger-dba/.test(e.message) && /ledger-db-a/.test(e.message),
		);
	});

	test('a shared DSQL cluster keeps the logical id of its construct path', () => {
		const { stack } = setup();
		new DatabaseCluster(new Scope('ledger'), 'shared', { type: 'dsql' });
		const ids = Object.keys(Template.fromStack(stack).findResources('AWS::DSQL::Cluster'));
		assert.deepStrictEqual(ids, ['ledgersharedDsqlCluster2ACEACDA']);
	});

	test('the app role gets dsql:DbConnect; the migration Lambdas get dsql:DbConnectAdmin', () => {
		const { stack, parent } = setup();
		new Database(parent, 'db');
		const template = Template.fromStack(stack);
		const policies = JSON.stringify(template.findResources('AWS::IAM::Policy'));
		assert.match(policies, /dsql:DbConnect"/);
		assert.match(policies, /dsql:DbConnectAdmin/);
		assert.match(policies, /AWS::Partition/, 'the cluster ARN takes the partition from the stack');
		assert.doesNotMatch(policies, /arn:aws:dsql/);
	});

	test('the migration provider waiter role trusts Step Functions with aws:SourceAccount and aws:SourceArn', () => {
		const { stack, parent } = setup();
		new Database(parent, 'db');
		Template.fromStack(stack).hasResourceProperties('AWS::IAM::Role', {
			AssumeRolePolicyDocument: {
				Statement: [
					Match.objectLike({
						Principal: { Service: 'states.amazonaws.com' },
						Condition: {
							StringEquals: { 'aws:SourceAccount': '123456789012' },
							ArnLike: {
								'aws:SourceArn': {
									'Fn::Join': [
										'',
										[
											'arn:',
											{ Ref: 'AWS::Partition' },
											':states:us-east-1:123456789012:stateMachine:*',
										],
									],
								},
							},
						},
					}),
				],
			},
		});
	});

	test('blocks on a shared DSQL cluster share one cluster resource and one pair of migration Lambdas', () => {
		const { stack, parent } = setup();
		const shared = new DatabaseCluster(parent, 'shared', { type: 'dsql', removalPolicy: 'retain' });
		const a = new Database(parent, 'a', { cluster: shared });
		const b = new Database(parent, 'b', { cluster: shared });
		const template = Template.fromStack(stack);
		template.resourceCountIs('AWS::DSQL::Cluster', 1);
		template.hasResource('AWS::DSQL::Cluster', { DeletionPolicy: 'Retain' });
		assert.strictEqual(
			Object.keys(functionsByHandler(template, 'index.handler')).length,
			2,
			'onEvent + the stub app function',
		);
		assert.strictEqual(
			Object.keys(functionsByHandler(template, 'index.isComplete')).length,
			1,
			'one isComplete per cluster',
		);
		const crs = Object.entries(migrationResources(template));
		assert.strictEqual(crs.length, 2);
		const byBlock = Object.fromEntries(crs.map(([id, r]) => [r.Properties.blockFullId, { id, ...r }]));
		assert.strictEqual(byBlock[a.fullId].Properties.schemaName, 'a');
		assert.strictEqual(byBlock[b.fullId].Properties.schemaName, 'b');
		assert.ok(byBlock[b.fullId].DependsOn?.includes(byBlock[a.fullId].id), 'resources on one cluster run serially');
		template.hasResourceProperties('AWS::CloudFormation::CustomResource', {
			dbRole: Match.stringLikeRegexp('^blocks_app_'),
			appRoleArn: Match.anyValue(),
		});
	});

	test('the migration provider gives up polling isComplete before the one-hour CloudFormation limit', () => {
		const { stack, parent } = setup();
		new Database(parent, 'db');
		const template = Template.fromStack(stack);
		// CloudFormation stops waiting for a custom resource after ServiceTimeout (at most 3600 s); the
		// provider must give up first so the failure is reported instead of a hung stack.
		assert.ok(
			MIGRATION_TOTAL_TIMEOUT_MINUTES * 60 < MIGRATION_SERVICE_TIMEOUT_SECONDS,
			'the provider gives up first',
		);
		for (const resource of Object.values(migrationResources(template))) {
			assert.strictEqual(resource.Properties.ServiceTimeout, 3600);
		}
	});

	test('every function that assumes the execution role waits for the block migrations', () => {
		const { stack, parent } = setup();
		const shared = new DatabaseCluster(parent, 'shared', { type: 'dsql' });
		new Database(parent, 'a', { cluster: shared });
		new Database(parent, 'b', { cluster: shared });
		new Database(parent, 'own');
		new cdk.aws_lambda.Function(stack, 'Unrelated', {
			runtime: DEFAULT_NODE_RUNTIME,
			handler: 'other.handler',
			code: cdk.aws_lambda.Code.fromInline('exports.handler = async () => {};'),
		});
		const template = Template.fromStack(stack);
		const migrationIds = Object.keys(migrationResources(template));
		assert.strictEqual(migrationIds.length, 3);
		const functions = template.findResources('AWS::Lambda::Function');
		const stub = Object.entries(functions).find(([id]) => id.startsWith('StubHandler'));
		assert.ok(stub);
		// Through the chain: a block's resource depends on the previous block's on the same cluster.
		const all = template.toJSON().Resources;
		const reaches = (from: string[] = [], target: string, seen = new Set<string>()): boolean =>
			from.some(
				(id) => id === target || (!seen.has(id) && seen.add(id) && reaches(all[id]?.DependsOn, target, seen)),
			);
		for (const id of migrationIds) assert.ok(reaches(stub[1].DependsOn, id), `StubHandler waits for ${id}`);
		for (const [id, fn] of Object.entries(functions)) {
			if (id.startsWith('StubHandler')) continue;
			assert.ok(
				!migrationIds.some((m) => fn.DependsOn?.includes(m)),
				`${id} (${fn.Properties.Handler}) must not depend on a migration resource`,
			);
		}
	});

	test('migrations are hashed into the block resource so a changed file re-runs it', () => {
		const { stack, parent } = setup();
		new Database(parent, 'db', {
			migrationsPath: migrations({ '001.sql': 'CREATE TABLE t (id TEXT PRIMARY KEY);' }),
		});
		const template = Template.fromStack(stack);
		template.hasResourceProperties('AWS::CloudFormation::CustomResource', {
			migrationsHash: Match.stringLikeRegexp('^[0-9a-f]{16}$'),
			migrationsBucket: Match.anyValue(),
			migrationsKey: Match.stringLikeRegexp('\\.json$'),
		});
		const assembly = cdk.Stage.of(stack)?.synth();
		const out = assembly?.directory ?? '';
		const files = readdirSync(out)
			.filter((f) => /^asset\..*\.json$/.test(f))
			.map((f) => JSON.parse(readFileSync(join(out, f), 'utf-8')) as Record<string, string>);
		assert.deepStrictEqual(files, [{ '001.sql': 'CREATE TABLE t (id TEXT PRIMARY KEY);' }]);
	});

	test('a migration DSQL cannot run fails synth, naming the file and the dsql-lint rule', () => {
		const { parent } = setup();
		const dir = migrations({
			'001_init.sql': 'CREATE TABLE t (id SERIAL PRIMARY KEY, n INT);\nCREATE INDEX t_n ON t (n);',
		});
		assert.throws(() => new Database(parent, 'db', { migrationsPath: dir }), {
			name: MIGRATION_VALIDATION_ERROR_NAME,
			message: /001_init\.sql: serial_type: [\s\S]*001_init\.sql: index_async: /,
		});
	});

	test('duplicate short ids and shared schemas are rejected at synth', () => {
		const { parent } = setup();
		new Database(parent, 'orders');
		assert.throws(
			() =>
				new Database(
					freshScope('other', (id) => new Scope(id)),
					'orders',
				),
			/Database id 'orders' is used twice/,
		);
		const shared = new DatabaseCluster(parent, 'shared', { type: 'dsql' });
		new Database(parent, 'x', { cluster: shared, schemaName: 'public' });
		assert.throws(
			() => new Database(parent, 'y', { cluster: shared, schemaName: 'public' }),
			/both use schema 'public'/,
		);
	});
});

describe('DatabaseCluster type aurora (CDK)', () => {
	test('provisions one express-configuration Aurora cluster, no DB instance, with IAM-only authentication', () => {
		const { stack, parent } = setup();
		const main = new DatabaseCluster(parent, 'main', { type: 'aurora' });
		const a = new Database(parent, 'a', { cluster: main });
		new Database(parent, 'b', { cluster: main });
		const template = Template.fromStack(stack);
		template.resourceCountIs('AWS::RDS::DBCluster', 1);
		template.resourceCountIs('AWS::RDS::DBInstance', 0);
		template.resourceCountIs('AWS::DSQL::Cluster', 0);
		template.hasResource('AWS::RDS::DBCluster', {
			DeletionPolicy: 'Delete',
			Properties: {
				DBClusterIdentifier: Match.stringLikeRegexp('-main$'),
				Engine: 'aurora-postgresql',
				WithExpressConfiguration: true,
				MasterUsername: 'postgres',
				ServerlessV2ScalingConfiguration: { MinCapacity: 0, MaxCapacity: 2 },
				DeletionProtection: false,
				BackupRetentionPeriod: 1,
			},
		});
		const cluster = Object.values(template.findResources('AWS::RDS::DBCluster'))[0];
		assert.strictEqual(cluster.Properties.StorageEncrypted, undefined, 'the express configuration rejects it');
		assert.strictEqual(cluster.Properties.MasterUserPassword, undefined);
		assert.strictEqual(
			cluster.Properties.EnableIAMDatabaseAuthentication,
			undefined,
			'express sets it; naming it costs a post-create modify',
		);
		assert.strictEqual(cluster.Properties.MasterUserAuthenticationType, undefined);
		assert.strictEqual(cluster.Properties.ManageMasterUserPassword, undefined);
		const policies = JSON.stringify(template.findResources('AWS::IAM::Policy'));
		assert.match(policies, /rds-db:connect/);
		// arn:...:rds-db:<region>:<account>:dbuser:<resource id>/<user>; the CI deploy with a slash before the
		// resource id refused every token ("The database query failed").
		assert.match(
			policies,
			/:dbuser:"[\s\S]*?DBClusterResourceId[\s\S]*?\/blocks_app_/,
			'the app role connects as its own role',
		);
		assert.match(
			policies,
			/:dbuser:"[\s\S]*?DBClusterResourceId[\s\S]*?\/postgres"/,
			'the migration Lambdas connect as the master user',
		);
		assert.doesNotMatch(policies, /dbuser\//);
		assert.doesNotMatch(policies, /dsql:/);
		const env = Object.values(functionsByHandler(template, 'index.isComplete'))[0].Properties.Environment.Variables;
		assert.strictEqual(env.CLUSTER_KIND, 'aurora');
		assert.ok(env.CLUSTER_ENDPOINT, 'the endpoint is Endpoint.Address');
		assert.deepStrictEqual(a.cluster, { kind: 'aurora', id: main.fullId });
		// The endpoint is a property, so a replaced (empty) cluster re-runs every block's migrations.
		template.hasResourceProperties('AWS::CloudFormation::CustomResource', { clusterEndpoint: Match.anyValue() });
	});

	test('production defaults retain with deletion protection and backups from pointInTimeRecovery; snapshot is a valid policy', () => {
		const prod = setup(BlocksPresets.production);
		new DatabaseCluster(prod.parent, 'main', { type: 'aurora', maxCapacity: 8 });
		Template.fromStack(prod.stack).hasResource('AWS::RDS::DBCluster', {
			DeletionPolicy: 'Retain',
			Properties: {
				DeletionProtection: true,
				BackupRetentionPeriod: 15,
				ServerlessV2ScalingConfiguration: { MinCapacity: 0, MaxCapacity: 8 },
			},
		});
		const pinned = setup();
		new DatabaseCluster(pinned.parent, 'main', {
			type: 'aurora',
			removalPolicy: 'snapshot',
			pointInTimeRecovery: { retentionDays: 30 },
		});
		Template.fromStack(pinned.stack).hasResource('AWS::RDS::DBCluster', {
			DeletionPolicy: 'Snapshot',
			Properties: { BackupRetentionPeriod: 30 },
		});
		// A DSQL cluster has no snapshot: the policy falls back to retain.
		const dsql = setup();
		new DatabaseCluster(dsql.parent, 'd', { type: 'dsql', removalPolicy: 'retain' });
		Template.fromStack(dsql.stack).hasResource('AWS::DSQL::Cluster', { DeletionPolicy: 'Retain' });
	});

	test('capacity must be 0.5 ACU steps within range, min at most max, backups 1 to 35 days', () => {
		const { parent } = setup();
		assert.throws(
			() => new DatabaseCluster(parent, 'c0', { type: 'aurora', pointInTimeRecovery: { retentionDays: 40 } }),
			/retentionDays must be an integer from 1 to 35/,
		);
		assert.throws(
			() => new DatabaseCluster(parent, 'c1', { type: 'aurora', minCapacity: 0.3 }),
			/minCapacity must be a multiple of 0\.5/,
		);
		assert.throws(
			() => new DatabaseCluster(parent, 'c2', { type: 'aurora', maxCapacity: 0.5 }),
			/maxCapacity must be a multiple of 0\.5 between 1 and 256/,
		);
		assert.throws(
			() => new DatabaseCluster(parent, 'c3', { type: 'aurora', minCapacity: 4, maxCapacity: 2 }),
			/minCapacity \(4\) is above maxCapacity \(2\)/,
		);
	});

	test('the cluster identifier leaves room for the writer instance name the service appends', () => {
		// The CI stack name made `<identifier>-instance-1` 64 characters: "Invalid database identifier".
		const { stack, parent } = setup();
		const long = new DatabaseCluster(parent, 'bb-test-runner-16cd7r-pr-1386-1-test-app-sharedaurora', {
			type: 'aurora',
		});
		const cluster = Object.values(Template.fromStack(stack).findResources('AWS::RDS::DBCluster'))[0];
		const identifier: string = cluster.Properties.DBClusterIdentifier;
		assert.ok(identifier.length + '-instance-1'.length <= 63, identifier);
		assert.match(identifier, /^[a-z][a-z0-9-]*[a-z0-9]$/);
		assert.doesNotMatch(identifier, /--/);
		assert.ok(
			identifier.startsWith(
				long.node.id
					.slice(0, 20)
					.toLowerCase()
					.replace(/[^a-z0-9-]/g, '-'),
			) || identifier.length === 52,
		);
	});

	test('a PostgreSQL migration file is not linted for an aurora cluster', () => {
		const { stack, parent } = setup();
		const main = new DatabaseCluster(parent, 'main', { type: 'aurora' });
		new Database(parent, 'pg', {
			cluster: main,
			migrationsPath: migrations({
				'001.sql': 'CREATE TABLE t (id SERIAL PRIMARY KEY, n INT);\nCREATE INDEX t_n ON t (n);',
			}),
		});
		Template.fromStack(stack).resourceCountIs('AWS::RDS::DBCluster', 1);
	});
});

describe('Database on an existing database (CDK)', () => {
	const CA = '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n';
	const files = { '001_items.sql': 'CREATE TABLE items (id int);' };
	const statementsOf = (template: Template): { Action: unknown; Resource: unknown; Condition?: unknown }[] =>
		Object.values(template.findResources('AWS::IAM::Policy')).flatMap(
			(policy) => policy.Properties.PolicyDocument.Statement,
		);

	test('provisions no cluster, and with no migrations no migration resource either', () => {
		const { stack, parent } = setup();
		const db = new Database(parent, 'db', { cluster: DatabaseCluster.fromExisting({ name: 'db-url', ca: CA }) });
		assert.deepStrictEqual(db.cluster, { kind: 'external', id: 'external' });
		assert.strictEqual(db.schemaName, 'public');
		const template = Template.fromStack(stack);
		template.resourceCountIs('AWS::DSQL::Cluster', 0);
		template.resourceCountIs('AWS::RDS::DBCluster', 0);
		assert.strictEqual(Object.keys(migrationResources(template)).length, 0);
	});

	test('with a name, the app role may read the SSM parameter /<stackName>-<name> and nothing holds a value', () => {
		const { stack, parent } = setup();
		new Database(parent, 'db', { cluster: DatabaseCluster.fromExisting({ name: 'db-url' }) });
		const template = Template.fromStack(stack);
		const read = statementsOf(template).filter((s) => JSON.stringify(s.Action).includes('ssm:GetParameter'));
		assert.ok(read.length > 0, 'a statement grants ssm:GetParameter');
		assert.ok(
			read.some((s) => JSON.stringify(s.Resource).includes(`parameter/${stack.id}-db-url`)),
			'on the parameter named after the stack and the short name',
		);
		assert.ok(
			!JSON.stringify(template.toJSON()).includes('postgres'),
			'the template names the place, never a value',
		);
	});

	test('with migrations: one custom resource that names the parameter, and two functions outside any VPC', () => {
		const { stack, parent } = setup();
		const db = new Database(parent, 'db', {
			cluster: DatabaseCluster.fromExisting({ name: 'db-url', ca: CA }),
			migrationsPath: migrations(files),
		});
		const template = Template.fromStack(stack);
		const resources = Object.values(migrationResources(template));
		assert.strictEqual(resources.length, 1);
		const properties = resources[0].Properties;
		assert.strictEqual(properties.connectionParameter, `/${stack.id}-db-url`);
		assert.strictEqual(properties.schemaName, 'public');
		assert.strictEqual(properties.blockFullId, db.fullId);
		assert.ok(properties.migrationsBucket && properties.migrationsKey, 'the files travel as an asset');
		assert.strictEqual(properties.connectionSecretArn, undefined);
		for (const handler of ['index.handler', 'index.isComplete']) {
			const functions = Object.values(functionsByHandler(template, handler)).filter(
				(fn) => fn.Properties.Environment?.Variables?.CLUSTER_KIND === 'external',
			);
			assert.strictEqual(functions.length, 1, handler);
			assert.strictEqual(functions[0].Properties.VpcConfig, undefined);
			assert.strictEqual(functions[0].Properties.Timeout, 600);
		}
		const statements = statementsOf(template);
		assert.ok(
			statements.some(
				(s) =>
					s.Action === 'ssm:GetParameter' &&
					JSON.stringify(s.Resource).includes(`parameter/${stack.id}-db-url`),
			),
			'the migration functions may read the parameter',
		);
		assert.ok(
			statements.some(
				(s) =>
					s.Action === 'kms:Decrypt' &&
					isDeepStrictEqual(s.Condition, {
						StringEquals: { 'kms:ViaService': 'ssm.us-east-1.amazonaws.com' },
					}),
			),
			'and decrypt it through SSM only',
		);
	});

	test('a changed certificate authority re-runs the migration resource', () => {
		const hashWith = (ca: string) => {
			const { stack, parent } = setup();
			new Database(parent, 'db', {
				cluster: DatabaseCluster.fromExisting({ name: 'db-url', ca }),
				migrationsPath: migrations(files),
			});
			return Object.values(migrationResources(Template.fromStack(stack)))[0].Properties.migrationsHash;
		};
		assert.notStrictEqual(hashWith(CA), hashWith(CA.replace('MIIB', 'MIIC')));
	});

	test('every function on the app role waits for the migrations of the block', () => {
		const { stack, parent } = setup();
		new Database(parent, 'db', {
			cluster: DatabaseCluster.fromExisting({ name: 'db-url' }),
			migrationsPath: migrations(files),
		});
		const template = Template.fromStack(stack);
		const [migrationId] = Object.keys(migrationResources(template));
		const handlers = template.findResources('AWS::Lambda::Function', { Properties: { Handler: 'index.handler' } });
		const app = Object.values(handlers).find(
			(fn) => fn.Properties.Environment?.Variables?.CLUSTER_KIND === undefined,
		);
		assert.ok(app, 'the stub app function');
		assert.ok([app.DependsOn].flat().includes(migrationId));
	});

	test("the app's own AppSetting is read by its parameter name", () => {
		const { stack, parent } = setup();
		const own = AppSetting.fromExisting<string>(parent, 'own-url', { name: '/custom/db-url', secret: true });
		new Database(parent, 'db', {
			cluster: DatabaseCluster.fromExisting({ connectionString: own }),
			migrationsPath: migrations(files),
		});
		const properties = Object.values(migrationResources(Template.fromStack(stack)))[0].Properties;
		assert.strictEqual(properties.connectionParameter, '/custom/db-url');
	});

	test('migrations with a source that the deploy cannot read fail synth', () => {
		const { parent } = setup();
		assert.throws(
			() =>
				new Database(parent, 'db', {
					cluster: DatabaseCluster.fromExisting({ connectionString: { get: async () => null } }),
					migrationsPath: migrations(files),
				}),
			/need a connection string that the\s+deploy can read/,
		);
	});
});

describe('Database on a database that is reached through the RDS Data API (CDK)', () => {
	const files = { '001_items.sql': 'CREATE TABLE items (id int);' };
	const dataApi = {
		clusterArn: 'arn:aws:rds:us-east-1:123456789012:cluster:app',
		secretArn: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:app-AbCdEf',
		database: 'app',
	};
	const DATA_API_ACTIONS = [
		'rds-data:ExecuteStatement',
		'rds-data:BeginTransaction',
		'rds-data:CommitTransaction',
		'rds-data:RollbackTransaction',
	];
	const statementsOf = (template: Template): { Action: unknown; Resource: unknown }[] =>
		Object.values(template.findResources('AWS::IAM::Policy')).flatMap(
			(policy) => policy.Properties.PolicyDocument.Statement,
		);

	test('fromExisting({ dataApi }): no cluster, the grants on that cluster and secret, and the three values on the migration resource', () => {
		const { stack, parent } = setup();
		new Database(parent, 'db', {
			cluster: DatabaseCluster.fromExisting({ dataApi }),
			migrationsPath: migrations(files),
		});
		const template = Template.fromStack(stack);
		template.resourceCountIs('AWS::RDS::DBCluster', 0);
		template.resourceCountIs('AWS::DSQL::Cluster', 0);
		const statements = statementsOf(template);
		// The app role and the two migration functions.
		assert.strictEqual(
			statements.filter((s) => isDeepStrictEqual(s.Action, DATA_API_ACTIONS) && s.Resource === dataApi.clusterArn)
				.length,
			3,
		);
		assert.strictEqual(
			statements.filter((s) => s.Action === 'secretsmanager:GetSecretValue' && s.Resource === dataApi.secretArn)
				.length,
			3,
		);
		const [resource] = Object.values(migrationResources(template));
		assert.deepStrictEqual(resource.Properties.dataApi, dataApi);
		assert.strictEqual(resource.Properties.connectionParameter, undefined);
	});

	test('LegacyDatabaseCluster declares the cluster of the earlier block under its logical ids', () => {
		const { stack } = setup();
		const scope = new Scope('ledger');
		const cluster = new LegacyDatabaseCluster(scope, 'main', { minCapacity: 1, removalPolicy: 'retain' });
		new Database(scope, 'main-db', { cluster, migrationsPath: migrations(files) });
		const template = Template.fromStack(stack);

		// The construct ids of the earlier block: `<fullId>Cluster`, `<fullId>Vpc`, `<fullId>Sg`, under `ledger/main`.
		const alnum = cluster.fullId.replace(/[^A-Za-z0-9]/g, '');
		const clusters = template.findResources('AWS::RDS::DBCluster');
		const [[clusterId, declared]] = Object.entries(clusters);
		assert.match(clusterId, new RegExp(`^ledgermain${alnum}Cluster[0-9A-F]{8}$`));
		assert.strictEqual(declared.DeletionPolicy, 'Retain');
		assert.strictEqual(declared.Properties.EnableHttpEndpoint, true);
		assert.strictEqual(declared.Properties.DatabaseName, cluster.fullId.replace(/[^a-zA-Z0-9]/g, '_'));
		assert.deepStrictEqual(declared.Properties.ServerlessV2ScalingConfiguration, {
			MinCapacity: 1,
			MaxCapacity: 2,
		});
		assert.strictEqual(declared.Properties.EngineVersion, '16.13');
		assert.strictEqual(declared.Properties.StorageEncrypted, undefined);
		template.resourceCountIs('AWS::RDS::DBInstance', 1);
		template.resourceCountIs('AWS::EC2::VPC', 1);
		template.resourceCountIs('AWS::SecretsManager::Secret', 1);
		template.resourceCountIs('AWS::DSQL::Cluster', 0);

		// The block's files run through the Data API of that cluster, after the cluster exists.
		const [resource] = Object.values(migrationResources(template));
		assert.deepStrictEqual(resource.Properties.dataApi.clusterArn, {
			'Fn::Join': [
				'',
				['arn:', { Ref: 'AWS::Partition' }, ':rds:us-east-1:123456789012:cluster:', { Ref: clusterId }],
			],
		});
		assert.ok(resource.DependsOn.includes(clusterId));
		assert.strictEqual(resource.Properties.schemaName, 'public');
		// The migration functions are outside the VPC of the cluster.
		for (const fn of Object.values(functionsByHandler(template, 'index.handler'))) {
			assert.strictEqual(fn.Properties.VpcConfig, undefined);
		}
	});

	test('a file of a block on a LegacyDatabaseCluster gets no check at synth', () => {
		setup();
		const scope = new Scope('ledger');
		const older = { '001_index.sql': 'CREATE INDEX CONCURRENTLY t_n ON t (n);' };
		assert.doesNotThrow(
			() =>
				new Database(scope, 'main-db', {
					cluster: new LegacyDatabaseCluster(scope, 'main'),
					migrationsPath: migrations(older),
				}),
		);
		// The same file on a cluster that the block provisions is refused.
		assert.throws(
			() =>
				new Database(scope, 'new-db', {
					cluster: new DatabaseCluster(scope, 'new', { type: 'aurora' }),
					migrationsPath: migrations(older),
				}),
			(e: unknown) => e instanceof Error && e.name === MIGRATION_VALIDATION_ERROR_NAME,
		);
	});

	test('the context key of the earlier package keeps an encrypted cluster encrypted', () => {
		const app = new cdk.App({
			context: { 'aws:cdk:bundling-stacks': [], '@aws-blocks/bb-data:encryptStorageByDefault': true },
		});
		const stack = new StubBlocksStack(app, 'EncryptedLegacy');
		new LegacyDatabaseCluster(
			freshScope('app', (id) => new Scope(id)),
			'main',
		);
		Template.fromStack(stack).hasResourceProperties('AWS::RDS::DBCluster', { StorageEncrypted: true });
	});
});
