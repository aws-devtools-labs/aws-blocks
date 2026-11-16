// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type BuildingBlockScope, blocksNodejsBundling, DEFAULT_NODE_RUNTIME } from '@aws-blocks/core/cdk';
import { deployTimeLambdaEntry, scopeProviderWaiterTrust } from '@aws-blocks/core/cdk/internal';
import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import { CfnFunction } from 'aws-cdk-lib/aws-lambda';
import * as lambda from 'aws-cdk-lib/aws-lambda-nodejs';
import { LogGroup } from 'aws-cdk-lib/aws-logs';
import { Asset } from 'aws-cdk-lib/aws-s3-assets';
import * as cr from 'aws-cdk-lib/custom-resources';
import type { Construct, IConstruct } from 'constructs';
import {
	AURORA_BACKUP_DAYS_DEFAULT,
	AURORA_MASTER_USER,
	auroraClusterIdentifier,
	CLUSTER_ENV,
	clusterConfigKey,
	MIGRATION_LAMBDA_TIMEOUT_MINUTES,
	MIGRATION_POLL_INTERVAL_SECONDS,
	MIGRATION_SERVICE_TIMEOUT_SECONDS,
	MIGRATION_TOTAL_TIMEOUT_MINUTES,
	sanitizeDbRoleName,
} from '../constants.js';
import type { ResolvedAuroraClusterOptions, ResolvedClusterOptions } from '../runtime/construction.js';

const REMOVAL_POLICY_MAP = {
	destroy: cdk.RemovalPolicy.DESTROY,
	retain: cdk.RemovalPolicy.RETAIN,
	snapshot: cdk.RemovalPolicy.SNAPSHOT,
} as const;

function hashMigrations(files: Record<string, string>): string {
	const hash = createHash('sha256');
	for (const file of Object.keys(files).sort()) {
		hash.update(file);
		hash.update(files[file]);
	}
	return hash.digest('hex').slice(0, 16);
}

interface ClusterInfraProps {
	owner: BuildingBlockScope;
	fullId: string;
	options: ResolvedClusterOptions;
}

interface AttachedBlock {
	scope: Construct;
	fullId: string;
	schemaName: string;
	migrations?: Record<string, string>;
}

// Every function on the app's execution role waits for the cluster's migrations, so new code never runs
// against the old schema. An aspect, because those functions (default compute, job handlers) may be
// constructed later; the per-block resources are chained, so the last one implies all of them.
class FunctionsWaitForMigrations implements cdk.IAspect {
	private readonly roleArn: string;

	constructor(
		private readonly stack: cdk.Stack,
		executionRole: iam.IRole,
		private readonly lastMigration: () => cdk.CfnResource | undefined,
	) {
		this.roleArn = JSON.stringify(stack.resolve(executionRole.roleArn));
	}

	visit(node: IConstruct): void {
		if (!(node instanceof CfnFunction) || !node.role) return;
		const migration = this.lastMigration();
		if (!migration) return;
		// Compare resolved values: the same role gives the same Fn::GetAtt whether the
		// function got the role object or its ARN string.
		if (JSON.stringify(this.stack.resolve(node.role)) === this.roleArn) node.addResourceDependency(migration);
	}
}

/** The cluster resource of one kind, and what the rest of the infrastructure needs to know about it. */
interface ClusterResource {
	resource: cdk.CfnResource;
	endpoint: string;
	/** The CloudFormation output that names the endpoint. */
	outputId: string;
	/** Whether the service takes a final snapshot; without one, a SNAPSHOT policy retains the cluster. */
	supportsSnapshot: boolean;
	/** Lets the app's execution role connect as its database role. */
	appConnect: iam.PolicyStatement;
	/** Lets the migration Lambdas connect as the cluster admin. */
	adminConnect: iam.PolicyStatement;
}

// DSQL maps the app's database role to the execution role itself, with `AWS IAM GRANT` (migration-lambda.ts),
// so one `dsql:DbConnect` grant on the cluster covers it.
function dsqlCluster(owner: BuildingBlockScope, stack: cdk.Stack): ClusterResource {
	const resource = new cdk.CfnResource(owner, 'DsqlCluster', {
		type: 'AWS::DSQL::Cluster',
		properties: { DeletionProtectionEnabled: owner.defaults.deletionProtection },
	});
	const clusterArn = stack.formatArn({ service: 'dsql', resource: 'cluster', resourceName: resource.ref });
	return {
		resource,
		endpoint: resource.getAtt('Endpoint').toString(),
		outputId: 'DsqlEndpoint',
		supportsSnapshot: false,
		appConnect: new iam.PolicyStatement({ actions: ['dsql:DbConnect'], resources: [clusterArn] }),
		adminConnect: new iam.PolicyStatement({ actions: ['dsql:DbConnectAdmin'], resources: [clusterArn] }),
	};
}

// Aurora's backup retention is its point-in-time recovery window: the stack default (on in production, off in a
// sandbox) or the cluster's own setting, as a day count the service keeps between 1 and 35.
function backupRetentionDays(owner: BuildingBlockScope, options: ResolvedAuroraClusterOptions): number {
	const setting = options.pointInTimeRecovery ?? owner.defaults.pointInTimeRecovery;
	if (typeof setting === 'object' && setting !== null) return setting.retentionDays;
	return setting ? AURORA_BACKUP_DAYS_DEFAULT : 1;
}

/**
 * Aurora PostgreSQL Serverless v2 with the express configuration: one `AWS::RDS::DBCluster` that the service
 * creates in seconds together with its writer instance (`<identifier>-instance-1`), outside any VPC, reached
 * through an internet access gateway. The template declares no `AWS::RDS::DBInstance`: the instance handler
 * rejects the one the cluster handler already created (AlreadyExists), and deleting the cluster deletes it.
 * IAM authentication is the only authentication: the master user has no password, and the express
 * configuration does not support storage encryption. `rds-db:connect` on `dbuser:<resource id>/<role>` is
 * what lets a principal get a token for that role.
 */
function auroraCluster(
	owner: BuildingBlockScope,
	stack: cdk.Stack,
	fullId: string,
	dbRole: string,
	options: ResolvedAuroraClusterOptions,
): ClusterResource {
	const resource = new cdk.CfnResource(owner, 'AuroraCluster', {
		type: 'AWS::RDS::DBCluster',
		properties: {
			DBClusterIdentifier: auroraClusterIdentifier(fullId),
			Engine: 'aurora-postgresql',
			WithExpressConfiguration: true,
			// No EnableIAMDatabaseAuthentication or MasterUserAuthenticationType: express sets both, and naming them
			// makes the CloudFormation handler modify the cluster after the create, which takes minutes.
			MasterUsername: AURORA_MASTER_USER,
			ServerlessV2ScalingConfiguration: { MinCapacity: options.minCapacity, MaxCapacity: options.maxCapacity },
			DeletionProtection: owner.defaults.deletionProtection,
			BackupRetentionPeriod: backupRetentionDays(owner, options),
			CopyTagsToSnapshot: true,
		},
	});
	// `arn:aws:rds-db:<region>:<account>:dbuser:<resource id>/<user>`: a colon before the resource id, a slash
	// before the user. With the default slash the policy never matches and every token is refused.
	const connect = (user: string): iam.PolicyStatement =>
		new iam.PolicyStatement({
			actions: ['rds-db:connect'],
			resources: [
				stack.formatArn({
					service: 'rds-db',
					resource: 'dbuser',
					resourceName: `${resource.getAtt('DBClusterResourceId').toString()}/${user}`,
					arnFormat: cdk.ArnFormat.COLON_RESOURCE_NAME,
				}),
			],
		});
	return {
		resource,
		endpoint: resource.getAtt('Endpoint.Address').toString(),
		outputId: 'AuroraEndpoint',
		supportsSnapshot: true,
		appConnect: connect(dbRole),
		adminConnect: connect(AURORA_MASTER_USER),
	};
}

export class ClusterInfra {
	readonly configEntries: Record<string, string>;
	readonly dbRole: string;

	private readonly appRole: iam.IRole;
	private readonly cluster: ClusterResource;
	private readonly migrationFn: lambda.NodejsFunction;
	private readonly isCompleteFn: lambda.NodejsFunction;
	private readonly provider: cr.Provider;
	private lastCustomResource: cdk.CfnResource | undefined;

	constructor(props: ClusterInfraProps) {
		this.dbRole = sanitizeDbRoleName(props.fullId);
		this.appRole = props.owner.executionRole;
		const stack = cdk.Stack.of(props.owner);
		const defaults = props.owner.defaults;
		const { options } = props;

		const removalPolicy = options.removalPolicy
			? REMOVAL_POLICY_MAP[options.removalPolicy]
			: defaults.removalPolicy;
		const cluster =
			options.type === 'dsql'
				? dsqlCluster(props.owner, stack)
				: auroraCluster(props.owner, stack, props.fullId, this.dbRole, options);
		cluster.resource.applyRemovalPolicy(
			removalPolicy === cdk.RemovalPolicy.SNAPSHOT && !cluster.supportsSnapshot
				? cdk.RemovalPolicy.RETAIN
				: removalPolicy,
		);
		this.cluster = cluster;
		this.configEntries = {
			[clusterConfigKey(props.fullId, 'ENDPOINT')]: cluster.endpoint,
			[clusterConfigKey(props.fullId, 'REGION')]: stack.region,
		};
		new cdk.CfnOutput(props.owner, cluster.outputId, { value: cluster.endpoint });

		// The code is bundled now, before any block attaches, so migrations travel
		// as per-block S3 assets instead (see attach()).
		const logGroup = new LogGroup(props.owner, 'MigrationLogs', {
			retention: defaults.logRetention,
			removalPolicy: cdk.RemovalPolicy.DESTROY,
		});
		const migrationFunction = (id: string, handler: 'handler' | 'isComplete') =>
			new lambda.NodejsFunction(props.owner, id, {
				entry: deployTimeLambdaEntry({ moduleUrl: import.meta.url, source: './migration-lambda' }),
				handler,
				runtime: DEFAULT_NODE_RUNTIME,
				timeout: cdk.Duration.minutes(MIGRATION_LAMBDA_TIMEOUT_MINUTES),
				logGroup,
				environment: {
					[CLUSTER_ENV.kind]: options.type,
					[CLUSTER_ENV.endpoint]: cluster.endpoint,
					[CLUSTER_ENV.region]: stack.region,
				},
				bundling: blocksNodejsBundling(),
			});
		this.migrationFn = migrationFunction('MigrationFn', 'handler');
		this.isCompleteFn = migrationFunction('MigrationIsCompleteFn', 'isComplete');
		for (const fn of [this.migrationFn, this.isCompleteFn]) fn.addToRolePolicy(cluster.adminConnect);
		this.appRole.grantPrincipal.addToPrincipalPolicy(cluster.appConnect);
		// Index builds and constraint validations are DSQL jobs; isComplete polls them until the provider's
		// total timeout, not one invocation's. That timeout stays under the CustomResource's serviceTimeout.
		this.provider = new cr.Provider(props.owner, 'MigrationProvider', {
			onEventHandler: this.migrationFn,
			isCompleteHandler: this.isCompleteFn,
			queryInterval: cdk.Duration.seconds(MIGRATION_POLL_INTERVAL_SECONDS),
			totalTimeout: cdk.Duration.minutes(MIGRATION_TOTAL_TIMEOUT_MINUTES),
		});
		scopeProviderWaiterTrust(this.provider);
		cdk.Aspects.of(stack).add(new FunctionsWaitForMigrations(stack, this.appRole, () => this.lastCustomResource));
	}

	attach(block: AttachedBlock): void {
		const asset = block.migrations ? this.migrationsAsset(block.scope, block.migrations) : undefined;
		if (asset) {
			asset.grantRead(this.migrationFn);
			asset.grantRead(this.isCompleteFn);
		}
		const resource = new cdk.CustomResource(block.scope, 'Migrations', {
			serviceToken: this.provider.serviceToken,
			serviceTimeout: cdk.Duration.seconds(MIGRATION_SERVICE_TIMEOUT_SECONDS),
			properties: {
				migrationsHash: block.migrations ? hashMigrations(block.migrations) : 'no-migrations',
				...(asset ? { migrationsBucket: asset.s3BucketName, migrationsKey: asset.s3ObjectKey } : {}),
				schemaName: block.schemaName,
				blockFullId: block.fullId,
				dbRole: this.dbRole,
				// Properties (not just env) so CloudFormation re-runs the resource when the app role is replaced and
				// the IAM mapping must be re-issued, and when the cluster itself is replaced and is empty again.
				appRoleArn: this.appRole.roleArn,
				clusterEndpoint: this.cluster.endpoint,
			},
		});
		const cfn = resource.node.defaultChild as cdk.CfnResource;
		// aws-cdk-lib renders the Duration as a string, and CloudFormation's validator warns about a non-numeric value.
		cfn.addPropertyOverride('ServiceTimeout', MIGRATION_SERVICE_TIMEOUT_SECONDS);
		cfn.addResourceDependency(this.cluster.resource);
		// Chained so two blocks' migrations on one cluster never run concurrently.
		if (this.lastCustomResource) cfn.addResourceDependency(this.lastCustomResource);
		this.lastCustomResource = cfn;
	}

	private migrationsAsset(scope: Construct, files: Record<string, string>): Asset {
		const dir = mkdtempSync(join(tmpdir(), 'bb-database-migrations-'));
		const path = join(dir, 'migrations.json');
		writeFileSync(path, JSON.stringify(files));
		return new Asset(scope, 'MigrationFiles', { path });
	}
}
