// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Synth-level contract of the CDK entry: what an owned and a shared cluster
 * provision, how blocks attach and chain, which functions wait for migrations,
 * and what the stack's binding record says. Harness mirrors
 * bb-distributed-table's cdk test: a stub stack exposing `executionRole` +
 * `defaults` as the ambient CURRENT_BLOCKS_STACK.
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

type Resources = Record<string, { Type: string; Properties: Record<string, any>; DependsOn?: string[] }>;
const migrationResources = (template: Template): Resources =>
	template.findResources('AWS::CloudFormation::CustomResource') as Resources;
const functionsByHandler = (template: Template, handler: string): Resources =>
	template.findResources('AWS::Lambda::Function', { Properties: { Handler: handler } }) as Resources;

beforeEach(() => _resetDatabaseRegistry());

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

	test('the app role gets dsql:DbConnect; the migration Lambdas get dsql:DbConnectAdmin', () => {
		const { stack, parent } = setup();
		new Database(parent, 'db');
		const template = Template.fromStack(stack);
		const policies = JSON.stringify(template.findResources('AWS::IAM::Policy'));
		assert.match(policies, /dsql:DbConnect"/);
		assert.match(policies, /dsql:DbConnectAdmin/);
	});

	test('blocks on a shared distributed cluster share one DSQL cluster and one pair of migration Lambdas, with chained per-block resources', () => {
		const { stack, parent } = setup();
		const shared = new DatabaseCluster(parent, 'shared', { type: 'distributed', removalPolicy: 'retain' });
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

	test('the migration provider polls isComplete for up to two hours', () => {
		const { stack, parent } = setup();
		new Database(parent, 'db');
		const template = Template.fromStack(stack);
		// The provider framework encodes the poll interval and total timeout in its state machine.
		const machines = template.findResources('AWS::StepFunctions::StateMachine');
		assert.strictEqual(Object.keys(machines).length, 1);
		const definition = JSON.stringify(Object.values(machines)[0].Properties.DefinitionString);
		assert.match(definition, /IntervalSeconds\\*":30/);
		assert.match(definition, /MaxAttempts\\*":240/);
	});

	test('every function that assumes the execution role waits for the block migrations; the migration Lambdas do not', () => {
		const { stack, parent } = setup();
		const shared = new DatabaseCluster(parent, 'shared', { type: 'distributed' });
		new Database(parent, 'a', { cluster: shared });
		new Database(parent, 'b', { cluster: shared });
		new Database(parent, 'own');
		// A function with its own role is not an app function.
		new cdk.aws_lambda.Function(stack, 'Unrelated', {
			runtime: DEFAULT_NODE_RUNTIME,
			handler: 'other.handler',
			code: cdk.aws_lambda.Code.fromInline('exports.handler = async () => {};'),
		});
		const template = Template.fromStack(stack);
		const migrationIds = Object.keys(migrationResources(template));
		assert.strictEqual(migrationIds.length, 3);
		const functions = template.findResources('AWS::Lambda::Function') as Resources;
		const stub = Object.entries(functions).find(([id]) => id.startsWith('StubHandler'));
		assert.ok(stub);
		for (const id of migrationIds) assert.ok(stub[1].DependsOn?.includes(id), `StubHandler depends on ${id}`);
		for (const [id, fn] of Object.entries(functions)) {
			if (id.startsWith('StubHandler')) continue;
			assert.ok(
				!migrationIds.some((m) => fn.DependsOn?.includes(m)),
				`${id} (${fn.Properties.Handler}) must not depend on a migration resource`,
			);
		}
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

	test('runtime methods are synth-guarded', () => {
		const { parent } = setup();
		const db = new Database(parent, 'db');
		assert.throws(() => db.query(), /Database\.query/);
	});

	test('duplicate short ids and shared schemas are rejected at synth', () => {
		const { parent } = setup();
		new Database(parent, 'orders');
		assert.throws(() => new Database(new Scope('other'), 'orders'), /Database id 'orders' is used twice/);
		const shared = new DatabaseCluster(parent, 'shared', { type: 'distributed' });
		new Database(parent, 'x', { cluster: shared, schemaName: 'public' });
		assert.throws(
			() => new Database(parent, 'y', { cluster: shared, schemaName: 'public' }),
			/both use schema 'public'/,
		);
	});
});
