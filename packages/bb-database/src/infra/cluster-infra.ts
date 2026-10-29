// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Provisions one Aurora DSQL cluster and the migration Lambdas its blocks
 * share. Each block calls {@link ClusterInfra.attach}, which publishes the
 * block's migrations as an S3 asset and adds a CustomResource; resources on one
 * cluster are chained so they never run concurrently, and every app function
 * that assumes the stack's execution role is made to depend on the resource, so
 * new code never runs against the old schema. Used by `DatabaseCluster` and by
 * a `Database` that owns its cluster.
 */
import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
	type BlocksDefaults,
	type BuildingBlockScope,
	blocksNodejsBundling,
	DEFAULT_NODE_RUNTIME,
} from '@aws-blocks/core/cdk';
import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import { CfnFunction } from 'aws-cdk-lib/aws-lambda';
import * as lambda from 'aws-cdk-lib/aws-lambda-nodejs';
import { LogGroup } from 'aws-cdk-lib/aws-logs';
import { Asset } from 'aws-cdk-lib/aws-s3-assets';
import * as cr from 'aws-cdk-lib/custom-resources';
import type { Construct, IConstruct } from 'constructs';
import {
	ENV_VAR_PREFIX,
	MIGRATION_LAMBDA_TIMEOUT_MINUTES,
	MIGRATION_POLL_INTERVAL_SECONDS,
	MIGRATION_TOTAL_TIMEOUT_MINUTES,
	sanitizeDbRoleName,
	toEnvName,
} from '../constants.js';
import type { DatabaseClusterOptions } from '../types.js';

const REMOVAL_POLICY_MAP = {
	destroy: cdk.RemovalPolicy.DESTROY,
	retain: cdk.RemovalPolicy.RETAIN,
} as const;

/** Hash all .sql files in a directory to detect changes. */
function hashMigrationsDir(dir: string): string {
	const hash = createHash('sha256');
	const files = readdirSync(dir)
		.filter((f) => f.endsWith('.sql'))
		.sort();
	for (const file of files) {
		hash.update(file);
		hash.update(readFileSync(join(dir, file), 'utf-8'));
	}
	return hash.digest('hex').slice(0, 16);
}

interface ClusterInfraProps {
	/** The construct the cluster's resources are created under (the `DatabaseCluster`, or the owning `Database`). */
	owner: BuildingBlockScope;
	/** Names the cluster; drives resource names and the `BLOCKS_{id}_*` config keys. */
	fullId: string;
	options: DatabaseClusterOptions;
	defaults: BlocksDefaults;
}

/** A block attached to the cluster. */
interface AttachedBlock {
	scope: Construct;
	fullId: string;
	schemaName: string;
	/** Absolute path, when the block has migrations. */
	migrationsPath?: string;
}

/**
 * Makes every Lambda function that assumes the app's execution role depend on a
 * block's migration resource. Applied as an aspect because the functions (the
 * default compute, job handlers) may be constructed after the block.
 */
class FunctionsWaitForMigration implements cdk.IAspect {
	constructor(
		private readonly migration: cdk.CfnResource,
		private readonly executionRoleArn: string,
		private readonly stack: cdk.Stack,
	) {}

	visit(node: IConstruct): void {
		if (!(node instanceof CfnFunction) || !node.role) return;
		// Compare resolved values: the same role gives the same Fn::GetAtt whether the
		// function got the role object or its ARN string.
		const same =
			JSON.stringify(this.stack.resolve(node.role)) === JSON.stringify(this.stack.resolve(this.executionRoleArn));
		if (same) node.addDependency(this.migration);
	}
}

export class ClusterInfra {
	/** Config entries the runtime reads (`BLOCKS_{id}_*` → token). */
	readonly configEntries: Record<string, string>;
	/** The PostgreSQL role the app connects as on a `dsql` cluster. */
	readonly dbRole: string;
	/** CloudFormation logical id of the cluster resource (a token until synth); recorded in the binding record. */
	readonly clusterLogicalId: string;

	private readonly clusterResource: cdk.CfnResource;
	private readonly clusterArn: string;
	private readonly migrationFn: lambda.NodejsFunction;
	private readonly isCompleteFn: lambda.NodejsFunction;
	private readonly provider: cr.Provider;
	private lastCustomResource: cdk.CfnResource | undefined;

	constructor(props: ClusterInfraProps) {
		this.dbRole = sanitizeDbRoleName(props.fullId);
		const stack = cdk.Stack.of(props.owner);
		const envName = toEnvName(props.fullId);
		const key = (suffix: string) => `${ENV_VAR_PREFIX}_${envName}_${suffix}`;

		const removalPolicy = props.options.removalPolicy
			? REMOVAL_POLICY_MAP[props.options.removalPolicy]
			: props.defaults.removalPolicy;

		const cluster = new cdk.CfnResource(props.owner, 'DsqlCluster', {
			type: 'AWS::DSQL::Cluster',
			properties: { DeletionProtectionEnabled: props.defaults.deletionProtection },
		});
		// A DSQL cluster has no snapshot; the stack-wide SNAPSHOT default retains it.
		cluster.applyRemovalPolicy(
			removalPolicy === cdk.RemovalPolicy.SNAPSHOT ? cdk.RemovalPolicy.RETAIN : removalPolicy,
		);
		this.clusterResource = cluster;
		this.clusterLogicalId = cluster.logicalId;
		const endpoint = cluster.getAtt('Endpoint').toString();
		this.clusterArn = `arn:aws:dsql:${stack.region}:${stack.account}:cluster/${cluster.ref}`;
		this.configEntries = { [key('ENDPOINT')]: endpoint, [key('REGION')]: stack.region };
		new cdk.CfnOutput(props.owner, 'DsqlEndpoint', { value: endpoint });

		const lambdaEnv: Record<string, string> = {
			DSQL_ENDPOINT: endpoint,
			DSQL_REGION: stack.region,
		};

		// The code is bundled now, before any block attaches, so migrations travel
		// as per-block S3 assets instead (see attach()).
		const here = dirname(fileURLToPath(import.meta.url));
		const logGroup = new LogGroup(props.owner, 'MigrationLogs', {
			retention: props.defaults.logRetention,
			removalPolicy: cdk.RemovalPolicy.DESTROY,
		});
		const migrationFunction = (id: string, handler: 'handler' | 'isComplete') =>
			new lambda.NodejsFunction(props.owner, id, {
				// Points at the compiled migration-lambda.js in dist/ (src/ is not published).
				entry: join(here, '..', 'migration-lambda.js'),
				handler,
				runtime: DEFAULT_NODE_RUNTIME,
				timeout: cdk.Duration.minutes(MIGRATION_LAMBDA_TIMEOUT_MINUTES),
				logGroup,
				environment: lambdaEnv,
				bundling: blocksNodejsBundling(),
			});
		this.migrationFn = migrationFunction('MigrationFn', 'handler');
		this.isCompleteFn = migrationFunction('MigrationIsCompleteFn', 'isComplete');
		for (const fn of [this.migrationFn, this.isCompleteFn]) {
			fn.addToRolePolicy(
				new iam.PolicyStatement({ actions: ['dsql:DbConnectAdmin'], resources: [this.clusterArn] }),
			);
		}
		// Index builds and constraint validations are DSQL jobs; isComplete polls
		// them until the provider's total timeout, not one invocation's.
		this.provider = new cr.Provider(props.owner, 'MigrationProvider', {
			onEventHandler: this.migrationFn,
			isCompleteHandler: this.isCompleteFn,
			queryInterval: cdk.Duration.seconds(MIGRATION_POLL_INTERVAL_SECONDS),
			totalTimeout: cdk.Duration.minutes(MIGRATION_TOTAL_TIMEOUT_MINUTES),
		});
	}

	/** Grant the app's execution role what it needs to query the cluster. */
	grantRuntime(grantee: iam.IGrantable): void {
		grantee.grantPrincipal.addToPrincipalPolicy(
			new iam.PolicyStatement({ actions: ['dsql:DbConnect'], resources: [this.clusterArn] }),
		);
	}

	/**
	 * Attach a `Database` block: publish its migrations as an asset and add the
	 * CustomResource that creates its schema, applies its migrations, and
	 * provisions the app role's grants, at deploy time. Every function that
	 * assumes `appRole` then waits for that resource.
	 */
	attach(block: AttachedBlock, appRole: iam.IRole): void {
		const migrationsHash = block.migrationsPath ? hashMigrationsDir(block.migrationsPath) : 'no-migrations';
		const asset = block.migrationsPath ? this.migrationsAsset(block.scope, block.migrationsPath) : undefined;
		if (asset) {
			asset.grantRead(this.migrationFn);
			asset.grantRead(this.isCompleteFn);
		}
		const resource = new cdk.CustomResource(block.scope, 'Migrations', {
			serviceToken: this.provider.serviceToken,
			properties: {
				migrationsHash,
				...(asset ? { migrationsBucket: asset.s3BucketName, migrationsKey: asset.s3ObjectKey } : {}),
				schemaName: block.schemaName,
				blockFullId: block.fullId,
				dbRole: this.dbRole,
				// A property (not just env) so CloudFormation re-runs the resource when
				// the app role is replaced and the DSQL `AWS IAM GRANT` must be re-issued.
				appRoleArn: appRole.roleArn,
			},
		});
		const cfn = resource.node.defaultChild as cdk.CfnResource;
		cfn.addDependency(this.clusterResource);
		if (this.lastCustomResource) cfn.addDependency(this.lastCustomResource);
		this.lastCustomResource = cfn;
		const stack = cdk.Stack.of(block.scope);
		cdk.Aspects.of(stack).add(new FunctionsWaitForMigration(cfn, appRole.roleArn, stack));
	}

	/** A block's migrations as one `{ fileName: sql }` JSON asset (uploaded as-is, no unzip). */
	private migrationsAsset(scope: Construct, migrationsPath: string): Asset {
		const files: Record<string, string> = {};
		for (const file of readdirSync(migrationsPath)
			.filter((f) => f.endsWith('.sql'))
			.sort()) {
			files[file] = readFileSync(join(migrationsPath, file), 'utf-8');
		}
		const dir = mkdtempSync(join(tmpdir(), 'bb-database-migrations-'));
		const path = join(dir, 'migrations.json');
		writeFileSync(path, JSON.stringify(files));
		return new Asset(scope, 'MigrationFiles', { path });
	}
}
