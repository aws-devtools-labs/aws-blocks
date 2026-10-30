// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type BuildingBlockScope, blocksNodejsBundling, DEFAULT_NODE_RUNTIME } from '@aws-blocks/core/cdk';
import { deployTimeLambdaEntry } from '@aws-blocks/core/cdk/internal';
import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import { CfnFunction } from 'aws-cdk-lib/aws-lambda';
import * as lambda from 'aws-cdk-lib/aws-lambda-nodejs';
import { LogGroup } from 'aws-cdk-lib/aws-logs';
import { Asset } from 'aws-cdk-lib/aws-s3-assets';
import * as cr from 'aws-cdk-lib/custom-resources';
import type { Construct, IConstruct } from 'constructs';
import {
	clusterConfigKey,
	MIGRATION_LAMBDA_TIMEOUT_MINUTES,
	MIGRATION_POLL_INTERVAL_SECONDS,
	MIGRATION_TOTAL_TIMEOUT_MINUTES,
	sanitizeDbRoleName,
} from '../constants.js';
import type { DatabaseClusterOptions } from '../types.js';

const REMOVAL_POLICY_MAP = {
	destroy: cdk.RemovalPolicy.DESTROY,
	retain: cdk.RemovalPolicy.RETAIN,
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
	options: DatabaseClusterOptions;
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
		if (JSON.stringify(this.stack.resolve(node.role)) === this.roleArn) node.addDependency(migration);
	}
}

export class ClusterInfra {
	readonly configEntries: Record<string, string>;
	readonly dbRole: string;
	/** Logical id of the cluster resource, a token until synth; the binding record resolves it. */
	readonly clusterLogicalId: string;

	private readonly appRole: iam.IRole;
	private readonly clusterResource: cdk.CfnResource;
	private readonly migrationFn: lambda.NodejsFunction;
	private readonly isCompleteFn: lambda.NodejsFunction;
	private readonly provider: cr.Provider;
	private lastCustomResource: cdk.CfnResource | undefined;

	constructor(props: ClusterInfraProps) {
		this.dbRole = sanitizeDbRoleName(props.fullId);
		this.appRole = props.owner.executionRole;
		const stack = cdk.Stack.of(props.owner);
		const defaults = props.owner.defaults;

		const removalPolicy = props.options.removalPolicy
			? REMOVAL_POLICY_MAP[props.options.removalPolicy]
			: defaults.removalPolicy;

		const cluster = new cdk.CfnResource(props.owner, 'DsqlCluster', {
			type: 'AWS::DSQL::Cluster',
			properties: { DeletionProtectionEnabled: defaults.deletionProtection },
		});
		// A DSQL cluster has no snapshot; the stack-wide SNAPSHOT default retains it.
		cluster.applyRemovalPolicy(
			removalPolicy === cdk.RemovalPolicy.SNAPSHOT ? cdk.RemovalPolicy.RETAIN : removalPolicy,
		);
		this.clusterResource = cluster;
		this.clusterLogicalId = cluster.logicalId;
		const endpoint = cluster.getAtt('Endpoint').toString();
		const clusterArn = `arn:aws:dsql:${stack.region}:${stack.account}:cluster/${cluster.ref}`;
		this.configEntries = {
			[clusterConfigKey(props.fullId, 'ENDPOINT')]: endpoint,
			[clusterConfigKey(props.fullId, 'REGION')]: stack.region,
		};
		new cdk.CfnOutput(props.owner, 'DsqlEndpoint', { value: endpoint });

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
				environment: { DSQL_ENDPOINT: endpoint, DSQL_REGION: stack.region },
				bundling: blocksNodejsBundling(),
			});
		this.migrationFn = migrationFunction('MigrationFn', 'handler');
		this.isCompleteFn = migrationFunction('MigrationIsCompleteFn', 'isComplete');
		for (const fn of [this.migrationFn, this.isCompleteFn]) {
			fn.addToRolePolicy(new iam.PolicyStatement({ actions: ['dsql:DbConnectAdmin'], resources: [clusterArn] }));
		}
		this.appRole.grantPrincipal.addToPrincipalPolicy(
			new iam.PolicyStatement({ actions: ['dsql:DbConnect'], resources: [clusterArn] }),
		);
		// Index builds and constraint validations are DSQL jobs; isComplete polls
		// them until the provider's total timeout, not one invocation's.
		this.provider = new cr.Provider(props.owner, 'MigrationProvider', {
			onEventHandler: this.migrationFn,
			isCompleteHandler: this.isCompleteFn,
			queryInterval: cdk.Duration.seconds(MIGRATION_POLL_INTERVAL_SECONDS),
			totalTimeout: cdk.Duration.minutes(MIGRATION_TOTAL_TIMEOUT_MINUTES),
		});
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
			properties: {
				migrationsHash: block.migrations ? hashMigrations(block.migrations) : 'no-migrations',
				...(asset ? { migrationsBucket: asset.s3BucketName, migrationsKey: asset.s3ObjectKey } : {}),
				schemaName: block.schemaName,
				blockFullId: block.fullId,
				dbRole: this.dbRole,
				// A property (not just env) so CloudFormation re-runs the resource when
				// the app role is replaced and the DSQL `AWS IAM GRANT` must be re-issued.
				appRoleArn: this.appRole.roleArn,
			},
		});
		const cfn = resource.node.defaultChild as cdk.CfnResource;
		cfn.addDependency(this.clusterResource);
		// Chained so two blocks' migrations on one cluster never run concurrently.
		if (this.lastCustomResource) cfn.addDependency(this.lastCustomResource);
		this.lastCustomResource = cfn;
	}

	private migrationsAsset(scope: Construct, files: Record<string, string>): Asset {
		const dir = mkdtempSync(join(tmpdir(), 'bb-database-migrations-'));
		const path = join(dir, 'migrations.json');
		writeFileSync(path, JSON.stringify(files));
		return new Asset(scope, 'MigrationFiles', { path });
	}
}
