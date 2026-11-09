// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { type BlocksDefaults, BlocksPresets, DEFAULT_NODE_RUNTIME, Scope } from '@aws-blocks/core/cdk';
import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import type { Construct } from 'constructs';
import { MIGRATION_SERVICE_TIMEOUT_SECONDS, MIGRATION_TOTAL_TIMEOUT_MINUTES } from './constants.js';
import { DSQL_MIGRATION_VALIDATION_ERROR_NAME } from './errors.js';
import { Database, DatabaseCluster } from './index.cdk.js';
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
			name: DSQL_MIGRATION_VALIDATION_ERROR_NAME,
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
